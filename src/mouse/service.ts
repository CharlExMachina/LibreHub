// Turns G502 X PLUS state into what the UI/CLI shows and applies user actions, the way G Hub's
// on-board memory mode does. Shared by the Electron main process and the CLI.
//
// The mouse keeps five profiles in its own flash. Editing a profile here rewrites that profile's
// sector; the mouse uses the new settings at once if it is the active profile, and keeps them
// with no software running (which is what you want on Linux).

import { msToHz, hzToMs } from './codecs.js';
import type { G502X } from './g502x.js';
import { controlIndex, G502X_CONTROLS, type Binding, type LedEffect, type Profile } from './onboard.js';
import { DPI_PRESETS, formatEffect, isPrimaryZoneEffect } from './presets.js';
import { formatBinding } from './usages.js';

export interface ProfileView {
  slot: number;
  enabled: boolean;
  name: string | null;
  reportRateHz: number;
  dpiLevels: number[];
  defaultDpiIndex: number;
  shiftDpiIndex: number;
  buttons: { control: string; label: string; binding: string; gshift: string }[];
  lighting: { active: string; inactive: string };
  dimAfterSeconds: number | null;
  lightsOffAfterSeconds: number | null;
}

export interface MouseSnapshot {
  device: Awaited<ReturnType<G502X['getInfo']>>;
  battery: Awaited<ReturnType<G502X['getBattery']>>;
  /** 'onboard' = the mouse runs from its saved profiles; 'host' = software (G Hub) drives it. */
  mode: string;
  activeProfile: number;
  /** Live sensor state; in onboard mode this follows the active profile. */
  dpi: { current: number; level: number | null };
  reportRateHz: number;
  wheel: Awaited<ReturnType<G502X['getWheel']>>;
  startupEffect: boolean;
  profiles: ProfileView[];
  capabilities: { dpi: { min: number; max: number; step: number }; reportRatesHz: number[]; dpiPresets: string[] };
}

export type LightingTarget = 'active' | 'inactive';

export type MouseAction =
  | { type: 'mode'; mode: 'onboard' | 'host' }
  | { type: 'activeProfile'; profile: number }
  | { type: 'dpiLevel'; index: number }
  | { type: 'profileEnabled'; profile: number; enabled: boolean }
  | { type: 'restoreProfile'; profile: number }
  | { type: 'reportRate'; profile: number; hz: number }
  | { type: 'dpi'; profile: number; levels: number[]; defaultIndex: number; shiftIndex: number }
  | { type: 'dpiPreset'; profile: number; preset: string }
  | { type: 'name'; profile: number; name: string | null }
  | { type: 'button'; profile: number; control: string; layer: 'base' | 'gshift'; binding: Binding }
  | { type: 'lighting'; profile: number; target: LightingTarget; effect: LedEffect | 'dim'; dimPercent?: number }
  | { type: 'inactivity'; profile: number; dimAfterSeconds?: number | null; lightsOffAfterSeconds?: number | null }
  | { type: 'startupEffect'; enabled: boolean };

const OFF: LedEffect = { type: 'off' };

/** Lower an effect's brightness the way G Hub's "Dim Active Effect" does. */
export function dimmed(e: LedEffect, percent: number): LedEffect {
  switch (e.type) {
    case 'cycle':
    case 'wave':
    case 'breathing':
    case 'signature':
      return { ...e, brightness: Math.max(1, Math.round((e.brightness * percent) / 100)) };
    case 'fixed':
      return { ...e, color: e.color.map((c) => Math.round((c * percent) / 100)) as [number, number, number] };
    default:
      return e;
  }
}

/** Put an effect in the LED slot G Hub would use and switch the other slot off. */
export function placeEffect(effect: LedEffect): { all: LedEffect; primary: LedEffect } {
  if (effect.type === 'off') return { all: OFF, primary: OFF };
  return isPrimaryZoneEffect(effect) ? { all: OFF, primary: effect } : { all: effect, primary: OFF };
}

const activeOf = (l: { all: LedEffect; primary: LedEffect }) => (l.all.type !== 'off' ? l.all : l.primary);

export class MouseService {
  constructor(readonly mouse: G502X) {}

