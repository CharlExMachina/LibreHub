// Turns G502 X PLUS state into what the UI/CLI shows and applies user actions, the way G Hub's
// on-board memory mode does. Shared by the Electron main process and the CLI.
//
// The mouse keeps five profiles in its own flash. Editing a profile here rewrites that profile's
// sector; the mouse uses the new settings at once if it is the active profile, and keeps them
// with no software running (which is what you want on Linux). Macros go to the profile's macro
// sectors (macros.ts). Software actions and Freestyle lighting can't live on the mouse; they go to
// the settings file (software.ts) and need the agent (agent.ts) running.

import { msToHz, hzToMs, OnboardProfiles } from './codecs.js';
import { Feature } from './features.js';
import type { G502X } from './g502x.js';
import { formatMacro, macroSectorsFor, packMacros, readMacro } from './macros.js';
import { controlIndex, encodeProfile, G502X_CONTROLS, withCrc, type Binding, type ControlId, type LedEffect, type MacroStep, type Profile } from './onboard.js';
import { DPI_PRESETS, EFFECT_LIMITS, formatEffect, INACTIVITY_CHOICES, isPrimaryZoneEffect, parseEffect } from './presets.js';
import { formatFreestyle, formatSoftwareAction, parseAssignment, profileSoftware, type Assignment, type Freestyle, type Layer, type ProfileSoftware, type SoftwareConfig, type SoftwareStore } from './software.js';
import { formatBinding } from './usages.js';
import { fromHex, toHex } from './hidpp.js';

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
  /** Per-LED colours shown while the agent runs, left to right (FREESTYLE_LEDS), or "off". */
  freestyle: string;
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
  capabilities: {
    dpi: { min: number; max: number; step: number };
    reportRatesHz: number[];
    /** G Hub's curated DPI tables, for the app to show and match. */
    dpiPresets: { name: string; levels: number[]; defaultIndex: number; shiftIndex: number }[];
    /** G Hub's lighting ranges and inactivity choices (seconds, null = never). */
    lighting: typeof EFFECT_LIMITS & { inactivity: (number | null)[] };
  };
}

export type LightingTarget = 'active' | 'inactive';

/** The whole onboard memory, as `librehub mouse backup` and the app save it. */
export interface MouseBackup {
  device: string;
  savedAt: string;
  /** Sector number → its bytes in hex. */
  sectors: Record<string, string>;
}

/** What changes from moment to moment (the mouse's own buttons switch profile and DPI level). */
export interface MouseLive {
  mode: string;
  activeProfile: number;
  dpi: { current: number; level: number | null };
  battery: MouseSnapshot['battery'];
}

export type MouseAction =
  | { type: 'mode'; mode: 'onboard' | 'host' }
  | { type: 'activeProfile'; profile: number }
  | { type: 'dpiLevel'; index: number }
  | { type: 'profileEnabled'; profile: number; enabled: boolean }
  | { type: 'restoreProfile'; profile: number }
  | { type: 'reportRate'; profile: number; hz: number }
  /** Omitted indexes keep the profile's current ones (clamped to the new number of levels). */
  | { type: 'dpi'; profile: number; levels: number[]; defaultIndex?: number; shiftIndex?: number }
  | { type: 'dpiPreset'; profile: number; preset: string }
  | { type: 'name'; profile: number; name: string | null }
  /** A binding, a macro (stored on the mouse) or a software action; text as in parseAssignment. */
  | { type: 'button'; profile: number; control: string; layer: Layer; assignment: Assignment | string }
  /** Freestyle per-LED colours for a profile (null = off). Shown while the agent runs. */
  | { type: 'freestyle'; profile: number; colors: Freestyle | null }
  /** An effect, or its text form as in parseEffect (e.g. "wave:5000:horizontal:100"). */
  | { type: 'lighting'; profile: number; target: LightingTarget; effect: LedEffect | string | 'dim'; dimPercent?: number }
  | { type: 'inactivity'; profile: number; dimAfterSeconds?: number | null; lightsOffAfterSeconds?: number | null }
  | { type: 'startupEffect'; enabled: boolean };

const OFF: LedEffect = { type: 'off' };

