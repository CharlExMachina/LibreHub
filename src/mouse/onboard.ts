// Onboard-memory format of the G502 X PLUS (feature 0x8100, memory model 1, profile format 5,
// macro format 1, sectors of 255 bytes). This is the memory G Hub writes when you put a profile
// into an on-board slot, and what the mouse runs from whenever G Hub is not controlling it.
//
// Sector 0x0000 is the profile directory; user profiles live in sectors 1..5. Read-only factory
// copies start at 0x0100 (directory) / 0x0101 (profiles). Each sector ends in a big-endian
// CRC-16/CCITT (init 0xFFFF) of the bytes before it.
//
// Encoding starts from the sector's current bytes and only overwrites the fields it models, so a
// decode/encode round trip of a sector G Hub wrote is byte-identical. Every layout below was
// checked against sectors G Hub itself wrote (test/fixtures/g502x-captures.ts).

export const DIRECTORY_SECTOR = 0x0000;
export const ROM_DIRECTORY_SECTOR = 0x0100;
export const SECTOR_SIZE = 255;
export const BUTTON_SLOTS = 16;
export const NAME_LENGTH = 24; // UTF-16 code units

export type Rgb = [number, number, number];

export function crc16(bytes: ArrayLike<number>, length = bytes.length): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function sectorCrcOk(sector: Uint8Array): boolean {
  const n = sector.length;
  return crc16(sector, n - 2) === ((sector[n - 2] << 8) | sector[n - 1]);
}

export function withCrc(sector: Uint8Array): Uint8Array {
  const out = Uint8Array.from(sector);
  const crc = crc16(out, out.length - 2);
  out[out.length - 2] = crc >> 8;
  out[out.length - 1] = crc & 0xff;
  return out;
}

// ------------------------------------------------------------------ directory

export interface DirectoryEntry {
  sector: number;
  enabled: boolean;
}

/** [sector u16 BE][enabled][0xFF] per profile, terminated by FF FF. */
export function decodeDirectory(sector: Uint8Array): DirectoryEntry[] {
  const out: DirectoryEntry[] = [];
  for (let i = 0; i + 3 < sector.length - 2; i += 4) {
    const s = (sector[i] << 8) | sector[i + 1];
    if (s === 0xffff) break;
    out.push({ sector: s, enabled: sector[i + 2] === 1 });
  }
  return out;
}

export function encodeDirectory(entries: DirectoryEntry[], size = SECTOR_SIZE): Uint8Array {
  const out = new Uint8Array(size).fill(0xff);
  entries.forEach((e, k) => {
    out[k * 4] = e.sector >> 8;
    out[k * 4 + 1] = e.sector & 0xff;
    out[k * 4 + 2] = e.enabled ? 1 : 0;
    out[k * 4 + 3] = 0xff;
  });
  return withCrc(out);
}

// ------------------------------------------------------------------ button bindings (4 bytes each)

/** Special functions the firmware implements itself (binding 90 FN 00 DATA). */
export const ButtonFunction = {
  'wheel-left': 0x01,
  'wheel-right': 0x02,
  'dpi-up': 0x03,
  'dpi-down': 0x04,
  'dpi-cycle': 0x05,
  'dpi-default': 0x06,
  'dpi-shift': 0x07,
  'profile-next': 0x08,
  'profile-previous': 0x09,
  'profile-cycle': 0x0a,
  'g-shift': 0x0b,
  'battery-status': 0x0c,
  'profile-select': 0x0d,
  'mode-switch': 0x0e,
  'host-button': 0x0f,
  'scroll-down': 0x10,
  'scroll-up': 0x11,
} as const;
export type ButtonFunctionName = keyof typeof ButtonFunction;
const FUNCTION_NAMES = Object.fromEntries(Object.entries(ButtonFunction).map(([k, v]) => [v, k])) as Record<number, ButtonFunctionName>;

/** Bits of a "mouse button" binding: 1 = left, 2 = right, 4 = middle, 8 = back, 16 = forward. */
export const MouseButton = { left: 0x01, right: 0x02, middle: 0x04, back: 0x08, forward: 0x10 } as const;

/** Keyboard modifier bits used by key bindings and macros. */
export const Modifier = { lctrl: 0x01, lshift: 0x02, lalt: 0x04, lgui: 0x08, rctrl: 0x10, rshift: 0x20, ralt: 0x40, rgui: 0x80 } as const;

