// Turns MX Brio state into what the app and the CLI show, and applies what you change, the way
// G Hub's webcam pages do. Shared by the Electron main process and `librehub camera`.
//
// Each change is written to the camera at once and saved on this computer (store.ts). The camera
// forgets its framing (zoom, pan, tilt, field of view) when it restarts, and could lose the rest
// with a firmware update or another program, so `restore()` writes back whatever differs; the app
// runs it whenever the camera connects, as G Hub does.

import type { CameraInfo, MxBrio } from './mxbrio.js';
import { CURATED_PRESETS, DEFAULTS, GROUP_KEYS, matchesPreset, PRESET_KEYS, SETTINGS, writePlan, type CameraPreset, type CameraSettings, type Group, type Preset, type SettingKey } from './settings.js';
import { cleanSettings, type CameraStore } from './store.js';

export type PresetGroup = Preset['group'];

/** One of G Hub's presets, for one tab. */
export interface PresetView {
  group: PresetGroup;
  name: string;
  /** The camera's settings for this group are exactly this preset. */
  matches: boolean;
}

/** One of your presets: the camera's whole look. */
export interface CustomPresetView {
  name: string;
  /** The camera's settings are exactly this preset. */
  matches: boolean;
}

export interface CameraSnapshot {
  device: CameraInfo;
  settings: CameraSettings;
  microphone: boolean;
  /** G Hub's presets, per tab. */
  presets: PresetView[];
  /** Yours, in the order you saved them. */
  custom: CustomPresetView[];
  /** Settings Libre Hub puts back when the camera connects (the ones you changed). */
  saved: Partial<CameraSettings>;
}

export type CameraAction =
  | { type: 'set'; settings: Partial<CameraSettings> }
  /** G Hub's "Reset to default", for one tab or everything. */
  | { type: 'reset'; group: Group | 'all' }
  /** One of G Hub's presets: sets that tab. */
  | { type: 'preset'; group: PresetGroup; name: string }
  /** One of yours: sets framing, exposure, colour and focus. */
  | { type: 'customPreset'; name: string }
  /** Keep the camera's current look as a preset of yours (replacing one of the same name). */
  | { type: 'savePreset'; name: string }
  | { type: 'deletePreset'; name: string }
  | { type: 'microphone'; enabled: boolean }
  /** Stop putting settings back on connect (forget what was saved for this camera). */
  | { type: 'forget' };

/** Settings in `target` that differ from `current` and would make a difference (see writePlan). */
export function drift(target: Partial<CameraSettings>, current: CameraSettings): Partial<CameraSettings> {
  const next = { ...current, ...target };
  const out: Partial<Record<SettingKey, unknown>> = {};
  for (const [k, v] of Object.entries(target) as [SettingKey, unknown][]) {
    const auto = SETTINGS[k].auto;
    if (auto && next[auto] === true) continue;
    if (current[k] !== v) out[k] = v;
  }
  return out as Partial<CameraSettings>;
}

