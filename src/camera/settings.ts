// The MX Brio's settings as G Hub presents them (Crop, Exposure, Image and Focus, plus
// anti-flicker), and how each maps to a camera control. Ranges, value tables and presets are G
// Hub's own, from its capability block and its depot for this model (docs/MXBRIO-PROTOCOL.md).

import { AE_MODE, type ControlName } from './uvc.js';

/** G Hub's field-of-view choices, in the order of the video pipe control's values (0 = 90°). */
export const FOVS = [90, 78, 65] as const;
export type Fov = (typeof FOVS)[number];

/**
 * G Hub's shutter speeds: its label (1/x of a second, as G Hub writes it) and the UVC exposure time
 * it writes on macOS, in 100 µs units ("mac" in its capability block; Linux takes the same units).
 * G Hub's labels for the slow end don't match the time it writes (its "1/17" is 204.7 ms).
 */
export const SHUTTER_SPEEDS = [
  { label: 2000, raw: 5 },
  { label: 800, raw: 10 },
  { label: 400, raw: 20 },
  { label: 200, raw: 39 },
  { label: 120, raw: 78 },
  { label: 60, raw: 156 },
  { label: 30, raw: 312 },
  { label: 24, raw: 625 },
  { label: 20, raw: 1250 },
  { label: 17, raw: 2047 },
] as const;

/** G Hub's ISO steps (100–1600) and the UVC gain each writes (0–240, in 16s). */
export const ISO_STEPS = Array.from({ length: 16 }, (_, i) => ({ iso: (i + 1) * 100, raw: i * 16 }));

export interface CameraSettings {
  // Crop
  fov: Fov;
  /** Percent: 100 (none) to 400. */
  zoom: number;
  /** Arc seconds, as UVC has them: ±72000 (±20°) in steps of 3600 (1°). Only with zoom over 100. */
  pan: number;
  tilt: number;
  /** The camera turns the picture when it's tilted down at the desk. */
  showMode: boolean;
  // Exposure
  autoExposure: boolean;
  /** Shutter speed, G Hub's label (1/x s); applies with auto exposure off. */
  shutter: number;
  /** ISO 100–1600; applies with auto exposure off. */
  iso: number;
  /** 0–255, 128 = none. */
  exposureCompensation: number;
  hdr: boolean;
  /** What auto exposure gives up first in low light: the frame rate, or a longer exposure. */
  priority: 'exposure' | 'frame-rate';
  // Image
  brightness: number;
  contrast: number;
  saturation: number;
  sharpness: number;
  /** 0–100, 50 = none. */
  tint: number;
  vibrance: number;
  autoWhiteBalance: boolean;
  /** Kelvin, 2800–7500; applies with auto white balance off. */
  whiteBalance: number;
  /** 0–100, 50 = none: warmer above, cooler below. */
  temperatureCompensation: number;
  // Focus
  autoFocus: boolean;
  focus: number;
  // Settings
  /** Hz of the mains, so lights don't flicker in the picture. */
  antiFlicker: 50 | 60;
}

export type SettingKey = keyof CameraSettings;
export type Group = 'crop' | 'exposure' | 'image' | 'focus' | 'general';

/**
 * A setting's place, kind and limits. `auto` names the switch that makes it not apply: while that
 * is on the camera refuses the value (a STALL; docs/evidence/mx-brio/uvc/writes-while-auto.txt).
 */
export interface SettingSpec {
  group: Group;
  label: string;
  control: ControlName;
  kind: 'number' | 'boolean' | 'choice';
  min?: number;
  max?: number;
  step?: number;
  choices?: readonly (number | string)[];
  auto?: SettingKey;
  /** Only means something with this switch off (the page greys it out), but is written either way. */
  manualWith?: SettingKey;
  toRaw(v: never): number;
  fromRaw(raw: number): CameraSettings[SettingKey];
}

const same = (v: number) => v;
const bool = { kind: 'boolean' as const, toRaw: (v: boolean) => (v ? 1 : 0), fromRaw: (r: number) => r !== 0 };
const nearest = <T>(list: readonly T[], raw: number, get: (x: T) => number) =>
  list.reduce((best, x) => (Math.abs(get(x) - raw) < Math.abs(get(best) - raw) ? x : best), list[0]);