export type Binding =
  /**
   * FF FF FF FF: nothing stored. The control keeps its native behaviour; the factory profiles
   * leave the scroll wheel like this, and G Hub leaves the G-Shift button's own shifted slot so.
   */
  | { type: 'unassigned' }
  /** 90 00 00 00: firmware function 0, i.e. do nothing. This is what G Hub writes for "Disable". */
  | { type: 'disabled' }
  /** 80 01 MASK(u16 BE): press mouse buttons. */
  | { type: 'mouse'; buttons: number }
  /** 80 02 MODIFIERS USAGE: a key (HID keyboard usage) with modifiers. */
  | { type: 'key'; modifiers: number; usage: number }
  /** 80 03 USAGE(u16 BE): a consumer-control key (media, volume, ...). */
  | { type: 'consumer'; usage: number }
  /** 90 FN 00 DATA: a firmware function (DPI, profiles, G-Shift, wheel tilt). */
  | { type: 'function'; fn: ButtonFunctionName | number; data?: number }
  /**
   * 00 0R 00 00 with R = 0 or 1: an assignment G Hub can only perform in software (a macro, Double
   * Click, Go to DPI Shift). G Hub stores this placeholder; on the mouse alone it does nothing.
   */
  | { type: 'software-only'; ref: number }
  /** 0S SS 00 OO: run the onboard macro at sector S, offset O (libratbag's format; G Hub does not write these). */
  | { type: 'macro'; sector: number; offset: number }
  /** Anything else, kept verbatim. */
  | { type: 'raw'; bytes: number[] };

export function decodeBinding(b: ArrayLike<number>): Binding {
  const bytes = Array.from(b).slice(0, 4);
  if (bytes.every((x) => x === 0xff)) return { type: 'unassigned' };
  const behavior = bytes[0] >> 4;
  if (bytes[0] === 0x80) {
    if (bytes[1] === 0x01) return { type: 'mouse', buttons: (bytes[2] << 8) | bytes[3] };
    if (bytes[1] === 0x02) return { type: 'key', modifiers: bytes[2], usage: bytes[3] };
    if (bytes[1] === 0x03) return { type: 'consumer', usage: (bytes[2] << 8) | bytes[3] };
  }
  if (bytes[0] === 0x90) {
    if (bytes[1] === 0x00) return { type: 'disabled' };
    const fn = FUNCTION_NAMES[bytes[1]] ?? bytes[1];
    return bytes[3] ? { type: 'function', fn, data: bytes[3] } : { type: 'function', fn };
  }
  if (behavior === 0 && bytes[0] === 0 && bytes[1] < 2 && bytes[2] === 0 && bytes[3] === 0) return { type: 'software-only', ref: bytes[1] };
  if (behavior === 0) return { type: 'macro', sector: ((bytes[0] & 0x0f) << 8) | bytes[1], offset: (bytes[2] << 8) | bytes[3] };
  return { type: 'raw', bytes };
}

const checkInt = (v: unknown, min: number, max: number, what: string) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new RangeError(`${what} must be an integer ${min}..${max}, got ${String(v)}`);
};

export function encodeBinding(b: Binding): number[] {
  switch (b.type) {
    case 'mouse':
      checkInt(b.buttons, 0, 0xffff, 'mouse button mask');
      break;
    case 'key':
      checkInt(b.modifiers, 0, 0xff, 'modifiers');
      checkInt(b.usage, 0, 0xff, 'key usage');
      break;
    case 'consumer':
      checkInt(b.usage, 0, 0xffff, 'consumer usage');
      break;
    case 'function':
      if (typeof b.fn === 'number') checkInt(b.fn, 0, 0xff, 'function');
      checkInt(b.data ?? 0, 0, 0xff, 'function data');
      break;
    case 'software-only':
      checkInt(b.ref, 0, 1, 'software-only reference');
      break;
    case 'macro':
      checkInt(b.sector, 1, 0x0fff, 'macro sector');
      checkInt(b.offset, 0, 0xffff, 'macro offset');
      break;
    case 'raw':
      if (b.bytes.length !== 4) throw new RangeError('a raw binding is 4 bytes');
      b.bytes.forEach((x) => checkInt(x, 0, 0xff, 'binding byte'));
      break;
  }
  switch (b.type) {
    case 'unassigned':
      return [0xff, 0xff, 0xff, 0xff];
    case 'disabled':
      return [0x90, 0x00, 0x00, 0x00];
    case 'software-only':
      return [0x00, b.ref & 0xff, 0x00, 0x00];
    case 'mouse':
      return [0x80, 0x01, (b.buttons >> 8) & 0xff, b.buttons & 0xff];
    case 'key':
      return [0x80, 0x02, b.modifiers & 0xff, b.usage & 0xff];
    case 'consumer':
      return [0x80, 0x03, (b.usage >> 8) & 0xff, b.usage & 0xff];
    case 'function': {
      const fn = typeof b.fn === 'number' ? b.fn : ButtonFunction[b.fn];
      if (fn === undefined) throw new RangeError(`unknown button function ${String(b.fn)}`);
      return [0x90, fn, 0x00, b.data ?? 0];
    }
    case 'macro':
      return [(b.sector >> 8) & 0x0f, b.sector & 0xff, (b.offset >> 8) & 0xff, b.offset & 0xff];
    case 'raw':
      return b.bytes.slice(0, 4);
  }
}

