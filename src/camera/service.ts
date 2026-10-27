// Turns MX Brio state into what the app and the CLI show, and applies what you change, the way
// G Hub's webcam pages do. Shared by the Electron main process and `librehub camera`.
//
// Each change is written to the camera at once and saved on this computer (store.ts). The camera
// forgets its framing (zoom, pan, tilt, field of view) when it restarts, and could lose the rest
// with a firmware update or another program, so `restore()` writes back whatever differs; the app
// runs it whenever the camera connects, as G Hub does.

import type { CameraInfo, MxBrio } from './mxbrio.js';
import { CURATED_PRESETS, DEFAULTS, GROUP_KEYS, matchesPreset, SETTINGS, writePlan, type CameraSettings, type Group, type Preset, type SettingKey } from './settings.js';
import { cleanSettings, type CameraStore } from './store.js';

export type PresetGroup = Preset['group'];

export interface PresetView {
  group: PresetGroup;
  name: string;
  /** One of G Hub's own; these can't be deleted. */
  curated: boolean;
  /** The camera's settings for this group are exactly this preset. */
  matches: boolean;
}

export interface CameraSnapshot {
  device: CameraInfo;
  settings: CameraSettings;
  microphone: boolean;
  presets: PresetView[];
  /** Settings Libre Hub puts back when the camera connects (the ones you changed). */
  saved: Partial<CameraSettings>;
}

export type CameraAction =
  | { type: 'set'; settings: Partial<CameraSettings> }
  /** G Hub's "Reset to default", for one tab or everything. */
  | { type: 'reset'; group: Group | 'all' }
  | { type: 'preset'; group: PresetGroup; name: string }
  | { type: 'savePreset'; group: PresetGroup; name: string }
  | { type: 'deletePreset'; group: PresetGroup; name: string }
  | { type: 'microphone'; enabled: boolean }
  /** Stop putting settings back on connect (forget what was saved for this camera). */
  | { type: 'forget' };

const PRESET_GROUPS: PresetGroup[] = ['crop', 'exposure', 'image', 'focus'];

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
      return { device, settings, microphone, presets: presetViews(settings, config.presets), saved: config.cameras[device.serial] ?? {} };
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
          const preset = (await this.allPresets()).find((p) => p.group === action.group && p.name === action.name);
          if (!preset) throw new Error(`no ${action.group} preset called "${action.name}"`);
          return this.write(preset.settings);
        }
        case 'savePreset': {
          const name = action.name.trim();
          if (!name) throw new Error('a preset needs a name');
          if (!PRESET_GROUPS.includes(action.group)) throw new Error(`unknown preset group "${action.group}"`);
          if (CURATED_PRESETS.some((p) => p.group === action.group && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`"${name}" is one of G Hub’s presets; pick another name`);
          const settings = await this.camera.readSettings();
          const values = Object.fromEntries(GROUP_KEYS[action.group].map((k) => [k, settings[k]])) as Partial<CameraSettings>;
          await this.store.update((c) => {
            c.presets = c.presets.filter((p) => !(p.group === action.group && p.name === name));
            c.presets.push({ group: action.group, name, settings: values });
          });
          return;
        }
        case 'deletePreset':
          await this.store.update((c) => {
            const before = c.presets.length;
            c.presets = c.presets.filter((p) => !(p.group === action.group && p.name === action.name));
            if (c.presets.length === before) throw new Error(`no saved ${action.group} preset called "${action.name}"`);
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

  private async allPresets(): Promise<Preset[]> {
    return [...CURATED_PRESETS, ...(await this.store.read()).presets];
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

function presetViews(settings: CameraSettings, custom: Preset[]): PresetView[] {
  return [
    ...CURATED_PRESETS.map((p) => ({ group: p.group, name: p.name, curated: true, matches: matchesPreset(settings, p) })),
    ...custom.map((p) => ({ group: p.group, name: p.name, curated: false, matches: matchesPreset(settings, p) })),
  ];
}
