import { describe, expect, it } from 'vitest';
import { G502X, MouseUnavailableError } from '../../src/mouse/g502x.js';
import { fromHex, toHex } from '../../src/mouse/hidpp.js';
import { decodeProfile, encodeProfile, Modifier } from '../../src/mouse/onboard.js';
import { parseEffect } from '../../src/mouse/presets.js';
import { MouseService } from '../../src/mouse/service.js';
import { parseBinding } from '../../src/mouse/usages.js';
import { runCli } from '../../src/mouse/cli.js';
import { SECTORS } from '../fixtures/g502x-sectors.js';
import { FEATURE_TABLE, SimulatedG502X } from './simulated-g502x.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoftwareAgent } from '../../src/mouse/agent.js';
import { decodeMacro } from '../../src/mouse/onboard.js';
import { SoftwareStore, type SoftwareAction } from '../../src/mouse/software.js';

// The CLI keeps software actions in a settings file; never touch the real one from tests.
process.env.G502X_CONFIG = join(mkdtempSync(join(tmpdir(), 'g502x-cli-')), 'g502x.json');
const tempStore = () => new SoftwareStore(join(mkdtempSync(join(tmpdir(), 'g502x-')), 'g502x.json'));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const sim = new SimulatedG502X();
  const mouse = await G502X.connect(sim, { timeoutMs: 200 });
  return { sim, mouse, svc: new MouseService(mouse) };
}

/** Requests sent after `from`, as [featureId, fn, params hex]. */
const sent = (sim: SimulatedG502X, from = 0) =>
  sim.written.slice(from).filter((r) => r[0] === 0x11).map((r) => [FEATURE_TABLE[r[2]], r[3] >> 4, toHex(r.slice(4, 10))] as const);

describe('connecting', () => {
  it('finds the mouse in the receiver pairing table and reads the feature table', async () => {
    const { sim, mouse } = await setup();
    expect(mouse.deviceIndex).toBe(1);
    expect(sim.written[0].slice(0, 5)).toEqual(Uint8Array.from([0x10, 0xff, 0x83, 0xb5, 0x20]));
    expect(mouse.features.map((f) => f.id)).toEqual(FEATURE_TABLE);
    expect(await mouse.getInfo()).toMatchObject({
      name: 'G502 X PLUS',
      serial: '1234567890',
      firmware: [
        { type: 'bootloader', name: 'BL142', version: '42.0.16' },
        { type: 'application', name: 'MPM27', version: '27.0.16' },
      ],
    });
  });

  it('waits for a sleeping mouse when asked to, and says so when not', async () => {
    const { sim, mouse } = await setup();
    sim.asleepFor = 2;
    await expect(mouse.getBattery()).rejects.toBeInstanceOf(MouseUnavailableError);
    const patient = await G502X.connect(sim, { timeoutMs: 200, wakeTimeoutMs: 5000 });
    const waits: string[] = [];
    patient.on('waiting', (w) => waits.push(w));
    sim.asleepFor = 2;
    expect((await patient.getBattery()).percent).toBe(36);
    expect(waits.length).toBe(2);
  });
});

