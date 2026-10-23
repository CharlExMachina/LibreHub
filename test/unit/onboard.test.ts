import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../../src/mouse/hidpp.js';
import {
  crc16,
  decodeBinding,
  decodeDirectory,
  decodeEffect,
  decodeMacro,
  decodeProfile,
  encodeBinding,
  encodeDirectory,
  encodeEffect,
  encodeMacro,
  encodeProfile,
  G502X_CONTROLS,
  macroSector,
  Modifier,
  sectorCrcOk,
  type Binding,
  type MacroStep,
  type Profile,
} from '../../src/mouse/onboard.js';
import { SECTORS } from '../fixtures/g502x-sectors.js';

const sector = (k: keyof typeof SECTORS) => fromHex(SECTORS[k]);
const WRITTEN = ['ghubAssignments', 'directory', 'profile1', 'profile2', 'profile3', 'profile4', 'profile5', 'directoryAfterGhubEnable', 'ghubFixed', 'ghubWaveDim', 'ghubWaveNeutron', 'ghubCycle', 'ghubWave18500'] as const;
const PROFILES = ['profile1', 'profile2', 'profile3', 'profile4', 'profile5', 'ghubFixed', 'ghubWaveDim', 'ghubWaveNeutron', 'ghubCycle', 'ghubWave18500'] as const;

// G Hub's default assignments, in onboard order (left, right, middle, back, sniper, forward,
// tilt left, tilt right, G9, DPI up, DPI down, wheel down, wheel up).
const GHUB_DEFAULT_BUTTONS: Binding[] = [
  { type: 'mouse', buttons: 1 },
  { type: 'mouse', buttons: 2 },
  { type: 'mouse', buttons: 4 },
  { type: 'mouse', buttons: 8 },
  { type: 'function', fn: 'dpi-shift' },
  { type: 'mouse', buttons: 16 },
  { type: 'function', fn: 'wheel-left' },
  { type: 'function', fn: 'wheel-right' },
  { type: 'function', fn: 'profile-cycle' },
  { type: 'function', fn: 'dpi-up' },
  { type: 'function', fn: 'dpi-down' },
  { type: 'function', fn: 'scroll-down' },
  { type: 'function', fn: 'scroll-up' },
];

describe('sector checksums', () => {
  it('CRC-16/CCITT of a known vector', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1);
  });

  it.each(WRITTEN)('%s carries a valid CRC', (k) => {
    expect(sectorCrcOk(sector(k))).toBe(true);
  });

  it('factory (ROM) sectors leave the CRC bytes erased', () => {
    expect(toHex(sector('romProfile1').slice(253))).toBe('ff ff');
  });
});

describe('directory', () => {
  it('decodes the five profile slots', () => {
    expect(decodeDirectory(sector('directory'))).toEqual([
      { sector: 1, enabled: true },
      { sector: 2, enabled: true },
      { sector: 3, enabled: false },
      { sector: 4, enabled: false },
      { sector: 5, enabled: false },
    ]);
  });

  it('re-encodes byte for byte, and reproduces the sector G Hub wrote when it enabled slot 3', () => {
    const entries = decodeDirectory(sector('directory'));
    expect(toHex(encodeDirectory(entries))).toBe(SECTORS.directory);
    entries[2].enabled = true;
    expect(toHex(encodeDirectory(entries))).toBe(SECTORS.directoryAfterGhubEnable);
  });
});