// ------------------------------------------------------------------ LED effects (11 bytes each)

/** Effect ids in the first byte of an LED slot. */
export const EffectId = { off: 0x00, fixed: 0x01, cycle: 0x03, wave: 0x04, breathing: 0x0a, signatureActive: 0x0f, signatureInactive: 0x10 } as const;

/** Colour-wave directions G Hub offers for this mouse (Solaar's table has the rest). */
export const WaveDirection = { horizontal: 1, 'reverse-horizontal': 6 } as const;

export type LedEffect =
  | { type: 'off' }
  /** 01 R G B 02 */
  | { type: 'fixed'; color: Rgb }
  /** 03 00x5 PERIOD(u16 BE) BRIGHTNESS */
  | { type: 'cycle'; periodMs: number; brightness: number }
  /** 04 00x6 PERIOD.lo DIRECTION BRIGHTNESS PERIOD.hi (yes, the period is split) */
  | { type: 'wave'; periodMs: number; direction: number; brightness: number }
  /** 0A R G B PERIOD(u16 BE) WAVEFORM BRIGHTNESS */
  | { type: 'breathing'; color: Rgb; periodMs: number; waveform: number; brightness: number }
  /**
   * 0F (active) / 10 (inactive) 00x5 FRAME(u16 BE) BRIGHTNESS: Logitech's built-in animations.
   * G Hub calls 0F "Pulsar Point" (SIGNATURE_FRAME_ACTIVE) and 10 "Neutron Null" (inactive).
   */
  | { type: 'signature'; variant: 'active' | 'inactive'; frameMs: number; brightness: number }
  | { type: 'raw'; bytes: number[] };

export function decodeEffect(b: ArrayLike<number>): LedEffect {
  const p = Array.from(b).slice(0, 11);
  switch (p[0]) {
    case EffectId.off:
      return { type: 'off' };
    case EffectId.fixed:
      return { type: 'fixed', color: [p[1], p[2], p[3]] };
    case EffectId.cycle:
      return { type: 'cycle', periodMs: (p[6] << 8) | p[7], brightness: p[8] };
    case EffectId.wave:
      return { type: 'wave', periodMs: (p[10] << 8) | p[7], direction: p[8], brightness: p[9] };
    case EffectId.breathing:
      return { type: 'breathing', color: [p[1], p[2], p[3]], periodMs: (p[4] << 8) | p[5], waveform: p[6], brightness: p[7] };
    case EffectId.signatureActive:
    case EffectId.signatureInactive:
      return { type: 'signature', variant: p[0] === EffectId.signatureActive ? 'active' : 'inactive', frameMs: (p[6] << 8) | p[7], brightness: p[8] };
    default:
      return { type: 'raw', bytes: p };
  }
}