describe('onboard memory', () => {
  it('reads the directory and all five profiles', async () => {
    const { mouse } = await setup();
    const profiles = await mouse.readProfiles();
    expect(profiles.map((p) => p.enabled)).toEqual([true, true, false, false, false]);
    expect(profiles[0].dpiLevels).toEqual([800, 1200, 2100, 2400, 3200]);
  });

  it('writes a profile the way G Hub does: start, 16 chunks, end, then reads it back', async () => {
    const { sim, mouse } = await setup();
    const p = decodeProfile(fromHex(SECTORS.profile3));
    p.name = 'Sim';
    const from = sim.written.length;
    await mouse.writeProfile(3, p);
    const calls = sent(sim, from).filter(([f, fn]) => f === 0x8100 && fn >= 6 && fn <= 8);
    expect(calls[0]).toEqual([0x8100, 6, '00 03 00 00 00 ff']);
    expect(calls.filter(([, fn]) => fn === 7)).toHaveLength(16);
    expect(calls.at(-1)?.[1]).toBe(8);
    expect(toHex(sim.flash.get(3)!)).toBe(toHex(encodeProfile(p)));
  });

  it('refuses DPI and report rates the sensor does not support, before writing anything', async () => {
    const { sim, mouse } = await setup();
    const p = decodeProfile(fromHex(SECTORS.profile3));
    const before = toHex(sim.flash.get(3)!);
    await expect(mouse.writeProfile(3, { ...p, dpiLevels: [125] })).rejects.toThrow(/125 DPI is not supported/);
    await expect(mouse.writeProfile(3, { ...p, reportRateMs: 3 })).rejects.toThrow(/not supported/);
    expect(toHex(sim.flash.get(3)!)).toBe(before);
  });

  it('applies an edit to the active profile immediately', async () => {
    const { sim, mouse, svc } = await setup();
    await mouse.setMode('onboard');
    await mouse.setActiveProfile(2);
    expect(sim.dpi).toBe(1600);
    await svc.apply({ type: 'dpi', profile: 2, levels: [700, 1300], defaultIndex: 1, shiftIndex: 0 });
    expect(sim.dpi).toBe(1300);
  });

  it('will not disable the last enabled profile or the active one, and cannot activate a disabled one', async () => {
    const { mouse } = await setup();
    await mouse.setMode('onboard');
    await mouse.setActiveProfile(1);
    await expect(mouse.setProfileEnabled(1, false)).rejects.toThrow(/active/);
    await mouse.setProfileEnabled(2, false);
    await mouse.setActiveProfile(1);
    await expect(mouse.setProfileEnabled(1, false)).rejects.toThrow(/at least one/);
    await expect(mouse.setActiveProfile(3)).rejects.toThrow(/disabled/);
  });

  it('restores a slot from the factory profile', async () => {
    const { sim, mouse } = await setup();
    await mouse.restoreFactoryProfile(1);
    expect(toHex(sim.flash.get(1)!)).toBe(toHex(encodeProfile(decodeProfile(fromHex(SECTORS.romProfile1)))));
    await mouse.restoreFactoryProfile(4);
    expect(toHex(sim.flash.get(4)!)).toBe(SECTORS.profile4);
  });

  it('erases a sector even though the firmware rejects the all-FF write', async () => {
    const { sim, mouse } = await setup();
    await mouse.writeSector(9, encodeProfile(decodeProfile(fromHex(SECTORS.profile1))));
    await mouse.eraseSector(9);
    expect(sim.flash.get(9)!.every((b) => b === 0xff)).toBe(true);
    await expect(mouse.eraseSector(16)).rejects.toThrow(RangeError);
  });
});

describe('live (software-mode) settings', () => {
  it('validates DPI against the sensor list and sets it', async () => {
    const { sim, mouse } = await setup();
    await mouse.setDpi(2450, 3);
    expect(sim.dpi).toBe(2450);
    await expect(mouse.setDpi(2475)).rejects.toThrow(/steps of 50/);
    await expect(mouse.setDpi(30000)).rejects.toThrow(RangeError);
  });

  it('takes software control of the LEDs and sends effects to the right cluster', async () => {
    const { sim, mouse } = await setup();
    await mouse.setLiveEffect(parseEffect('fixed:#ff0000'));
    await mouse.setLiveEffect(parseEffect('wave:3000:reverse-horizontal:40'));
    expect(sim.swControl).toEqual([3, 5]);
    expect(sim.effects.map((e) => toHex(e))).toEqual([
      '00 01 ff 00 00 02 00 00 00 00 00 00 01', // cluster 0, effect #1 (fixed)
      'ff 00 00 00 00 00 00 00 b8 06 28 0b 01', // all clusters, effect #0 (wave), 3000 ms split
    ]);
    await mouse.setLiveEffect({ type: 'off' });
    expect(toHex(sim.effects.at(-1)!)).toBe('00 00 00 00 00 00 00 00 00 00 00 00 01'); // cluster 0, effect #0
    await mouse.returnLightingToDevice();
    expect(sim.swControl).toEqual([0, 0]);
  });

  it('toggles the startup effect', async () => {
    const { mouse } = await setup();
    await mouse.setStartupEffect(true);
    expect(await mouse.getStartupEffect()).toBe(true);
  });
});