describe('profiles', () => {
  it.each(PROFILES)('%s survives decode -> encode unchanged', (k) => {
    expect(toHex(encodeProfile(decodeProfile(sector(k))))).toBe(SECTORS[k]);
  });

  it('decodes profile 1 the way G Hub reports it (/onboard_profiles/<id>/profiles)', () => {
    const p = decodeProfile(sector('profile1'));
    expect(p.reportRateMs).toBe(1); // reportRate.value 1000
    expect(p.dpiLevels).toEqual([800, 1200, 2100, 2400, 3200]);
    expect(p.dpiLevels[p.defaultDpiIndex]).toBe(2100); // defaultDpi
    expect(p.dpiLevels[p.shiftDpiIndex]).toBe(800); // shiftDpi
    expect(p.name).toBe('PROFILE_NAME_DEFAULT');
    expect(p.buttons).toEqual(GHUB_DEFAULT_BUTTONS);
    expect(p.lighting.active.all).toEqual({ type: 'signature', variant: 'active', frameMs: 32, brightness: 100 });
    expect(p.lighting.active.primary).toEqual({ type: 'off' });
    expect(p.lighting.inactive.all).toEqual({ type: 'signature', variant: 'inactive', frameMs: 32, brightness: 100 });
    expect(p.dimAfterSeconds).toBe(60);
    expect(p.lightsOffAfterSeconds).toBe(300);
  });

  it('decodes the factory G-Shift layer of profile 2', () => {
    const p = decodeProfile(sector('profile2'));
    expect(p.buttons[4]).toEqual({ type: 'function', fn: 'g-shift' });
    expect(p.name).toBeNull();
    const ctrl = Modifier.lctrl;
    expect(p.gshift).toEqual([
      { type: 'mouse', buttons: 1 },
      { type: 'mouse', buttons: 2 },
      { type: 'key', modifiers: ctrl, usage: 0x17 }, // Ctrl+T
      { type: 'mouse', buttons: 8 },
      { type: 'unassigned' }, // the G-Shift button itself
      { type: 'mouse', buttons: 16 },
      { type: 'key', modifiers: ctrl | Modifier.lshift, usage: 0x2b }, // Ctrl+Shift+Tab
      { type: 'key', modifiers: ctrl, usage: 0x2b }, // Ctrl+Tab
      { type: 'key', modifiers: ctrl, usage: 0x27 }, // Ctrl+0
      { type: 'key', modifiers: ctrl, usage: 0x1d }, // Ctrl+Z
      { type: 'key', modifiers: ctrl, usage: 0x1b }, // Ctrl+X
      { type: 'consumer', usage: 0xea }, // Volume Down
      { type: 'consumer', usage: 0xe9 }, // Volume Up
    ]);
  });

  it('decodes what G Hub writes for Disable and for assignments it can only do in software', () => {
    const b = decodeProfile(sector('ghubAssignments')).buttons;
    expect(b[8]).toEqual({ type: 'disabled' }); // G9 -> DISABLE
    expect(b[2]).toEqual({ type: 'software-only', ref: 1 }); // Double Click
    expect(b[6]).toEqual({ type: 'software-only', ref: 0 }); // a G Hub macro
    expect(b[7]).toEqual({ type: 'software-only', ref: 1 }); // Go to DPI Shift
    expect(b[10]).toEqual({ type: 'disabled' }); // Cycle Maximum Brightness: not storable
    expect(toHex(encodeProfile(decodeProfile(sector('ghubAssignments'))))).toBe(SECTORS.ghubAssignments);
  });

  it('factory profiles leave the scroll wheel unassigned (native scrolling)', () => {
    const p = decodeProfile(sector('profile3'));
    expect(p.buttons.slice(11)).toEqual([{ type: 'unassigned' }, { type: 'unassigned' }]);
  });

  it('reproduces, from the factory profile, the exact sector G Hub wrote for its default profile', () => {
    // What G Hub wrote into slot 3 for "Desktop: Default" with LIGHTSYNC = FIXED (cyan).
    const p: Profile = decodeProfile(sector('romProfile1'));
    p.buttons = [...GHUB_DEFAULT_BUTTONS];
    p.gshift = [...GHUB_DEFAULT_BUTTONS];
    p.name = 'PROFILE_NAME_DEFAULT';
    p.lighting = {
      active: { all: { type: 'off' }, primary: { type: 'fixed', color: [0, 255, 255] } },
      inactive: { all: { type: 'off' }, primary: { type: 'breathing', color: [0, 255, 255], periodMs: 5000, waveform: 0, brightness: 100 } },
    };
    expect(toHex(encodeProfile(p))).toBe(SECTORS.ghubFixed);
  });

  it('decodes every lighting variant G Hub wrote', () => {
    const l = (k: keyof typeof SECTORS) => decodeProfile(sector(k)).lighting;
    expect(l('ghubWaveDim').active.all).toEqual({ type: 'wave', periodMs: 5000, direction: 1, brightness: 100 });
    expect(l('ghubWaveDim').inactive.all).toEqual({ type: 'wave', periodMs: 5000, direction: 1, brightness: 50 });
    expect(l('ghubWaveNeutron').active.all).toEqual({ type: 'wave', periodMs: 5000, direction: 6, brightness: 80 });
    expect(l('ghubWaveNeutron').inactive.all).toEqual({ type: 'signature', variant: 'inactive', frameMs: 32, brightness: 100 });
    expect(l('ghubCycle').active.primary).toEqual({ type: 'cycle', periodMs: 11000, brightness: 50 });
    expect(l('ghubCycle').inactive.primary).toEqual({ type: 'breathing', color: [0, 255, 255], periodMs: 5000, waveform: 0, brightness: 100 });
    expect(l('ghubWave18500').active.all).toEqual({ type: 'wave', periodMs: 18500, direction: 1, brightness: 50 });
  });

  it('decodes the inactivity timers G Hub offers (1, 2, 5, 15 min, never)', () => {
    const t = (k: keyof typeof SECTORS) => {
      const p = decodeProfile(sector(k));
      return [p.dimAfterSeconds, p.lightsOffAfterSeconds];
    };
    expect(t('ghubFixed')).toEqual([60, 300]);
    expect(t('ghubWaveDim')).toEqual([120, null]);
    expect(t('ghubWaveNeutron')).toEqual([300, 900]);
  });

  it('sets the LED-slot flag byte the way G Hub does', () => {
    // bit 0: active lighting uses the "all" slot, bit 1: inactive lighting does.
    expect(['ghubFixed', 'ghubCycle', 'ghubWaveDim', 'ghubWaveNeutron', 'ghubWave18500', 'profile1'].map((k) => fromHex(SECTORS[k as keyof typeof SECTORS])[252])).toEqual([0, 0, 3, 3, 1, 3]);
  });

  it('rejects impossible profiles instead of writing them', () => {
    const p = decodeProfile(sector('profile1'));
    expect(() => encodeProfile({ ...p, dpiLevels: [] })).toThrow(RangeError);
    expect(() => encodeProfile({ ...p, defaultDpiIndex: 5 })).toThrow(RangeError);
    expect(() => encodeProfile({ ...p, name: 'x'.repeat(25) })).toThrow(RangeError);
  });

  it('stores fewer than five DPI levels as zeros, the way deleted levels are read back', () => {
    const p = decodeProfile(sector('profile1'));
    const out = decodeProfile(encodeProfile({ ...p, dpiLevels: [400, 800, 1600], defaultDpiIndex: 1, shiftDpiIndex: 0 }));
    expect(out.dpiLevels).toEqual([400, 800, 1600]);
    expect(out.dpiLevels[out.defaultDpiIndex]).toBe(800);
  });
});