export const SETTINGS: { [K in SettingKey]: SettingSpec } = {
  fov: { group: 'crop', label: 'Field of view', control: 'fov', kind: 'choice', choices: FOVS,
    toRaw: (v: Fov) => FOVS.indexOf(v), fromRaw: (r) => FOVS[r] ?? 90 },
  zoom: { group: 'crop', label: 'Zoom', control: 'zoom', kind: 'number', min: 100, max: 400, step: 1, toRaw: same, fromRaw: same },
  pan: { group: 'crop', label: 'Pan', control: 'pan', kind: 'number', min: -72000, max: 72000, step: 3600, toRaw: same, fromRaw: same },
  tilt: { group: 'crop', label: 'Tilt', control: 'tilt', kind: 'number', min: -72000, max: 72000, step: 3600, toRaw: same, fromRaw: same },
  showMode: { group: 'crop', label: 'Show Mode', control: 'showMode', ...bool },
  // G Hub writes aperture priority (8) for auto; the camera has no plain "auto" (GET_RES = 0x09).
  autoExposure: { group: 'exposure', label: 'Auto exposure', control: 'aeMode', kind: 'boolean',
    toRaw: (v: boolean) => (v ? AE_MODE.aperturePriority : AE_MODE.manual), fromRaw: (r) => r !== AE_MODE.manual },
  shutter: { group: 'exposure', label: 'Shutter speed', control: 'exposureTime', kind: 'choice', choices: SHUTTER_SPEEDS.map((s) => s.label), auto: 'autoExposure',
    toRaw: (v: number) => shutterRaw(v), fromRaw: (r) => nearest(SHUTTER_SPEEDS, r, (s) => s.raw).label },
  // The camera takes gain in auto exposure too, and G Hub writes it then; only the page greys it out.
  iso: { group: 'exposure', label: 'ISO', control: 'gain', kind: 'choice', choices: ISO_STEPS.map((s) => s.iso), manualWith: 'autoExposure',
    toRaw: (v: number) => isoRaw(v), fromRaw: (r) => nearest(ISO_STEPS, r, (s) => s.raw).iso },
  exposureCompensation: { group: 'exposure', label: 'Exposure compensation', control: 'exposureCompensation', kind: 'number', min: 0, max: 255, step: 1, toRaw: same, fromRaw: same },
  hdr: { group: 'exposure', label: 'HDR', control: 'backlightCompensation', ...bool },
  priority: { group: 'exposure', label: 'Priority', control: 'aePriority', kind: 'choice', choices: ['exposure', 'frame-rate'],
    toRaw: (v: 'exposure' | 'frame-rate') => (v === 'exposure' ? 1 : 0), fromRaw: (r) => (r ? 'exposure' : 'frame-rate') },
  brightness: { group: 'image', label: 'Brightness', control: 'brightness', kind: 'number', min: 0, max: 255, step: 1, toRaw: same, fromRaw: same },
  contrast: { group: 'image', label: 'Contrast', control: 'contrast', kind: 'number', min: 0, max: 255, step: 1, toRaw: same, fromRaw: same },
  saturation: { group: 'image', label: 'Saturation', control: 'saturation', kind: 'number', min: 0, max: 255, step: 1, toRaw: same, fromRaw: same },
  sharpness: { group: 'image', label: 'Sharpness', control: 'sharpness', kind: 'number', min: 0, max: 255, step: 1, toRaw: same, fromRaw: same },
  tint: { group: 'image', label: 'Tint', control: 'tint', kind: 'number', min: 0, max: 100, step: 1, toRaw: same, fromRaw: same },
  vibrance: { group: 'image', label: 'Vibrance', control: 'vibrance', kind: 'number', min: 0, max: 255, step: 1, toRaw: same, fromRaw: same },
  autoWhiteBalance: { group: 'image', label: 'Auto white balance', control: 'whiteBalanceAuto', ...bool },
  whiteBalance: { group: 'image', label: 'White balance', control: 'whiteBalance', kind: 'number', min: 2800, max: 7500, step: 1, auto: 'autoWhiteBalance', toRaw: same, fromRaw: same },
  temperatureCompensation: { group: 'image', label: 'Temperature', control: 'temperatureCompensation', kind: 'number', min: 0, max: 100, step: 1, toRaw: same, fromRaw: same },
  autoFocus: { group: 'focus', label: 'Auto focus', control: 'focusAuto', ...bool },
  focus: { group: 'focus', label: 'Focus', control: 'focus', kind: 'number', min: 0, max: 255, step: 1, auto: 'autoFocus', toRaw: same, fromRaw: same },
  antiFlicker: { group: 'general', label: 'Anti-flicker', control: 'powerLineFrequency', kind: 'choice', choices: [50, 60],
    toRaw: (v: 50 | 60) => (v === 50 ? 1 : 2), fromRaw: (r) => (r === 1 ? 50 : 60) },
};

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const GROUP_KEYS: Record<Group, SettingKey[]> = {
  crop: SETTING_KEYS.filter((k) => SETTINGS[k].group === 'crop'),
  exposure: SETTING_KEYS.filter((k) => SETTINGS[k].group === 'exposure'),
  image: SETTING_KEYS.filter((k) => SETTINGS[k].group === 'image'),
  focus: SETTING_KEYS.filter((k) => SETTINGS[k].group === 'focus'),
  general: SETTING_KEYS.filter((k) => SETTINGS[k].group === 'general'),
};