describe('service actions', () => {
  it('applies a curated DPI preset', async () => {
    const { mouse, svc } = await setup();
    await svc.apply({ type: 'dpiPreset', profile: 1, preset: 'first-person' });
    const p = await mouse.readProfile(1);
    expect([p.dpiLevels, p.dpiLevels[p.defaultDpiIndex], p.dpiLevels[p.shiftDpiIndex]]).toEqual([[400, 800, 1600], 800, 400]);
  });

  it('remaps buttons on either layer', async () => {
    const { mouse, svc } = await setup();
    await svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', assignment: { kind: 'binding', binding: parseBinding('key:ctrl+shift+t') } });
    await svc.apply({ type: 'button', profile: 1, control: 'wheel-up', layer: 'gshift', assignment: { kind: 'binding', binding: parseBinding('media:volume-up') } });
    await svc.apply({ type: 'button', profile: 1, control: 'g5', layer: 'base', assignment: { kind: 'binding', binding: parseBinding('disabled') } });
    const p = await mouse.readProfile(1);
    expect(p.buttons[8]).toEqual({ type: 'key', modifiers: Modifier.lctrl | Modifier.lshift, usage: 0x17 });
    expect(p.gshift[12]).toEqual({ type: 'consumer', usage: 0xe9 });
    expect(p.buttons[4]).toEqual({ type: 'disabled' });
    await expect(svc.apply({ type: 'button', profile: 1, control: 'nope', layer: 'base', assignment: { kind: 'binding', binding: { type: 'disabled' } } })).rejects.toThrow(/unknown control/);
  });

  it('places lighting in the LED slot G Hub uses and builds "Dim Active Effect"', async () => {
    const { mouse, svc } = await setup();
    await svc.apply({ type: 'lighting', profile: 1, target: 'active', effect: parseEffect('wave:5000:horizontal:100') });
    await svc.apply({ type: 'lighting', profile: 1, target: 'inactive', effect: 'dim', dimPercent: 50 });
    let l = (await mouse.readProfile(1)).lighting;
    expect(l.active).toEqual({ all: { type: 'wave', periodMs: 5000, direction: 1, brightness: 100 }, primary: { type: 'off' } });
    expect(l.inactive.all).toEqual({ type: 'wave', periodMs: 5000, direction: 1, brightness: 50 });
    await svc.apply({ type: 'lighting', profile: 1, target: 'active', effect: parseEffect('fixed:#00ffff') });
    await svc.apply({ type: 'lighting', profile: 1, target: 'inactive', effect: parseEffect('breathing:#00ffff:5000:100') });
    await svc.apply({ type: 'inactivity', profile: 1, dimAfterSeconds: 60, lightsOffAfterSeconds: 300 });
    const p = await mouse.readProfile(1);
    l = p.lighting;
    expect(l.active.all.type).toBe('off');
    expect(l.active.primary).toEqual({ type: 'fixed', color: [0, 255, 255] });
    // Same lighting, buttons, name and timers G Hub wrote for its default profile:
    expect(toHex(p.raw.slice(208, 253))).toBe(toHex(fromHex(SECTORS.ghubFixed).slice(208, 253)));
  });

  it('takes lighting effects in their text form, as the app sends them', async () => {
    const { mouse, svc } = await setup();
    await svc.apply({ type: 'lighting', profile: 1, target: 'active', effect: 'breathing:#ff8000:3000:60' });
    expect((await mouse.readProfile(1)).lighting.active.primary).toEqual({ type: 'breathing', color: [255, 128, 0], periodMs: 3000, waveform: 0, brightness: 60 });
    await expect(svc.apply({ type: 'lighting', profile: 1, target: 'active', effect: 'wave:500' })).rejects.toThrow(/period must be 1000..20000/);
  });

  it('keeps a dimmed idle lighting dimming the active effect when that changes', async () => {
    const { mouse, svc } = await setup();
    await svc.apply({ type: 'lighting', profile: 1, target: 'active', effect: 'fixed:#ff0000' });
    await svc.apply({ type: 'lighting', profile: 1, target: 'inactive', effect: 'dim', dimPercent: 50 });
    await svc.apply({ type: 'lighting', profile: 1, target: 'active', effect: 'fixed:#0000ff' });
    expect((await mouse.readProfile(1)).lighting.inactive.primary).toEqual({ type: 'fixed', color: [0, 0, 128] });
    await svc.apply({ type: 'lighting', profile: 1, target: 'inactive', effect: 'neutron-null' });
    await svc.apply({ type: 'lighting', profile: 1, target: 'active', effect: 'fixed:#00ff00' });
    expect((await mouse.readProfile(1)).lighting.inactive.all.type).toBe('signature');
  });

  it('writes nothing when a change changes nothing', async () => {
    const { sim, svc } = await setup();
    await svc.apply({ type: 'reportRate', profile: 1, hz: 500 });
    const before = sim.written.length;
    await svc.apply({ type: 'reportRate', profile: 1, hz: 500 });
    expect(sent(sim, before).some(([id, fn]) => id === 0x8100 && fn === 6)).toBe(false);
  });

  it('reads what the buttons on the mouse change, and fails fast while it sleeps', async () => {
    const { sim, svc } = await setup();
    await svc.apply({ type: 'mode', mode: 'onboard' });
    sim.cycleProfile();
    sim.dpiIndex = 3;
    sim.dpi = 2400;
    expect(await svc.live()).toEqual({ mode: 'onboard', activeProfile: 2, dpi: { current: 2400, level: 3 }, battery: expect.objectContaining({ percent: 36 }) });
    sim.asleepFor = 1;
    await expect(svc.live()).rejects.toBeInstanceOf(MouseUnavailableError);
  });

  it('checks a whole backup before writing any of it', async () => {
    const { sim, svc } = await setup();
    const backup = await svc.backup();
    expect(Object.keys(backup.sectors)).toHaveLength(16);
    const before = sim.written.length;
    await expect(svc.restore({ ...backup, sectors: { ...backup.sectors, 3: 'ff ff' } })).rejects.toThrow(/sector 3 in the backup is 2 bytes/);
    await expect(svc.restore({ ...backup, sectors: { ...backup.sectors, 16: backup.sectors[0] } })).rejects.toThrow(/has sector 16/);
    await expect(svc.restore({} as never)).rejects.toThrow(/not a mouse backup/);
    await expect(svc.restore({ ...backup, sectors: { ...backup.sectors, 4: backup.sectors[4].replace(/^../, 'zz') } })).rejects.toThrow(/sector 4 in the backup is not hex/);
    expect(sent(sim, before).some(([id, fn]) => id === 0x8100 && fn === 6)).toBe(false);
    expect(await svc.restore(backup)).toEqual([]);
  });

  it('snapshot lists every profile with readable bindings and lighting', async () => {
    const { svc } = await setup();
    const s = await svc.snapshot();
    expect(s.mode).toBe('host');
    expect(s.capabilities).toMatchObject({ dpi: { min: 100, max: 25600, step: 50 }, reportRatesHz: [1000, 500, 250, 125] });
    expect(s.capabilities.dpiPresets[1]).toEqual({ name: 'first-person', levels: [400, 800, 1600], defaultIndex: 1, shiftIndex: 0 });
    expect(s.capabilities.lighting).toMatchObject({ periodMs: { min: 1000, max: 20000 }, inactivity: [null, 60, 120, 300, 600, 900] });
    expect(s.profiles[1].buttons.find((b) => b.control === 'middle')).toEqual({ control: 'middle', label: 'Middle Click', binding: 'mouse:middle', gshift: 'key:ctrl+t' });
    expect(s.profiles[0].lighting).toEqual({ active: 'pulsar-point:32:100', inactive: 'neutron-null:32:100' });
    expect(s.profiles[0].reportRateHz).toBe(1000);
  });
});

