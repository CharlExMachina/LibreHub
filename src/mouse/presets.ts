// What G Hub offers for the G502 X PLUS, as data: curated DPI presets, lighting effects with
// G Hub's defaults and ranges, and the inactivity timer choices. Taken from G Hub's device depot
// (defaults_override.json for model g502x_plus) and its UI; see docs/G502X-PROTOCOL.md.

import { WaveDirection, type LedEffect, type Rgb } from './onboard.js';

export interface DpiPreset {
  name: string;
  ghubId: string;
  levels: number[];
  /** 0-based indexes into levels. */
  defaultIndex: number;
  shiftIndex: number;
}

/**
 * G Hub's MOUSE_SETTINGS_ADVANCED prefabs for g502x_plus, with disabled levels dropped and its
 * 1-based indexes converted. The *_XY prefabs are left out: they need separate X/Y DPI, which this
 * mouse's sensor feature (0x2201) and onboard format cannot store.
 */
export const DPI_PRESETS: DpiPreset[] = [
  { name: 'default', ghubId: 'MSA_PREFAB_00_DEFAULT', levels: [800, 1200, 1600, 2400, 3200], defaultIndex: 2, shiftIndex: 0 },
  { name: 'first-person', ghubId: 'MSA_PREFAB_FIRST_PERSON', levels: [400, 800, 1600], defaultIndex: 1, shiftIndex: 0 },
  { name: 'third-person', ghubId: 'MSA_PREFAB_THIRD_PERSON', levels: [400, 800, 1200, 1600], defaultIndex: 1, shiftIndex: 0 },
  { name: 'mmorpg', ghubId: 'MSA_PREFAB_MMORPG', levels: [1000, 1200, 1400, 1600], defaultIndex: 1, shiftIndex: 0 },
  { name: 'moba', ghubId: 'MSA_PREFAB_MOBA', levels: [1600, 1800, 2200, 2600], defaultIndex: 1, shiftIndex: 0 },
  { name: 'rts', ghubId: 'MSA_PREFAB_RTS', levels: [1000, 1200, 1600, 2000], defaultIndex: 1, shiftIndex: 0 },
  { name: 'simulation', ghubId: 'MSA_PREFAB_SIMULATION', levels: [1200, 1600, 2000, 2500], defaultIndex: 1, shiftIndex: 0 },
  { name: 'productivity', ghubId: 'MSA_PREFAB_PRODUCTIVITY', levels: [1600, 2000, 2500, 3000], defaultIndex: 1, shiftIndex: 0 },
];

/** G Hub's inactivity choices (seconds; null = never), for "Start after" and "All lights off after". */
export const INACTIVITY_CHOICES: (number | null)[] = [null, 60, 120, 300, 600, 900];

/** The effects G Hub's LIGHTSYNC "Presets" tab offers, with G Hub's defaults. */
export const EFFECT_DEFAULTS: Record<string, LedEffect> = {
  off: { type: 'off' },
  fixed: { type: 'fixed', color: [0, 255, 255] },
  cycle: { type: 'cycle', periodMs: 5000, brightness: 100 },
  breathing: { type: 'breathing', color: [0, 255, 255], periodMs: 5000, waveform: 0, brightness: 100 },
  wave: { type: 'wave', periodMs: 5000, direction: WaveDirection.horizontal, brightness: 100 },
  'pulsar-point': { type: 'signature', variant: 'active', frameMs: 32, brightness: 100 },
  'neutron-null': { type: 'signature', variant: 'inactive', frameMs: 32, brightness: 100 },
};

/** G Hub's slider ranges. */
export const EFFECT_LIMITS = {
  periodMs: { min: 1000, max: 20000 },
  frameMs: { min: 32, max: 64 },
  brightness: { min: 1, max: 100 },
};

const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const parseColor = (s: string): Rgb => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) throw new Error(`expected a colour like #00ffff, got "${s}"`);
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 0xff, n & 0xff];
};

/**
 * Text form of an effect, used by the CLI:
 *   off | fixed:#rrggbb | cycle[:periodMs[:brightness]] | breathing:#rrggbb[:periodMs[:brightness]]
 *   wave[:periodMs[:horizontal|reverse-horizontal[:brightness]]] | pulsar-point[:frameMs[:brightness]]
 *   neutron-null[:frameMs[:brightness]]
 */
export function parseEffect(text: string): LedEffect {
  const [name, ...args] = text.trim().toLowerCase().split(':');
  const base = EFFECT_DEFAULTS[name];
  if (!base) throw new Error(`unknown effect "${name}" (${Object.keys(EFFECT_DEFAULTS).join(', ')})`);
  const num = (v: string | undefined, fallback: number, limits: { min: number; max: number }, what: string) => {
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < limits.min || n > limits.max) throw new RangeError(`${what} must be ${limits.min}..${limits.max}, got "${v}"`);
    return n;
  };
  switch (base.type) {
    case 'off':
      return base;
    case 'fixed':
      return { ...base, color: args[0] ? parseColor(args[0]) : base.color };
    case 'cycle':
      return { ...base, periodMs: num(args[0], base.periodMs, EFFECT_LIMITS.periodMs, 'period'), brightness: num(args[1], base.brightness, EFFECT_LIMITS.brightness, 'brightness') };
    case 'breathing':
      return {
        ...base,
        color: args[0] ? parseColor(args[0]) : base.color,
        periodMs: num(args[1], base.periodMs, EFFECT_LIMITS.periodMs, 'period'),
        brightness: num(args[2], base.brightness, EFFECT_LIMITS.brightness, 'brightness'),
      };
    case 'wave': {
      const dir = args[1] ?? 'horizontal';
      if (!(dir in WaveDirection)) throw new Error(`wave direction must be ${Object.keys(WaveDirection).join(' or ')}`);
      return {
        ...base,
        periodMs: num(args[0], base.periodMs, EFFECT_LIMITS.periodMs, 'period'),
        direction: WaveDirection[dir as keyof typeof WaveDirection],
        brightness: num(args[2], base.brightness, EFFECT_LIMITS.brightness, 'brightness'),
      };
    }
    case 'signature':
      return { ...base, frameMs: num(args[0], base.frameMs, EFFECT_LIMITS.frameMs, 'frame time'), brightness: num(args[1], base.brightness, EFFECT_LIMITS.brightness, 'brightness') };
    default:
      return base;
  }
}

export function formatEffect(e: LedEffect): string {
  switch (e.type) {
    case 'off':
      return 'off';
    case 'fixed':
      return `fixed:${hex(e.color)}`;
    case 'cycle':
      return `cycle:${e.periodMs}:${e.brightness}`;
    case 'breathing':
      return `breathing:${hex(e.color)}:${e.periodMs}:${e.brightness}`;
    case 'wave': {
      const dir = Object.entries(WaveDirection).find(([, v]) => v === e.direction)?.[0] ?? String(e.direction);
      return `wave:${e.periodMs}:${dir}:${e.brightness}`;
    }
    case 'signature':
      return `${e.variant === 'active' ? 'pulsar-point' : 'neutron-null'}:${e.frameMs}:${e.brightness}`;
    case 'raw':
      return `raw:${e.bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
}

/** Effects that live in the primary-zone LED slot; the rest use the all-LEDs slot (as G Hub does). */
export const isPrimaryZoneEffect = (e: LedEffect) => e.type === 'fixed' || e.type === 'cycle' || e.type === 'breathing';