describe('bindings', () => {
  const cases: [Binding, string][] = [
    [{ type: 'mouse', buttons: 1 }, '80 01 00 01'],
    [{ type: 'key', modifiers: Modifier.lctrl | Modifier.lshift, usage: 0x2b }, '80 02 03 2b'],
    [{ type: 'consumer', usage: 0xe9 }, '80 03 00 e9'],
    [{ type: 'function', fn: 'dpi-shift' }, '90 07 00 00'],
    [{ type: 'function', fn: 'g-shift' }, '90 0b 00 00'],
    [{ type: 'unassigned' }, 'ff ff ff ff'],
    [{ type: 'disabled' }, '90 00 00 00'],
    [{ type: 'software-only', ref: 0 }, '00 00 00 00'],
    [{ type: 'software-only', ref: 1 }, '00 01 00 00'],
    [{ type: 'macro', sector: 6, offset: 0 }, '00 06 00 00'],
  ];
  it.each(cases)('%j <-> %s', (b, hex) => {
    expect(toHex(encodeBinding(b))).toBe(hex);
    expect(decodeBinding(fromHex(hex))).toEqual(b);
  });

  it('lists the 13 controls in onboard order with G Hub slot ids', () => {
    expect(G502X_CONTROLS.map((c) => c.ghub)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10', 'g11', 'scroll2', 'scroll1']);
  });
});

describe('lighting effects', () => {
  it.each([
    ['01 00 ff ff 02 00 00 00 00 00 00', { type: 'fixed', color: [0, 255, 255] }],
    ['03 00 00 00 00 00 2a f8 32 00 00', { type: 'cycle', periodMs: 11000, brightness: 50 }],
    ['04 00 00 00 00 00 00 44 01 32 48', { type: 'wave', periodMs: 18500, direction: 1, brightness: 50 }],
    ['0a 00 ff ff 13 88 00 64 00 00 00', { type: 'breathing', color: [0, 255, 255], periodMs: 5000, waveform: 0, brightness: 100 }],
    ['0f 00 00 00 00 00 00 20 64 00 00', { type: 'signature', variant: 'active', frameMs: 32, brightness: 100 }],
    ['00 00 00 00 00 00 00 00 00 00 00', { type: 'off' }],
  ])('%s', (hex, effect) => {
    expect(decodeEffect(fromHex(hex))).toEqual(effect);
    expect(toHex(encodeEffect(effect as never))).toBe(hex);
  });

  it('keeps unknown effects verbatim', () => {
    const hex = '13 01 00 00 00 00 00 00 00 00 00';
    expect(toHex(encodeEffect(decodeEffect(fromHex(hex))))).toBe(hex);
  });
});

describe('macros', () => {
  const steps: MacroStep[] = [
    { op: 'key-down', modifiers: Modifier.lctrl, usage: 0x06 },
    { op: 'delay', ms: 50 },
    { op: 'key-up', modifiers: Modifier.lctrl, usage: 0x06 },
    { op: 'consumer-down', usage: 0xcd },
    { op: 'consumer-up', usage: 0xcd },
    { op: 'buttons-down', buttons: 1 },
    { op: 'buttons-up', buttons: 1 },
    { op: 'wheel', delta: -3 },
    { op: 'move', x: -10, y: 300 },
  ];

  it('encodes the documented opcodes', () => {
    expect(toHex(encodeMacro(steps))).toBe('43 01 06 40 00 32 44 01 06 45 00 cd 46 00 cd 41 00 01 42 00 01 20 fd 61 ff f6 01 2c ff');
  });

  it('round-trips through a checksummed sector', () => {
    const s = macroSector(steps);
    expect(sectorCrcOk(s)).toBe(true);
    expect(decodeMacro(s)).toEqual(steps);
  });

  it('rejects a stream with no terminator', () => {
    expect(() => decodeMacro([0x40, 0x00, 0x10])).toThrow(/not terminated/);
  });
});