describe('robustness (review findings)', () => {
  it('ignores a reply that arrives after its request timed out', async () => {
    const sim = new SimulatedG502X();
    const mouse = await G502X.connect(sim, { timeoutMs: 100 });
    sim.delayNextReplyMs = 150; // arrives after the 100 ms timeout, before the next reply
    await expect(mouse.getDpi()).rejects.toThrow(/no response/);
    sim.dpi = 2000;
    // Without stale-reply dropping, this would resolve with the late 1600 reply.
    expect((await mouse.getDpi()).dpi).toBe(2000);
  });

  it('restarts a sector write from the beginning if the mouse falls asleep part-way', async () => {
    const sim = new SimulatedG502X();
    const mouse = await G502X.connect(sim, { timeoutMs: 200, wakeTimeoutMs: 5000 });
    const p = decodeProfile(fromHex(SECTORS.profile3));
    p.name = 'after a nap';
    const from = sim.written.length;
    let chunks = 0;
    sim.onRequest = (feature, fn) => {
      if (feature === 0x8100 && fn === 7 && ++chunks === 8) sim.asleepFor = 3; // asleep from chunk 8 on
    };
    await mouse.writeProfile(3, p);
    expect(sent(sim, from).filter(([f, fn]) => f === 0x8100 && fn === 6)).toHaveLength(2);
    expect(toHex(sim.flash.get(3)!)).toBe(toHex(encodeProfile(p)));
  });

  it('with a blank directory, edits target user sectors and recreate the directory', async () => {
    const { sim, mouse } = await setup();
    sim.flash.set(0, new Uint8Array(255).fill(0xff));
    expect(await mouse.readDirectory()).toEqual([1, 2, 3, 4, 5].map((s) => ({ sector: s, enabled: s <= 2 })));
    const p = decodeProfile(fromHex(SECTORS.profile3));
    await mouse.writeProfile(4, { ...p, name: 'four' });
    expect(decodeProfile(sim.flash.get(4)!).name).toBe('four');
    expect(toHex(sim.flash.get(0)!)).toBe(SECTORS.directory);
    await mouse.setProfileEnabled(4, true);
    expect((await mouse.readDirectory())[3]).toEqual({ sector: 4, enabled: true });
  });

  it('reports a damaged profile instead of silently showing the factory one', async () => {
    const { sim, mouse } = await setup();
    sim.flash.get(2)![10] ^= 0xff;
    await expect(mouse.readProfile(2)).rejects.toThrow(/fails its checksum/);
    sim.flash.set(3, new Uint8Array(255).fill(0xff));
    expect((await mouse.readProfile(3)).dpiLevels).toEqual([800, 1200, 1600, 2400, 3200]); // erased = factory
  });

  it('refuses out-of-range values before anything is written', async () => {
    const { sim, mouse, svc } = await setup();
    const before = toHex(sim.flash.get(1)!);
    const bad = [
      svc.apply({ type: 'dpi', profile: 1, levels: [800, 1600], defaultIndex: -1 }),
      svc.apply({ type: 'inactivity', profile: 1, dimAfterSeconds: 70000 }),
      svc.apply({ type: 'lighting', profile: 1, target: 'inactive', effect: 'dim', dimPercent: 150 }),
      svc.apply({ type: 'lighting', profile: 1, target: 'active', effect: { type: 'wave', periodMs: 5000, direction: 1, brightness: 150 } }),
      svc.apply({ type: 'lighting', profile: 1, target: 'active', effect: { type: 'fixed', color: [300, 0, 0] } }),
      svc.apply({ type: 'reportRate', profile: 1, hz: 900 }),
      svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', assignment: { kind: 'binding', binding: { type: 'key', modifiers: 0, usage: 300 } } }),
    ];
    for (const b of bad) await expect(b).rejects.toThrow(RangeError);
    expect(toHex(sim.flash.get(1)!)).toBe(before);
    await mouse.setMode('onboard');
    await expect(mouse.setDpiIndex(4)).resolves.toBeUndefined(); // profile 1 has 5 levels
    await svc.apply({ type: 'dpi', profile: 1, levels: [800, 1600] });
    await expect(mouse.setDpiIndex(2)).rejects.toThrow(/0..1/);
  });

  it('keeps the current default and shift levels when only the DPI list changes', async () => {
    const { mouse, svc } = await setup();
    await svc.apply({ type: 'dpi', profile: 1, levels: [700, 1000, 1500, 2000] });
    const p = await mouse.readProfile(1);
    expect([p.defaultDpiIndex, p.shiftDpiIndex]).toEqual([2, 0]);
  });

  it('runs concurrent edits one after another, so none is lost', async () => {
    const { mouse, svc } = await setup();
    await Promise.all([
      svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', assignment: { kind: 'binding', binding: parseBinding('key:f13') } }),
      svc.apply({ type: 'name', profile: 1, name: 'both' }),
      svc.snapshot(),
    ]);
    const p = await mouse.readProfile(1);
    expect([p.name, p.buttons[8]]).toEqual(['both', { type: 'key', modifiers: 0, usage: 0x68 }]);
  });
});