/** Range-check an effect before it is written (brightness is a percentage, 0 = firmware default). */
export function validateEffect(e: LedEffect): void {
  const color = (c: Rgb) => {
    if (!Array.isArray(c) || c.length !== 3) throw new RangeError('a colour is [r, g, b]');
    c.forEach((v) => checkInt(v, 0, 255, 'colour channel'));
  };
  switch (e.type) {
    case 'fixed':
      color(e.color);
      break;
    case 'cycle':
      checkInt(e.periodMs, 0, 0xffff, 'period (ms)');
      checkInt(e.brightness, 0, 100, 'brightness (%)');
      break;
    case 'wave':
      checkInt(e.periodMs, 0, 0xffff, 'period (ms)');
      checkInt(e.direction, 0, 0xff, 'direction');
      checkInt(e.brightness, 0, 100, 'brightness (%)');
      break;
    case 'breathing':
      color(e.color);
      checkInt(e.periodMs, 0, 0xffff, 'period (ms)');
      checkInt(e.waveform, 0, 0xff, 'waveform');
      checkInt(e.brightness, 0, 100, 'brightness (%)');
      break;
    case 'signature':
      if (e.variant !== 'active' && e.variant !== 'inactive') throw new RangeError('signature variant is active or inactive');
      checkInt(e.frameMs, 0, 0xffff, 'frame time (ms)');
      checkInt(e.brightness, 0, 100, 'brightness (%)');
      break;
    case 'raw':
      if (e.bytes.length !== 11) throw new RangeError('a raw effect is 11 bytes');
      e.bytes.forEach((x) => checkInt(x, 0, 0xff, 'effect byte'));
      break;
    case 'off':
      break;
    default:
      throw new RangeError(`unknown effect type ${String((e as { type: unknown }).type)}`);
  }
}

export function encodeEffect(e: LedEffect): number[] {
  validateEffect(e);
  const p = new Array<number>(11).fill(0);
  switch (e.type) {
    case 'off':
      break;
    case 'fixed':
      p[0] = EffectId.fixed;
      [p[1], p[2], p[3]] = e.color;
      p[4] = 0x02;
      break;
    case 'cycle':
      p[0] = EffectId.cycle;
      p[6] = (e.periodMs >> 8) & 0xff;
      p[7] = e.periodMs & 0xff;
      p[8] = e.brightness;
      break;
    case 'wave':
      p[0] = EffectId.wave;
      p[7] = e.periodMs & 0xff;
      p[8] = e.direction;
      p[9] = e.brightness;
      p[10] = (e.periodMs >> 8) & 0xff;
      break;
    case 'breathing':
      p[0] = EffectId.breathing;
      [p[1], p[2], p[3]] = e.color;
      p[4] = (e.periodMs >> 8) & 0xff;
      p[5] = e.periodMs & 0xff;
      p[6] = e.waveform;
      p[7] = e.brightness;
      break;
    case 'signature':
      p[0] = e.variant === 'active' ? EffectId.signatureActive : EffectId.signatureInactive;
      p[6] = (e.frameMs >> 8) & 0xff;
      p[7] = e.frameMs & 0xff;
      p[8] = e.brightness;
      break;
    case 'raw':
      return [...e.bytes, ...p].slice(0, 11);
  }
  return p;
}

// ------------------------------------------------------------------ profiles

/**
 * Lighting of a profile. The mouse has two LED slots: `all` drives every LED (colour wave and the
 * signature animations live here) and `primary` drives the primary zone (fixed, cycle,
 * breathing). G Hub sets one and turns the other off. `inactive` is what the mouse shows after
 * `dimAfterSeconds` without input.
 */
export interface ProfileLighting {
  active: { all: LedEffect; primary: LedEffect };
  inactive: { all: LedEffect; primary: LedEffect };
}

export interface Profile {
  /** Report interval in ms: 1, 2, 4 or 8 (1000, 500, 250, 125 Hz). */
  reportRateMs: number;
  /** Up to five DPI levels; G Hub drops deleted levels. */
  dpiLevels: number[];
  /** Index into dpiLevels the profile starts at. */
  defaultDpiIndex: number;
  /** Index into dpiLevels used while the DPI-shift (sniper) button is held. */
  shiftDpiIndex: number;
  /** Bindings for the mouse's controls, in onboard order (see G502X_CONTROLS). */
  buttons: Binding[];
  /** The same controls while G-Shift is held. */
  gshift: Binding[];
  /** Profile name, or null when unset (all 0xFF). */
  name: string | null;
  lighting: ProfileLighting;
  /** Seconds without input before the inactive lighting shows; null = never. */
  dimAfterSeconds: number | null;
  /** Seconds without input before all LEDs turn off; null = never. */
  lightsOffAfterSeconds: number | null;
  angleSnapping: boolean;
  /** The original sector bytes; encodeProfile patches these. */
  raw: Uint8Array;
}

