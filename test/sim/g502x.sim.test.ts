import { describe, expect, it } from 'vitest';
import { G502X, MouseUnavailableError } from '../../src/mouse/g502x.js';
import { fromHex, toHex } from '../../src/mouse/hidpp.js';
import { decodeProfile, encodeProfile, Modifier } from '../../src/mouse/onboard.js';
import { parseEffect } from '../../src/mouse/presets.js';
import { MouseService } from '../../src/mouse/service.js';
import { parseBinding } from '../../src/mouse/usages.js';
import { SECTORS } from '../fixtures/g502x-sectors.js';
import { FEATURE_TABLE, SimulatedG502X } from './simulated-g502x.js';

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
    await expect(mouse.eraseSector(0)).rejects.toThrow(RangeError);
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
    await svc.apply({ type: 'button', profile: 1, control: 'g9', layer: 'base', binding: parseBinding('key:ctrl+shift+t') });
    await svc.apply({ type: 'button', profile: 1, control: 'wheel-up', layer: 'gshift', binding: parseBinding('media:volume-up') });
    await svc.apply({ type: 'button', profile: 1, control: 'g5', layer: 'base', binding: parseBinding('disabled') });
    const p = await mouse.readProfile(1);
    expect(p.buttons[8]).toEqual({ type: 'key', modifiers: Modifier.lctrl | Modifier.lshift, usage: 0x17 });
    expect(p.gshift[12]).toEqual({ type: 'consumer', usage: 0xe9 });
    expect(p.buttons[4]).toEqual({ type: 'disabled' });
    await expect(svc.apply({ type: 'button', profile: 1, control: 'nope', layer: 'base', binding: { type: 'disabled' } })).rejects.toThrow(/unknown control/);
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

  it('snapshot lists every profile with readable bindings and lighting', async () => {
    const { svc } = await setup();
    const s = await svc.snapshot();
    expect(s.mode).toBe('host');
    expect(s.capabilities).toEqual({ dpi: { min: 100, max: 25600, step: 50 }, reportRatesHz: [1000, 500, 250, 125], dpiPresets: expect.any(Array) });
    expect(s.profiles[1].buttons.find((b) => b.control === 'middle')).toEqual({ control: 'middle', label: 'Middle Click', binding: 'mouse:middle', gshift: 'key:ctrl+t' });
    expect(s.profiles[0].lighting).toEqual({ active: 'pulsar-point:32:100', inactive: 'neutron-null:32:100' });
    expect(s.profiles[0].reportRateHz).toBe(1000);
  });
});