export class CameraService {
  /** Camera operations run one at a time (the app's writes and the restore on connect). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly camera: MxBrio,
    readonly store: CameraStore,
  ) {}

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  snapshot(): Promise<CameraSnapshot> {
    return this.exclusive(async () => {
      const device = await this.camera.info();
      const settings = await this.camera.readSettings();
      const microphone = await this.camera.microphone();
      const config = await this.store.read();
      return {
        device, settings, microphone,
        presets: CURATED_PRESETS.map((p) => ({ group: p.group, name: p.name, matches: matchesPreset(settings, p) })),
        custom: config.presets.map((p) => ({ name: p.name, matches: matchesPreset(settings, p) })),
        saved: config.cameras[device.serial] ?? {},
      };
    });
  }

  apply(action: CameraAction): Promise<void> {
    return this.exclusive(async () => {
      switch (action.type) {
        case 'set':
          return this.write(cleanOrThrow(action.settings));
        case 'reset': {
          const keys = action.group === 'all' ? (Object.keys(DEFAULTS) as SettingKey[]) : GROUP_KEYS[action.group];
          return this.write(Object.fromEntries(keys.map((k) => [k, DEFAULTS[k]])));
        }
        case 'preset': {
          const preset = CURATED_PRESETS.find((p) => p.group === action.group && p.name === action.name);
          if (!preset) throw new Error(`G Hub has no ${action.group} preset called "${action.name}"`);
          return this.write(preset.settings);
        }
        case 'customPreset':
          return this.write(findPreset((await this.store.read()).presets, action.name).settings);
        case 'savePreset': {
          const name = action.name?.trim() ?? '';
          if (!name) throw new Error('a preset needs a name');
          const settings = await this.camera.readSettings();
          const values = Object.fromEntries(PRESET_KEYS.map((k) => [k, settings[k]])) as Partial<CameraSettings>;
          await this.store.update((c) => {
            const i = c.presets.findIndex((p) => sameName(p.name, name));
            if (i >= 0) c.presets[i] = { name, settings: values };
            else c.presets.push({ name, settings: values });
          });
          return;
        }
        case 'deletePreset':
          await this.store.update((c) => {
            const preset = findPreset(c.presets, action.name);
            c.presets = c.presets.filter((p) => p !== preset);
          });
          return;
        case 'microphone':
          return this.camera.setMicrophone(action.enabled);
        case 'forget': {
          const { serial } = await this.camera.info();
          await this.store.update((c) => {
            delete c.cameras[serial];
          });
          return;
        }
        default:
          throw new Error(`unknown action ${(action as { type: string }).type}`);
      }
    });
  }

  /**
   * Put back the settings saved for this camera where the camera differs. Returns what had to be
   * written (nothing, normally, except the framing after the camera restarted).
   */
  restore(): Promise<Partial<CameraSettings>> {
    return this.exclusive(async () => {
      const { serial } = await this.camera.info();
      const saved = (await this.store.read()).cameras[serial];
      if (!saved || !Object.keys(saved).length) return {};
      const current = await this.camera.readSettings();
      const differs = drift(saved, current);
      for (const { key, raw } of writePlan(differs, current)) await this.camera.write(key, raw);
      return differs;
    });
  }

  /** Write what differs to the camera (switches first), then remember the settings for this camera. */
  private async write(settings: Partial<CameraSettings>): Promise<void> {
    const current = await this.camera.readSettings();
    for (const { key, raw } of writePlan(drift(settings, current), current)) {
      try {
        await this.camera.write(key, raw);
      } catch (err) {
        throw new Error(`${SETTINGS[key].label}: ${(err as Error).message}`);
      }
    }
    const { serial } = await this.camera.info();
    await this.store.update((c) => {
      c.cameras[serial] = { ...c.cameras[serial], ...settings };
    });
  }
}

function cleanOrThrow(settings: Partial<CameraSettings>): Partial<CameraSettings> {
  const keys = Object.keys(settings ?? {});
  if (!keys.length) throw new Error('nothing to set');
  const unknown = keys.filter((k) => !(k in SETTINGS));
  if (unknown.length) throw new Error(`unknown setting ${unknown.map((k) => `"${k}"`).join(', ')}`);
  const clean = cleanSettings(settings);
  // cleanSettings drops bad values silently; here, say which and why.
  for (const k of keys.filter((k) => !(k in clean))) writePlan({ [k]: settings[k as SettingKey] }, { ...DEFAULTS, autoExposure: false, autoFocus: false, autoWhiteBalance: false });
  return clean;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.trim().toLowerCase();

function findPreset(presets: CameraPreset[], name: string): CameraPreset {
  const preset = presets.find((p) => sameName(p.name, name ?? ''));
  if (!preset) throw new Error(`you have no preset called "${name}"`);
  return preset;
}