const O = {
  reportRate: 0,
  defaultDpi: 1,
  shiftDpi: 2,
  dpi: 3, // 5 x u16 LE
  color: 13,
  powerMode: 16,
  angleSnapping: 17,
  dimAfter: 28, // u16 LE seconds, FFFF = never
  lightsOff: 30, // u16 LE seconds, FFFF = never
  buttons: 32,
  gshift: 96,
  name: 160, // 48 bytes UTF-16LE
  leds: 208, // 4 x 11: active all, active primary, inactive all, inactive primary
  ledFlags: 252,
} as const;
const DPI_SLOTS = 5;

const le16 = (p: Uint8Array, i: number) => p[i] | (p[i + 1] << 8);
const setLe16 = (p: Uint8Array, i: number, v: number) => {
  p[i] = v & 0xff;
  p[i + 1] = (v >> 8) & 0xff;
};

export function decodeProfile(sector: Uint8Array, buttonCount = 13): Profile {
  const dpiRaw = [...Array(DPI_SLOTS).keys()].map((k) => le16(sector, O.dpi + 2 * k));
  const dpiLevels = dpiRaw.filter((d) => d !== 0 && d !== 0xffff);
  const binding = (base: number, k: number) => decodeBinding(sector.slice(base + 4 * k, base + 4 * k + 4));
  const timeout = (i: number) => {
    const v = le16(sector, i);
    return v === 0xffff ? null : v;
  };
  const led = (k: number) => decodeEffect(sector.slice(O.leds + 11 * k, O.leds + 11 * k + 11));
  return {
    reportRateMs: sector[O.reportRate],
    dpiLevels,
    defaultDpiIndex: sector[O.defaultDpi],
    shiftDpiIndex: sector[O.shiftDpi],
    buttons: [...Array(buttonCount).keys()].map((k) => binding(O.buttons, k)),
    gshift: [...Array(buttonCount).keys()].map((k) => binding(O.gshift, k)),
    name: decodeName(sector.slice(O.name, O.name + 2 * NAME_LENGTH)),
    lighting: { active: { all: led(0), primary: led(1) }, inactive: { all: led(2), primary: led(3) } },
    dimAfterSeconds: timeout(O.dimAfter),
    lightsOffAfterSeconds: timeout(O.lightsOff),
    angleSnapping: sector[O.angleSnapping] === 1,
    raw: Uint8Array.from(sector),
  };
}

export function decodeName(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xff) return null;
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    const c = b[i] | (b[i + 1] << 8);
    if (c === 0 || c === 0xffff) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function encodeName(name: string | null): number[] {
  if (name === null) return new Array(2 * NAME_LENGTH).fill(0xff);
  if (name.length > NAME_LENGTH) throw new RangeError(`profile names are at most ${NAME_LENGTH} characters`);
  const out = new Array<number>(2 * NAME_LENGTH).fill(0);
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    out[2 * i] = c & 0xff;
    out[2 * i + 1] = c >> 8;
  }
  return out;
}

/**
 * Byte 252: bit 0 = the active lighting uses the `all` LED slot, bit 1 = the inactive lighting
 * does. G Hub writes it from the effects; the firmware uses it to pick which slot drives the LEDs.
 */
export function ledFlags(l: ProfileLighting): number {
  return (l.active.all.type !== 'off' ? 1 : 0) | (l.inactive.all.type !== 'off' ? 2 : 0);
}