export function shutterRaw(label: number): number {
  const s = SHUTTER_SPEEDS.find((x) => x.label === label);
  if (!s) throw new Error(`shutter speed must be one of ${SHUTTER_SPEEDS.map((x) => `1/${x.label}`).join(', ')}`);
  return s.raw;
}

export function isoRaw(iso: number): number {
  const s = ISO_STEPS.find((x) => x.iso === iso);
  if (!s) throw new Error('ISO must be 100, 200, … 1600');
  return s.raw;
}

/** The value as written to the camera, after checking it. Throws with a message for people. */
export function toRaw<K extends SettingKey>(key: K, value: CameraSettings[K]): number {
  const spec = SETTINGS[key];
  if (spec.kind === 'boolean' && typeof value !== 'boolean') throw new Error(`${spec.label}: expected on or off`);
  if (spec.kind === 'choice' && !spec.choices!.includes(value as number | string)) {
    throw new Error(`${spec.label} must be one of ${spec.choices!.map((c) => (key === 'shutter' ? `1/${c}` : c)).join(', ')}`);
  }
  if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min! || value > spec.max!) throw new Error(`${spec.label} must be a whole number from ${spec.min} to ${spec.max}`);
    if (spec.step! > 1 && value % spec.step! !== 0) throw new Error(`${spec.label} goes in steps of ${spec.step}`);
  }
  return (spec.toRaw as (v: CameraSettings[K]) => number)(value);
}

/** G Hub's defaults for this camera: what its "Reset to default" writes (depot default_configurations.json). */
export const DEFAULTS: CameraSettings = {
  fov: 90, zoom: 100, pan: 0, tilt: 0, showMode: true,
  autoExposure: true, shutter: 60, iso: 100, exposureCompensation: 128, hdr: true, priority: 'exposure',
  brightness: 128, contrast: 128, saturation: 128, sharpness: 128, tint: 50, vibrance: 128, autoWhiteBalance: true, whiteBalance: 5000, temperatureCompensation: 50,
  autoFocus: true, focus: 1,
  antiFlicker: 60,
};

/** A preset is a setting group's values, by name. */
export interface Preset {
  name: string;
  group: Exclude<Group, 'general'>;
  settings: Partial<CameraSettings>;
}

const pick = (group: Group, over: Partial<CameraSettings> = {}): Partial<CameraSettings> =>
  Object.fromEntries(GROUP_KEYS[group].map((k) => [k, k in over ? over[k] : DEFAULTS[k]]));