/** Lower an effect's brightness the way G Hub's "Dim Active Effect" does. */
export function dimmed(e: LedEffect, percent: number): LedEffect {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new RangeError(`dim percentage must be 1..100, got ${percent}`);
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

/** The percentage `idle` dims `active` by (G Hub's "Dim Active Effect"), or null if it is something else. */
export function dimPercentOf(active: LedEffect, idle: LedEffect): number | null {
  if (active.type === 'off' || active.type !== idle.type) return null;
  const want = JSON.stringify(idle);
  for (let pct = 100; pct >= 1; pct--) if (JSON.stringify(dimmed(active, pct)) === want) return pct;
  return null;
}

/** Put an effect in the LED slot G Hub would use and switch the other slot off. */
export function placeEffect(effect: LedEffect): { all: LedEffect; primary: LedEffect } {
  if (effect.type === 'off') return { all: OFF, primary: OFF };
  return isPrimaryZoneEffect(effect) ? { all: OFF, primary: effect } : { all: effect, primary: OFF };
}

const activeOf = (l: { all: LedEffect; primary: LedEffect }) => (l.all.type !== 'off' ? l.all : l.primary);

export class MouseService {
  /** Whole operations run one at a time (read-modify-write of a profile must not interleave). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly mouse: G502X,
    /** Where software actions and Freestyle are kept; without it those can't be set. */
    readonly store?: SoftwareStore,
  ) {}

  /** Run device I/O without interleaving with an operation in progress (the agent uses this). */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive(fn);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private view(slot: number, p: Profile & { enabled: boolean }, sectors: Map<number, Uint8Array>, sw: ProfileSoftware): ProfileView {
    const show = (b: Binding | undefined, layer: Layer, control: ControlId): string => {
      if (!b) return 'default';
      if (b.type === 'macro') {
        const steps = readMacro(sectors.get(b.sector), b.offset);
        return steps ? formatMacro(steps) : `macro:missing(${b.sector}:${b.offset})`;
      }
      const action = sw.actions[layer][control];
      if (b.type === 'disabled' && action) return formatSoftwareAction(action);
      return formatBinding(b);
    };
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
        binding: show(p.buttons[k], 'base', c.id),
        gshift: show(p.gshift[k], 'gshift', c.id),
      })),
      lighting: { active: formatEffect(activeOf(p.lighting.active)), inactive: formatEffect(activeOf(p.lighting.inactive)) },
      dimAfterSeconds: p.dimAfterSeconds,
      lightsOffAfterSeconds: p.lightsOffAfterSeconds,
      freestyle: formatFreestyle(sw.freestyle),
    };
  }

  /** The sectors the profiles' macro bindings point at, read once each. */
  private async macroSectors(profiles: Profile[]): Promise<Map<number, Uint8Array>> {
    const out = new Map<number, Uint8Array>();
    const { sectorCount } = await this.mouse.getOnboardDescription();
    for (const p of profiles) {
      for (const b of [...p.buttons, ...p.gshift]) {
        if (b.type !== 'macro' || out.has(b.sector) || b.sector >= sectorCount) continue;
        out.set(b.sector, await this.mouse.readSector(b.sector));
      }
    }
    return out;
  }

  private async software(): Promise<SoftwareConfig> {
    return this.store ? this.store.read() : { version: 1, profiles: {} };
  }

  snapshot(): Promise<MouseSnapshot> {
    return this.exclusive(() => this.readSnapshot());
  }

  private async readSnapshot(): Promise<MouseSnapshot> {
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
      profiles: await (async () => {
        const sectors = await this.macroSectors(profiles);
        const sw = await this.software();
        return profiles.map((p, k) => this.view(k + 1, p, sectors, profileSoftware(sw, k + 1)));
      })(),
      capabilities: {
        dpi: range,
        reportRatesHz: (await m.getReportRates()).map(msToHz),
        dpiPresets: DPI_PRESETS.map(({ name, levels, defaultIndex, shiftIndex }) => ({ name, levels, defaultIndex, shiftIndex })),
        lighting: { ...EFFECT_LIMITS, inactivity: INACTIVITY_CHOICES },
      },
    };
  }

  /**
   * The few readings that change while the mouse is used. Fails fast with MouseUnavailableError
   * while it sleeps, instead of waiting for it to wake.
   */
  live(): Promise<MouseLive> {
    return this.exclusive(async () => {
      const m = this.mouse;
      const mode = OnboardProfiles.decodeMode(await m.callOnce(Feature.ONBOARD_PROFILES, OnboardProfiles.GET_MODE));
      const dpi = await m.getDpi();
      return {
        mode,
        activeProfile: await m.getActiveProfile(),
        dpi: { current: dpi.dpi, level: mode === 'onboard' ? await m.getDpiIndex() : null },
        battery: await m.getBattery(),
      };
    });
  }

  /** Read every user sector of the onboard memory. */
  backup(): Promise<MouseBackup> {
    return this.exclusive(async () => {
      const { sectorCount } = await this.mouse.getOnboardDescription();
      const sectors: Record<string, string> = {};
      for (let s = 0; s < sectorCount; s++) sectors[s] = toHex(await this.mouse.readSector(s));
      return { device: (await this.mouse.getInfo()).name, savedAt: new Date().toISOString(), sectors };
    });
  }

  /**
   * Write a backup back: only the sectors that differ, then reload the active profile. The whole
   * file is checked before anything is written.
   */
  restore(backup: MouseBackup, onSector?: (sector: number) => void): Promise<number[]> {
    return this.exclusive(async () => {
      const { sectorCount, sectorSize } = await this.mouse.getOnboardDescription();
      const entries = Object.entries(backup?.sectors ?? {});
      if (!entries.length) throw new Error('this is not a mouse backup (no sectors)');
      const wanted = entries.map(([s, hex]) => {
        const sector = Number(s);
        if (!Number.isInteger(sector) || sector < 0 || sector >= sectorCount) throw new Error(`the backup has sector ${s}; the mouse has 0..${sectorCount - 1}`);
        if (!/^[0-9a-f]{2}( [0-9a-f]{2})*$/i.test(String(hex))) throw new Error(`sector ${s} in the backup is not hex bytes`);
        const bytes = fromHex(String(hex));
        if (bytes.length !== sectorSize) throw new Error(`sector ${s} in the backup is ${bytes.length} bytes, not ${sectorSize}`);
        return { sector, bytes };
      });
      const restored: number[] = [];
      for (const { sector, bytes } of wanted) {
        if (toHex(await this.mouse.readSector(sector)) === toHex(bytes)) continue;
        if (bytes.every((b) => b === 0xff)) await this.mouse.eraseSector(sector);
        else await this.mouse.writeSector(sector, bytes);
        restored.push(sector);
        onSector?.(sector);
      }
      if ((await this.mouse.getMode()) === 'onboard') await this.mouse.setActiveProfile(await this.mouse.getActiveProfile()).catch(() => undefined);
      return restored;
    });
  }

  private async assign(slot: number, control: string, layer: Layer, a: Assignment): Promise<void> {
    const k = controlIndex(control);
    const id = G502X_CONTROLS[k].id;
    if (a.kind === 'software' && !this.store) throw new Error('software actions need a settings file');
    if (layer !== 'base' && layer !== 'gshift') throw new RangeError(`layer must be base or gshift, got ${String(layer)}`);
    const p = await this.mouse.readProfile(slot);
    const bindings = layer === 'gshift' ? p.gshift : p.buttons;
    while (bindings.length <= k) bindings.push({ type: 'unassigned' });
    // A control with a software action does nothing on the mouse; the agent performs the action.
    // A macro gets its pointer from writeWithMacros.
    bindings[k] = a.kind === 'binding' ? a.binding : { type: 'disabled' };
    await this.writeWithMacros(slot, p, a.kind === 'macro' ? { layer, k, steps: a.steps } : undefined);
    if (this.store) {
      await this.store.update(slot, (s) => {
        if (a.kind === 'software') s.actions[layer][id] = a.action;
        else delete s.actions[layer][id];
      });
    }
  }

  /**
   * Write a profile together with its macros: collect the macros its bindings use (plus a new
   * one), pack them into the profile's own macro sectors, point the bindings at them, and write
   * changed macro sectors before the profile that points into them.
   */
  private async writeWithMacros(slot: number, p: Profile, added?: { layer: Layer; k: number; steps: MacroStep[] }): Promise<void> {
    const own = macroSectorsFor(slot);
    const { sectorSize } = await this.mouse.getOnboardDescription();
    const current = new Map<number, Uint8Array>();
    for (const s of own) current.set(s, await this.mouse.readSector(s));
    const users: { layer: Binding[]; k: number }[] = [];
    const macros: MacroStep[][] = [];
    for (const layer of [p.buttons, p.gshift]) {
      layer.forEach((b, k) => {
        if (b.type !== 'macro' || !own.includes(b.sector)) return;
        const steps = readMacro(current.get(b.sector), b.offset);
        if (steps) {
          users.push({ layer, k });
          macros.push(steps);
        } else {
          layer[k] = { type: 'disabled' }; // points at nothing valid; don't keep a dangling pointer
        }
      });
    }
    if (added) {
      users.push({ layer: added.layer === 'gshift' ? p.gshift : p.buttons, k: added.k });
      macros.push(added.steps);
    }
    const packed = packMacros(macros, own, sectorSize);
    users.forEach((u, i) => {
      u.layer[u.k] = { type: 'macro', ...packed.pointers[i] };
    });
    for (const s of own) {
      const want = packed.sectors.get(s)!;
      const have = current.get(s)!;
      const empty = want.slice(0, -2).every((b) => b === 0xff);
      if (empty) {
        if (!have.every((b) => b === 0xff)) await this.mouse.eraseSector(s);
      } else if (toHex(want) !== toHex(have)) {
        await this.mouse.writeSector(s, want);
      }
    }
    await this.mouse.writeProfile(slot, p);
  }

  /** Read a profile, change it, write it back. */
  /** Read a profile, change it, write it back; a change that changes nothing writes nothing (flash wears). */
  async editProfile(slot: number, change: (p: Profile) => Profile | void): Promise<void> {
    const p = await this.mouse.readProfile(slot);
    const before = toHex(p.raw);
    const next = change(p) ?? p;
    if (toHex(withCrc(encodeProfile(next))) === before) return;
    await this.mouse.writeProfile(slot, next);
  }

  apply(a: MouseAction): Promise<void> {
    return this.exclusive(() => this.applyNow(a));
  }

  private async applyNow(a: MouseAction): Promise<void> {
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
        await m.restoreFactoryProfile(a.profile);
        // G Hub's "restore" resets everything, including what lives on the computer.
        await this.store?.update(a.profile, (s) => {
          s.actions = { base: {}, gshift: {} };
          s.freestyle = null;
        });
        return;
      case 'startupEffect':
        return m.setStartupEffect(a.enabled);
      case 'reportRate': {
        const ms = hzToMs(a.hz);
        if (msToHz(ms) !== a.hz) throw new RangeError(`report rate must be 1000, 500, 250 or 125 Hz, got ${a.hz}`);
        return this.editProfile(a.profile, (p) => {
          p.reportRateMs = ms;
        });
      }
      case 'dpi':
        return this.editProfile(a.profile, (p) => {
          const last = a.levels.length - 1;
          p.defaultDpiIndex = a.defaultIndex ?? Math.min(p.defaultDpiIndex, last);
          p.shiftDpiIndex = a.shiftIndex ?? Math.min(p.shiftDpiIndex, last);
          p.dpiLevels = a.levels;
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
      case 'button':
        return this.assign(a.profile, a.control, a.layer, typeof a.assignment === 'string' ? parseAssignment(a.assignment) : a.assignment);
      case 'freestyle': {
        if (!this.store) throw new Error('Freestyle lighting needs a settings file');
        await m.readProfile(a.profile); // the profile must exist
        return this.store.update(a.profile, (s) => {
          s.freestyle = a.colors;
        });
      }
      case 'lighting': {
        const effect = typeof a.effect === 'string' && a.effect !== 'dim' ? parseEffect(a.effect) : a.effect;
        return this.editProfile(a.profile, (p) => {
          if (effect === 'dim') {
            p.lighting.inactive = placeEffect(dimmed(activeOf(p.lighting.active), a.dimPercent ?? 50));
          } else if (a.target === 'active') {
            // An idle lighting that dims the active effect keeps dimming it, not a copy of the old one.
            const dim = dimPercentOf(activeOf(p.lighting.active), activeOf(p.lighting.inactive));
            p.lighting.active = placeEffect(effect);
            if (dim !== null && effect.type !== 'off') p.lighting.inactive = placeEffect(dimmed(effect, dim));
          } else {
            p.lighting.inactive = placeEffect(effect);
          }
        });
      }
      case 'inactivity':
        return this.editProfile(a.profile, (p) => {
          if (a.dimAfterSeconds !== undefined) p.dimAfterSeconds = a.dimAfterSeconds;
          if (a.lightsOffAfterSeconds !== undefined) p.lightsOffAfterSeconds = a.lightsOffAfterSeconds;
        });
    }
  }
}