export function encodeProfile(p: Profile): Uint8Array {
  const s = Uint8Array.from(p.raw);
  if (s.length !== SECTOR_SIZE) throw new RangeError(`profile sector must be ${SECTOR_SIZE} bytes`);
  if (p.dpiLevels.length < 1 || p.dpiLevels.length > DPI_SLOTS) throw new RangeError(`1..${DPI_SLOTS} DPI levels required`);
  p.dpiLevels.forEach((d) => checkInt(d, 1, 0xfffe, 'DPI'));
  checkInt(p.defaultDpiIndex, 0, p.dpiLevels.length - 1, 'default DPI index');
  checkInt(p.shiftDpiIndex, 0, p.dpiLevels.length - 1, 'shift DPI index');
  checkInt(p.reportRateMs, 1, 255, 'report interval (ms)');
  // FFFF means never, so the longest storable timeout is 65534 s.
  if (p.dimAfterSeconds !== null) checkInt(p.dimAfterSeconds, 0, 0xfffe, 'dim-after (s)');
  if (p.lightsOffAfterSeconds !== null) checkInt(p.lightsOffAfterSeconds, 0, 0xfffe, 'lights-off-after (s)');
  if (p.buttons.length > BUTTON_SLOTS || p.gshift.length > BUTTON_SLOTS) throw new RangeError(`at most ${BUTTON_SLOTS} buttons`);
  s[O.reportRate] = p.reportRateMs;
  s[O.defaultDpi] = p.defaultDpiIndex;
  s[O.shiftDpi] = p.shiftDpiIndex;
  for (let k = 0; k < DPI_SLOTS; k++) setLe16(s, O.dpi + 2 * k, p.dpiLevels[k] ?? 0);
  s[O.angleSnapping] = p.angleSnapping ? 1 : 0;
  setLe16(s, O.dimAfter, p.dimAfterSeconds ?? 0xffff);
  setLe16(s, O.lightsOff, p.lightsOffAfterSeconds ?? 0xffff);
  p.buttons.forEach((b, k) => s.set(encodeBinding(b), O.buttons + 4 * k));
  p.gshift.forEach((b, k) => s.set(encodeBinding(b), O.gshift + 4 * k));
  s.set(encodeName(p.name), O.name);
  const l = p.lighting;
  [l.active.all, l.active.primary, l.inactive.all, l.inactive.primary].forEach((e, k) => s.set(encodeEffect(e), O.leds + 11 * k));
  s[O.ledFlags] = ledFlags(l);
  return withCrc(s);
}

// ------------------------------------------------------------------ macros (format 1)

/**
 * Macro opcodes (libratbag calls this the G402 format). A macro is a byte stream in its own
 * sector, ended by FF; a binding of type 'macro' points at it.
 */
export type MacroStep =
  | { op: 'key-down'; modifiers: number; usage: number } // 43 MOD KEY
  | { op: 'key-up'; modifiers: number; usage: number } // 44 MOD KEY
  | { op: 'buttons-down'; buttons: number } // 41 MASK(u16 BE)
  | { op: 'buttons-up'; buttons: number } // 42 MASK(u16 BE)
  | { op: 'consumer-down'; usage: number } // 45 USAGE(u16 BE)
  | { op: 'consumer-up'; usage: number } // 46 USAGE(u16 BE)
  | { op: 'delay'; ms: number } // 40 MS(u16 BE)
  | { op: 'wheel'; delta: number } // 20 DELTA(i8)
  | { op: 'hwheel'; delta: number } // 21 DELTA(i8)
  | { op: 'move'; x: number; y: number } // 61 X(i16 BE) Y(i16 BE)
  | { op: 'wait-for-release' } // 01
  | { op: 'repeat-while-pressed' } // 02
  | { op: 'repeat-until-cancelled' } // 03
  | { op: 'noop' }; // 00

const i8 = (v: number) => (v << 24) >> 24;
const i16 = (v: number) => (v << 16) >> 16;

export function decodeMacro(bytes: ArrayLike<number>, offset = 0): MacroStep[] {
  const b = Array.from(bytes);
  const out: MacroStep[] = [];
  let i = offset;
  while (i < b.length) {
    const op = b[i];
    const u = (k: number) => (b[i + k] << 8) | b[i + k + 1];
    switch (op) {
      case 0xff:
        return out;
      case 0x00: out.push({ op: 'noop' }); i += 1; break;
      case 0x01: out.push({ op: 'wait-for-release' }); i += 1; break;
      case 0x02: out.push({ op: 'repeat-while-pressed' }); i += 1; break;
      case 0x03: out.push({ op: 'repeat-until-cancelled' }); i += 1; break;
      case 0x20: out.push({ op: 'wheel', delta: i8(b[i + 1]) }); i += 2; break;
      case 0x21: out.push({ op: 'hwheel', delta: i8(b[i + 1]) }); i += 2; break;
      case 0x40: out.push({ op: 'delay', ms: u(1) }); i += 3; break;
      case 0x41: out.push({ op: 'buttons-down', buttons: u(1) }); i += 3; break;
      case 0x42: out.push({ op: 'buttons-up', buttons: u(1) }); i += 3; break;
      case 0x43: out.push({ op: 'key-down', modifiers: b[i + 1], usage: b[i + 2] }); i += 3; break;
      case 0x44: out.push({ op: 'key-up', modifiers: b[i + 1], usage: b[i + 2] }); i += 3; break;
      case 0x45: out.push({ op: 'consumer-down', usage: u(1) }); i += 3; break;
      case 0x46: out.push({ op: 'consumer-up', usage: u(1) }); i += 3; break;
      case 0x61: out.push({ op: 'move', x: i16(u(1)), y: i16(u(3)) }); i += 5; break;
      default:
        throw new Error(`unknown macro opcode 0x${op.toString(16)} at offset ${i}`);
    }
  }
  throw new Error('macro is not terminated (no FF before the end of the sector)');
}