/** G Hub's own presets for the MX Brio (depot device_presets.json), per tab. */
export const CURATED_PRESETS: Preset[] = [
  { group: 'crop', name: 'Default', settings: pick('crop') },
  { group: 'crop', name: 'FOV 78°', settings: pick('crop', { fov: 78 }) },
  { group: 'crop', name: 'FOV 65°', settings: pick('crop', { fov: 65 }) },
  { group: 'crop', name: 'Zoom 1.5×', settings: pick('crop', { zoom: 150 }) },
  { group: 'crop', name: 'Zoom 2×', settings: pick('crop', { zoom: 200 }) },
  { group: 'exposure', name: 'Default', settings: pick('exposure') },
  { group: 'exposure', name: 'Streaming', settings: pick('exposure', { priority: 'frame-rate' }) },
  { group: 'image', name: 'Default', settings: pick('image') },
  { group: 'image', name: 'Black and White', settings: pick('image', { saturation: 0 }) },
  { group: 'image', name: 'Warmer', settings: pick('image', { temperatureCompensation: 60 }) },
  { group: 'image', name: 'Cooler', settings: pick('image', { temperatureCompensation: 40 }) },
  { group: 'focus', name: 'Default', settings: pick('focus') },
];

/**
 * Whether the settings match a preset. Values that don't apply (a manual shutter speed while
 * auto exposure is on) don't count, as G Hub doesn't show them either.
 */
export function matchesPreset(settings: CameraSettings, preset: Preset): boolean {
  return Object.entries(preset.settings).every(([k, v]) => {
    const auto = SETTINGS[k as SettingKey].auto;
    if (auto && settings[auto] === true && preset.settings[auto] === true) return true;
    return settings[k as SettingKey] === v;
  });
}

/**
 * The order to write changed settings in: switches before the values they gate, so a manual value
 * goes in after manual mode is on. Values gated by an auto switch that is (or will be) on are left
 * out: the camera ignores or refuses them, and G Hub doesn't write them either.
 */
export function writePlan(target: Partial<CameraSettings>, current: CameraSettings): { key: SettingKey; raw: number }[] {
  const next = { ...current, ...target };
  const keys = (Object.keys(target) as SettingKey[]).filter((k) => k in SETTINGS);
  const switches = keys.filter((k) => SETTING_KEYS.some((o) => SETTINGS[o].auto === k));
  const rest = keys.filter((k) => !switches.includes(k));
  const plan: { key: SettingKey; raw: number }[] = [];
  for (const k of [...switches, ...rest]) {
    const auto = SETTINGS[k].auto;
    if (auto && next[auto] === true) continue;
    plan.push({ key: k, raw: toRaw(k, next[k] as never) });
  }
  return plan;
}

/** Setting values from text, as typed on the command line ("on", "1/60", "78", "frame-rate"). */
export function parseSetting(key: SettingKey, text: string): CameraSettings[SettingKey] {
  const spec = SETTINGS[key];
  const t = text.trim().toLowerCase();
  if (spec.kind === 'boolean') {
    if (['on', 'true', 'yes', '1', 'auto'].includes(t)) return true;
    if (['off', 'false', 'no', '0', 'manual'].includes(t)) return false;
    throw new Error(`${spec.label}: expected on or off`);
  }
  if (key === 'priority') {
    if (t === 'exposure' || t === 'frame-rate') return t;
    if (t === 'framerate' || t === 'fps') return 'frame-rate';
    throw new Error('priority must be "exposure" or "frame-rate"');
  }
  const n = Number(key === 'shutter' ? t.replace(/^1\//, '') : t.replace(/(°|k|hz|%|x)$/, ''));
  if (!Number.isFinite(n)) throw new Error(`${spec.label}: "${text}" is not a number`);
  const value = (key === 'pan' || key === 'tilt') && Math.abs(n) <= 20 ? n * 3600 : n; // degrees, as G Hub shows them
  toRaw(key, value as never);
  return value as CameraSettings[SettingKey];
}

/** A setting's value for people ("1/60 s", "78°", "On"). */
export function formatSetting(key: SettingKey, value: CameraSettings[SettingKey]): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  switch (key) {
    case 'fov':
      return `${value}°`;
    case 'zoom':
      return `${value}%`;
    case 'pan':
    case 'tilt':
      return `${(value as number) / 3600}°`;
    case 'shutter':
      return `1/${value} s`;
    case 'iso':
      return `ISO ${value}`;
    case 'whiteBalance':
      return `${value} K`;
    case 'antiFlicker':
      return `${value} Hz`;
    default:
      return String(value);
  }
}