  private view(slot: number, p: Profile & { enabled: boolean }): ProfileView {
    return {
      slot,
      enabled: p.enabled,
      name: p.name,
      reportRateHz: msToHz(p.reportRateMs),
      dpiLevels: p.dpiLevels,
      defaultDpiIndex: p.defaultDpiIndex,
      shiftDpiIndex: p.shiftDpiIndex,
      buttons: G502X_CONTROLS.map((c, k) => ({
        control: c.id,
        label: c.label,
        binding: formatBinding(p.buttons[k] ?? { type: 'unassigned' }),
        gshift: formatBinding(p.gshift[k] ?? { type: 'unassigned' }),
      })),
      lighting: { active: formatEffect(activeOf(p.lighting.active)), inactive: formatEffect(activeOf(p.lighting.inactive)) },
      dimAfterSeconds: p.dimAfterSeconds,
      lightsOffAfterSeconds: p.lightsOffAfterSeconds,
    };
  }

  async snapshot(): Promise<MouseSnapshot> {
    const m = this.mouse;
    const mode = await m.getMode();
    const activeProfile = await m.getActiveProfile();
    const profiles = await m.readProfiles();
    const dpi = await m.getDpi();
    const caps = await m.getDpiCapabilities();
    const range = caps.ranges[0] ?? { min: Math.min(...caps.values), max: Math.max(...caps.values), step: 1 };
    let level: number | null = null;
    if (mode === 'onboard') level = await m.getDpiIndex();
    return {
      device: await m.getInfo(),
      battery: await m.getBattery(),
      mode,
      activeProfile,
      dpi: { current: dpi.dpi, level },
      reportRateHz: msToHz(await m.getReportRate()),
      wheel: await m.getWheel(),
      startupEffect: await m.getStartupEffect(),
      profiles: profiles.map((p, k) => this.view(k + 1, p)),
      capabilities: { dpi: range, reportRatesHz: (await m.getReportRates()).map(msToHz), dpiPresets: DPI_PRESETS.map((p) => p.name) },
    };
  }

  /** Read a profile, change it, write it back. */
  async editProfile(slot: number, change: (p: Profile) => Profile | void): Promise<void> {
    const p = await this.mouse.readProfile(slot);
    const next = change(p) ?? p;
    await this.mouse.writeProfile(slot, next);
  }

  async apply(a: MouseAction): Promise<void> {
    const m = this.mouse;
    switch (a.type) {
      case 'mode':
        return m.setMode(a.mode);
      case 'activeProfile':
        return m.setActiveProfile(a.profile);
      case 'dpiLevel':
        return m.setDpiIndex(a.index);
      case 'profileEnabled':
        return m.setProfileEnabled(a.profile, a.enabled);
      case 'restoreProfile':
        return m.restoreFactoryProfile(a.profile);
      case 'startupEffect':
        return m.setStartupEffect(a.enabled);
      case 'reportRate':
        return this.editProfile(a.profile, (p) => {
          p.reportRateMs = hzToMs(a.hz);
        });
      case 'dpi':
        return this.editProfile(a.profile, (p) => {
          p.dpiLevels = a.levels;
          p.defaultDpiIndex = a.defaultIndex;
          p.shiftDpiIndex = a.shiftIndex;
        });
      case 'dpiPreset': {
        const preset = DPI_PRESETS.find((x) => x.name === a.preset);
        if (!preset) throw new RangeError(`unknown DPI preset "${a.preset}" (${DPI_PRESETS.map((x) => x.name).join(', ')})`);
        return this.editProfile(a.profile, (p) => {
          p.dpiLevels = [...preset.levels];
          p.defaultDpiIndex = preset.defaultIndex;
          p.shiftDpiIndex = preset.shiftIndex;
        });
      }
      case 'name':
        return this.editProfile(a.profile, (p) => {
          p.name = a.name;
        });
      case 'button': {
        const k = controlIndex(a.control);
        return this.editProfile(a.profile, (p) => {
          const layer = a.layer === 'gshift' ? p.gshift : p.buttons;
          while (layer.length <= k) layer.push({ type: 'unassigned' });
          layer[k] = a.binding;
        });
      }
      case 'lighting':
        return this.editProfile(a.profile, (p) => {
          if (a.effect === 'dim') {
            p.lighting.inactive = placeEffect(dimmed(activeOf(p.lighting.active), a.dimPercent ?? 50));
          } else if (a.target === 'active') {
            p.lighting.active = placeEffect(a.effect);
          } else {
            p.lighting.inactive = placeEffect(a.effect);
          }
        });
      case 'inactivity':
        return this.editProfile(a.profile, (p) => {
          if (a.dimAfterSeconds !== undefined) p.dimAfterSeconds = a.dimAfterSeconds;
          if (a.lightsOffAfterSeconds !== undefined) p.lightsOffAfterSeconds = a.lightsOffAfterSeconds;
        });
    }
  }
}