export function encodeMacro(steps: MacroStep[]): number[] {
  const out: number[] = [];
  const be = (v: number) => [(v >> 8) & 0xff, v & 0xff];
  for (const s of steps) {
    switch (s.op) {
      case 'noop': out.push(0x00); break;
      case 'wait-for-release': out.push(0x01); break;
      case 'repeat-while-pressed': out.push(0x02); break;
      case 'repeat-until-cancelled': out.push(0x03); break;
      case 'wheel': out.push(0x20, s.delta & 0xff); break;
      case 'hwheel': out.push(0x21, s.delta & 0xff); break;
      case 'delay': out.push(0x40, ...be(s.ms)); break;
      case 'buttons-down': out.push(0x41, ...be(s.buttons)); break;
      case 'buttons-up': out.push(0x42, ...be(s.buttons)); break;
      case 'key-down': out.push(0x43, s.modifiers, s.usage); break;
      case 'key-up': out.push(0x44, s.modifiers, s.usage); break;
      case 'consumer-down': out.push(0x45, ...be(s.usage)); break;
      case 'consumer-up': out.push(0x46, ...be(s.usage)); break;
      case 'move': out.push(0x61, ...be(s.x & 0xffff), ...be(s.y & 0xffff)); break;
    }
  }
  out.push(0xff);
  return out;
}

/** A sector holding one macro at offset 0, padded with FF and checksummed. */
export function macroSector(steps: MacroStep[], size = SECTOR_SIZE): Uint8Array {
  const bytes = encodeMacro(steps);
  if (bytes.length > size - 2) throw new RangeError(`macro is ${bytes.length} bytes; a sector holds ${size - 2}`);
  const s = new Uint8Array(size).fill(0xff);
  s.set(bytes, 0);
  return withCrc(s);
}

// ------------------------------------------------------------------ the G502 X PLUS's controls

/**
 * Onboard button order. `ghub` is G Hub's slot id (g502x-plus_<id>_m1) and `label` is what G Hub
 * prints next to the control. The defaults are the factory bindings.
 */
export const G502X_CONTROLS = [
  { id: 'left', ghub: 'g1', label: 'Primary Click', where: 'left button' },
  { id: 'right', ghub: 'g2', label: 'Secondary Click', where: 'right button' },
  { id: 'middle', ghub: 'g3', label: 'Middle Click', where: 'wheel click' },
  { id: 'back', ghub: 'g4', label: 'Back', where: 'rear thumb button' },
  { id: 'sniper', ghub: 'g5', label: 'DPI Shift', where: 'front thumb (sniper) button' },
  { id: 'forward', ghub: 'g6', label: 'Forward', where: 'middle thumb button' },
  { id: 'tilt-left', ghub: 'g7', label: 'Scroll Left', where: 'wheel tilt left' },
  { id: 'tilt-right', ghub: 'g8', label: 'Scroll Right', where: 'wheel tilt right' },
  { id: 'g9', ghub: 'g9', label: 'Onboard Profile Cycle', where: 'button behind the wheel' },
  { id: 'dpi-up', ghub: 'g10', label: 'DPI Up', where: 'upper button left of the left click (printed G8)' },
  { id: 'dpi-down', ghub: 'g11', label: 'DPI Down', where: 'lower button left of the left click (printed G7)' },
  { id: 'wheel-down', ghub: 'scroll2', label: 'Scroll Down', where: 'wheel down' },
  { id: 'wheel-up', ghub: 'scroll1', label: 'Scroll Up', where: 'wheel up' },
] as const;
export type ControlId = (typeof G502X_CONTROLS)[number]['id'];

export const controlIndex = (id: ControlId | string): number => {
  const i = G502X_CONTROLS.findIndex((c) => c.id === id || c.ghub === id);
  if (i < 0) throw new RangeError(`unknown control '${id}'; one of ${G502X_CONTROLS.map((c) => c.id).join(', ')}`);
  return i;
};