describe('librehub mouse CLI', () => {
  const cli = async (sim: SimulatedG502X, ...args: string[]) => {
    const log = console.log;
    console.log = () => undefined;
    try {
      await runCli(args, () => sim);
    } finally {
      console.log = log;
    }
  };

  it('sends single-request commands before closing the connection', async () => {
    const sim = new SimulatedG502X();
    await cli(sim, 'mode', 'onboard');
    expect(sim.mode).toBe(1);
    await cli(sim, 'dpi-level', '3');
    expect(sim.dpiIndex).toBe(3);
    await cli(sim, 'startup-effect', 'on');
    expect(sim.startupEffect).toBe(1);
  });

  it('edits a profile and switches to it', async () => {
    const sim = new SimulatedG502X();
    await cli(sim, 'mode', 'onboard');
    await cli(sim, 'profile', '2', 'dpi', '400,800', '--default', '1');
    await cli(sim, 'profile', '2', 'button', 'g9', 'fn:dpi-cycle', '--gshift');
    await cli(sim, 'profile', '2', 'lighting', 'cycle:8000:60');
    await cli(sim, 'profile', '2');
    const p = decodeProfile(sim.flash.get(2)!);
    expect([p.dpiLevels, p.defaultDpiIndex, p.gshift[8], p.lighting.active.primary]).toEqual([[400, 800], 1, { type: 'function', fn: 'dpi-cycle' }, { type: 'cycle', periodMs: 8000, brightness: 60 }]);
    expect([sim.activeProfile, sim.dpi]).toEqual([2, 800]);
  });

  it('rejects a flag without a value', async () => {
    await expect(cli(new SimulatedG502X(), 'profile', '1', 'dpi', '800', '--default')).rejects.toThrow(/needs a value/);
  });

  it('backs up and restores the whole memory', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'g502x-')), 'backup.json');
    const sim = new SimulatedG502X();
    const original = [...sim.flash.entries()].filter(([s]) => s < 16).map(([s, b]) => [s, toHex(b)]);
    await cli(sim, 'backup', file);
    await cli(sim, 'profile', '1', 'name', 'scratch');
    await cli(sim, 'profile', '3', 'enable');
    sim.flash.set(9, encodeProfile(decodeProfile(fromHex(SECTORS.profile1))));
    await cli(sim, 'restore', file);
    expect([...sim.flash.entries()].filter(([s]) => s < 16).map(([s, b]) => [s, toHex(b)])).toEqual(original);
  });
});

describe('macros stored on the mouse', () => {
  async function withStore() {
    const sim = new SimulatedG502X();
    const mouse = await G502X.connect(sim, { timeoutMs: 200 });
    const store = tempStore();
    return { sim, mouse, store, svc: new MouseService(mouse, store) };
  }

  it('writes text into the profile\'s macro sector and points the control at it', async () => {
    const { sim, svc } = await withStore();
    await svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', assignment: 'text:Hello, World!' });
    const p = decodeProfile(sim.flash.get(1)!);
    expect(p.buttons[8]).toEqual({ type: 'macro', sector: 6, offset: 0 });
    expect(decodeMacro(sim.flash.get(6)!)).toHaveLength(26);
    const view = (await svc.snapshot()).profiles[0].buttons[8];
    expect(view.binding).toBe('text:Hello, World!');
  });

  it('packs several macros, repacks when one is replaced, and erases the sectors when none are left', async () => {
    const { sim, svc } = await withStore();
    await svc.apply({ type: 'button', profile: 2, control: 'g9', layer: 'base', assignment: 'double-click' });
    await svc.apply({ type: 'button', profile: 2, control: 'back', layer: 'gshift', assignment: 'macro:ctrl+c, 50ms, ctrl+v' });
    let p = decodeProfile(sim.flash.get(2)!);
    expect([p.buttons[8], p.gshift[3]]).toEqual([{ type: 'macro', sector: 8, offset: 0 }, { type: 'macro', sector: 8, offset: 16 }]);
    await svc.apply({ type: 'button', profile: 2, control: 'g9', layer: 'base', assignment: 'fn:profile-cycle' });
    p = decodeProfile(sim.flash.get(2)!);
    expect(p.gshift[3]).toEqual({ type: 'macro', sector: 8, offset: 0 });
    const s = await svc.snapshot();
    expect(s.profiles[1].buttons[3].gshift).toBe('macro:ctrl+c, 50ms, ctrl+v');
    await svc.apply({ type: 'button', profile: 2, control: 'back', layer: 'gshift', assignment: 'default' });
    expect(sim.flash.get(8)!.every((b) => b === 0xff)).toBe(true);
    expect(sim.flash.get(6)!.every((b) => b === 0xff)).toBe(true); // profile 1's sectors untouched
  });

  it('refuses a macro that does not fit before writing anything', async () => {
    const { sim, svc } = await withStore();
    const before = toHex(sim.flash.get(1)!);
    await expect(svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', assignment: `text:${'x'.repeat(60)}` })).rejects.toThrow(/at most 253/);
    expect(toHex(sim.flash.get(1)!)).toBe(before);
  });
});

describe('software actions and Freestyle (agent)', () => {
  async function running(opts: { profile?: number } = {}) {
    const sim = new SimulatedG502X();
    const mouse = await G502X.connect(sim, { timeoutMs: 200 });
    const store = tempStore();
    const svc = new MouseService(mouse, store);
    await svc.apply({ type: 'mode', mode: 'onboard' });
    if (opts.profile) await svc.apply({ type: 'activeProfile', profile: opts.profile });
    const ran: SoftwareAction[] = [];
    const agent = new SoftwareAgent(svc, store, { runner: (a) => ran.push(a), settleMs: 5, repaintMs: 20 });
    return { sim, mouse, store, svc, agent, ran };
  }
  const G9 = 1 << 8;
  const BACK = 1 << 3;
  const SNIPER = 1 << 4;

  it('stores the control as "disabled" on the mouse and performs the action on press', async () => {
    const { sim, svc, store, agent, ran } = await running();
    await svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', assignment: 'open:https://example.com' });
    expect(decodeProfile(sim.flash.get(1)!).buttons[8]).toEqual({ type: 'disabled' });
    expect((await store.read()).profiles['1'].actions.base.g9).toEqual({ type: 'open', target: 'https://example.com' });
    expect((await svc.snapshot()).profiles[0].buttons[8].binding).toBe('open:https://example.com');
    await agent.start();
    expect(sim.spying).toBe(true);
    sim.press(G9);
    sim.press(BACK); // no action on back
    await tick(5);
    expect(ran).toEqual([{ type: 'open', target: 'https://example.com' }]);
    await agent.stop();
    expect(sim.spying).toBe(false);
  });

  it('uses the G-Shift layer while a G-Shift button is held, and fires once per press', async () => {
    const { svc, agent, ran, sim } = await running();
    await svc.apply({ type: 'button', profile: 1, control: 'sniper', layer: 'base', assignment: 'fn:g-shift' });
    await svc.apply({ type: 'button', profile: 1, control: 'back', layer: 'gshift', assignment: 'run:echo shifted' });
    await svc.apply({ type: 'button', profile: 1, control: 'back', layer: 'base', assignment: 'run:echo plain' });
    await agent.start();
    sim.buttons(SNIPER);
    sim.buttons(SNIPER | BACK);
    sim.buttons(SNIPER | BACK); // repeated report while held: no second action
    sim.buttons(SNIPER);
    sim.buttons(0);
    sim.press(BACK);
    await tick(5);
    expect(ran.map((a) => (a.type === 'run' ? a.command : ''))).toEqual(['echo shifted', 'echo plain']);
    await agent.stop();
  });

  it('says when a DPI button is pressed (the mouse itself doesn\'t), and not for other buttons', async () => {
    const { svc, agent, sim } = await running();
    const DPI_UP = 1 << 9;
    expect((await svc.snapshot()).profiles[0].buttons[9].binding).toBe('fn:dpi-up');
    await agent.start();
    let dpi = 0;
    agent.on('dpi', () => dpi++);
    sim.press(BACK);
    await tick(5);
    expect(dpi).toBe(0);
    sim.press(DPI_UP);
    await tick(5);
    expect(dpi).toBeGreaterThan(0);
    await agent.stop();
  });

  it('does nothing if the mouse binding was changed behind its back (e.g. by G Hub)', async () => {
    const { svc, agent, ran, sim, store } = await running();
    await svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', assignment: 'run:echo hi' });
    await store.update(1, () => undefined);
    await svc.editProfile(1, (p) => {
      p.buttons[8] = { type: 'function', fn: 'profile-cycle' };
    });
    await agent.start();
    sim.press(G9);
    await tick(5);
    expect(ran).toEqual([]);
    await agent.stop();
  });

  it('follows the active profile: actions and Freestyle of the profile the mouse switched to', async () => {
    const { svc, agent, ran, sim } = await running();
    await svc.apply({ type: 'profileEnabled', profile: 3, enabled: true });
    await svc.apply({ type: 'button', profile: 2, control: 'g9', layer: 'base', assignment: 'run:echo two' });
    await svc.apply({ type: 'freestyle', profile: 2, colors: { 1: '#ff0000', 2: '#00ff00' } });
    await agent.start();
    expect(agent.state.profile).toBe(1);
    expect(sim.ledFrames).toEqual([]);
    sim.cycleProfile();
    await tick(40);
    expect(agent.state.profile).toBe(2);
    expect(sim.ledFrames.at(-1)).toEqual({ 1: [255, 0, 0], 2: [0, 255, 0] });
    expect(sim.ledFrames.length).toBe(2); // painted, then painted again after the mouse's own repaint
    expect(sim.swControl).toEqual([3, 5]);
    sim.press(G9);
    await tick(5);
    expect(ran).toEqual([{ type: 'run', command: 'echo two' }]);
    sim.cycleProfile(); // to 3: no Freestyle, so the LEDs go back to the profile's effect
    await tick(40);
    expect(sim.swControl).toEqual([0, 0]);
    await agent.stop();
  });

  it('restarts the spy and repaints after the mouse sleeps and wakes up', async () => {
    const { svc, agent, ran, sim } = await running();
    await svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', assignment: 'run:echo awake' });
    await svc.apply({ type: 'freestyle', profile: 1, colors: { 5: '#0000ff' } });
    await agent.start();
    const frames = sim.ledFrames.length;
    sim.sleepAndWake();
    expect(sim.spying).toBe(false);
    await tick(40);
    expect(sim.spying).toBe(true);
    expect(sim.ledFrames.length).toBeGreaterThan(frames);
    sim.press(G9);
    await tick(5);
    expect(ran).toHaveLength(1);
    await agent.stop();
    expect([sim.spying, sim.swControl]).toEqual([false, [0, 0]]);
  });

  it('stops at once even if the mouse has fallen asleep', async () => {
    const sim = new SimulatedG502X();
    const mouse = await G502X.connect(sim, { timeoutMs: 200, wakeTimeoutMs: 60000 });
    const store = tempStore();
    const svc = new MouseService(mouse, store);
    await svc.apply({ type: 'mode', mode: 'onboard' });
    await svc.apply({ type: 'freestyle', profile: 1, colors: { 1: '#ffffff' } });
    const agent = new SoftwareAgent(svc, store, { runner: () => undefined, settleMs: 5, repaintMs: 1000 });
    await agent.start();
    sim.asleepFor = 1000;
    const t = Date.now();
    await agent.stop();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('does nothing in host mode, where there is no profile to follow', async () => {
    const sim = new SimulatedG502X();
    const mouse = await G502X.connect(sim, { timeoutMs: 200 });
    const store = tempStore();
    const svc = new MouseService(mouse, store);
    const ran: SoftwareAction[] = [];
    await store.update(1, (p) => {
      p.actions.base.g9 = { type: 'run', command: 'x' };
    });
    const agent = new SoftwareAgent(svc, store, { runner: (a) => ran.push(a), settleMs: 5 });
    await agent.start();
    sim.press(G9);
    await tick(5);
    expect([agent.state.profile, ran]).toEqual([null, []]);
    await agent.stop();
  });

  it('clears software settings when a profile is restored to factory', async () => {
    const { svc, store } = await running();
    await svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', assignment: 'run:echo hi' });
    await svc.apply({ type: 'freestyle', profile: 1, colors: { 1: '#ffffff' } });
    await svc.apply({ type: 'restoreProfile', profile: 1 });
    expect(await store.read()).toEqual({ version: 1, profiles: {} });
  });

  it('CLI: assigns text, a software action and Freestyle, and shows them', async () => {
    const sim = new SimulatedG502X();
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => out.push(a.join(' '));
    try {
      await runCli(['profile', '1', 'button', 'g9', 'text:Hello,', 'World!'], () => sim);
      await runCli(['profile', '1', 'button', 'back', 'open:https://example.com', '--gshift'], () => sim);
      await runCli(['profile', '1', 'freestyle', '#00ffff'], () => sim);
      await runCli(['profile', '1', 'show'], () => sim);
    } finally {
      console.log = log;
    }
    const shown = out.join('\n');
    expect(shown).toMatch(/g9 +text:Hello, World!/);
    expect(shown).toMatch(/back .*g-shift: open:https:\/\/example.com/);
    expect(shown).toMatch(/freestyle +#00ffff(,#00ffff){7}/);
    expect(JSON.parse(readFileSync(process.env.G502X_CONFIG!, 'utf8')).profiles['1'].actions.gshift.back).toEqual({ type: 'open', target: 'https://example.com' });
  });
});
