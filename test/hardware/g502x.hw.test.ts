// Real-hardware verification for the G502 X PLUS. Run with:  npm run test:hardware:mouse
// Every test reads the current state, changes it, checks the change with an independent read, then
// restores it. All 16 onboard-memory sectors are saved first and compared at the end.
// Quit G Hub first: in software mode it re-applies its own DPI, report rate and lighting.
// Keep the mouse awake (move it now and then): the receiver answers "unknown device" while it sleeps.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { G502X } from '../../src/mouse/g502x.js';
import { toHex } from '../../src/mouse/hidpp.js';
import { decodeProfile, encodeProfile, macroSector, Modifier, sectorCrcOk, type Profile } from '../../src/mouse/onboard.js';
import { MouseService } from '../../src/mouse/service.js';
import { openReceiver } from '../../src/mouse/transport.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoftwareAgent } from '../../src/mouse/agent.js';
import { decodeMacro } from '../../src/mouse/onboard.js';
import { SoftwareStore } from '../../src/mouse/software.js';

const enabled = process.env.G502X_HARDWARE === '1';
let mouse: G502X;
const saved = new Map<number, string>();
let savedMode = '';
let savedProfile = 0;

async function restoreAll() {
  for (const [s, hex] of saved) {
    const now = toHex(await mouse.readSector(s));
    if (now === hex) continue;
    if (hex.split(' ').every((b) => b === 'ff')) await mouse.eraseSector(s);
    else await mouse.writeSector(s, Uint8Array.from(hex.split(' ').map((b) => parseInt(b, 16))));
  }
}

async function withOnboard<T>(fn: () => Promise<T>): Promise<T> {
  const mode = await mouse.getMode();
  const profile = await mouse.getActiveProfile();
  if (mode !== 'onboard') await mouse.setMode('onboard');
  try {
    return await fn();
  } finally {
    if (mode !== 'onboard') await mouse.setMode('host');
    else if (profile) await mouse.setActiveProfile(profile);
  }
}

describe.skipIf(!enabled)('G502 X PLUS hardware', { timeout: 60000 }, () => {
  beforeAll(async () => {
    mouse = await G502X.connect(openReceiver(), { wakeTimeoutMs: 30000 });
    const { sectorCount } = await mouse.getOnboardDescription();
    for (let s = 0; s < sectorCount; s++) saved.set(s, toHex(await mouse.readSector(s)));
    savedMode = await mouse.getMode();
    savedProfile = await mouse.getActiveProfile();
  }, 120000);

  afterAll(async () => {
    if (!mouse) return;
    await restoreAll();
    if ((await mouse.getMode()) !== savedMode) await mouse.setMode(savedMode as 'onboard' | 'host');
    if (savedMode === 'onboard' && savedProfile) await mouse.setActiveProfile(savedProfile);
    for (const [s, hex] of saved) expect(toHex(await mouse.readSector(s)), `sector ${s} restored`).toBe(hex);
    mouse.close();
  }, 180000);

  it('identifies the mouse and finds it through the receiver pairing table', async () => {
    const info = await mouse.getInfo();
    expect(info.name).toBe('G502 X PLUS');
    expect(info.firmware.find((f) => f.type === 'application')?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await mouse.getPairedDevices()).some((d) => d.slot === mouse.deviceIndex && d.wirelessPid === 0x4099)).toBe(true);
    expect((await mouse.getBattery()).percent).toBeGreaterThan(0);
    const d = await mouse.getOnboardDescription();
    expect(d).toMatchObject({ profileFormat: 5, profileCount: 5, sectorSize: 255, hasGShift: true });
    console.log(`connected: ${info.name} ${info.firmware.map((f) => `${f.name} ${f.version}`).join(', ')}, ${mouse.features.length} features`);
  });

  it('reads the whole onboard memory and every user sector has a valid checksum or is erased', async () => {
    for (const [s, hex] of saved) {
      const bytes = Uint8Array.from(hex.split(' ').map((b) => parseInt(b, 16)));
      expect(sectorCrcOk(bytes) || bytes.every((b) => b === 0xff), `sector ${s}`).toBe(true);
    }
    const profiles = await mouse.readProfiles();
    expect(profiles).toHaveLength(5);
    for (const p of profiles) expect(toHex(encodeProfile(p)), 'decode/encode round trip on the real sectors').toBe(saved.get(p.sector));
  });

  it('live DPI: set, read back, restore', async () => {
    const { dpi } = await mouse.getDpi();
    const alt = dpi === 1650 ? 1750 : 1650;
    try {
      await mouse.setDpi(alt, 1);
      expect((await mouse.getDpi()).dpi).toBe(alt);
      await expect(mouse.setDpi(1625)).rejects.toThrow(RangeError); // not a multiple of 50
    } finally {
      await mouse.setDpi(dpi);
    }
    expect((await mouse.getDpi()).dpi).toBe(dpi);
  });

  it('live report rate: set, read back, restore', async () => {
    const rate = await mouse.getReportRate();
    const alt = rate === 2 ? 4 : 2;
    try {
      await mouse.setReportRate(alt);
      expect(await mouse.getReportRate()).toBe(alt);
    } finally {
      await mouse.setReportRate(rate);
    }
    expect(await mouse.getReportRate()).toBe(rate);
  });

  it('onboard mode: switching profiles and DPI levels changes what the sensor runs', () =>
    withOnboard(async () => {
      expect(await mouse.getMode()).toBe('onboard');
      const profiles = await mouse.readProfiles();
      const enabledSlots = profiles.map((p, k) => (p.enabled ? k + 1 : 0)).filter(Boolean);
      expect(enabledSlots.length).toBeGreaterThan(1);
      for (const slot of enabledSlots) {
        await mouse.setActiveProfile(slot);
        const p = profiles[slot - 1];
        expect(await mouse.getActiveProfile()).toBe(slot);
        expect(await mouse.getReportRate()).toBe(p.reportRateMs);
        expect((await mouse.getDpi()).dpi).toBe(p.dpiLevels[p.defaultDpiIndex]);
        for (const level of [0, p.dpiLevels.length - 1]) {
          await mouse.setDpiIndex(level);
          expect(await mouse.getDpiIndex()).toBe(level);
          expect((await mouse.getDpi()).dpi).toBe(p.dpiLevels[level]);
        }
      }
      await expect(mouse.setActiveProfile(profiles.findIndex((p) => !p.enabled) + 1)).rejects.toThrow(/disabled/);
    }));

  it('writes a full profile into a spare slot, and the mouse runs it', async () => {
    const slot = 5;
    const base = await mouse.readProfile(slot);
    const p: Profile = {
      ...decodeProfile(base.raw),
      reportRateMs: 4,
      dpiLevels: [450, 900, 1800],
      defaultDpiIndex: 1,
      shiftDpiIndex: 0,
      name: 'hardware test',
      lighting: {
        active: { all: { type: 'off' }, primary: { type: 'breathing', color: [255, 32, 0], periodMs: 4000, waveform: 0, brightness: 60 } },
        inactive: { all: { type: 'wave', periodMs: 7000, direction: 6, brightness: 20 }, primary: { type: 'off' } },
      },
      dimAfterSeconds: 120,
      lightsOffAfterSeconds: null,
    };
    p.buttons[2] = { type: 'key', modifiers: Modifier.lctrl, usage: 0x06 };
    p.buttons[8] = { type: 'disabled' };
    p.gshift[0] = { type: 'consumer', usage: 0xcd };
    await mouse.writeProfile(slot, p);
    const back = await mouse.readProfile(slot);
    expect({ ...back, raw: undefined, sector: undefined, enabled: undefined }).toEqual({ ...p, raw: undefined, sector: undefined, enabled: undefined });

    await mouse.setProfileEnabled(slot, true);
    await withOnboard(async () => {
      await mouse.setActiveProfile(slot);
      expect(await mouse.getReportRate()).toBe(4);
      expect((await mouse.getDpi()).dpi).toBe(900);
      // Editing the active profile applies at once.
      await new MouseService(mouse).apply({ type: 'dpi', profile: slot, levels: [500, 1100], defaultIndex: 1, shiftIndex: 0 });
      expect((await mouse.getDpi()).dpi).toBe(1100);
      await mouse.setActiveProfile(1);
    });
    await restoreAll();
  });

  it('enables and disables a profile in the directory', async () => {
    const before = await mouse.readDirectory();
    const slot = before.findIndex((e) => !e.enabled) + 1;
    await mouse.setProfileEnabled(slot, true);
    expect((await mouse.readDirectory())[slot - 1].enabled).toBe(true);
    await mouse.setProfileEnabled(slot, false);
    expect(await mouse.readDirectory()).toEqual(before);
  });

  it('restoring a slot that already holds the factory profile changes nothing', async () => {
    const slot = 4;
    const factory = toHex(encodeProfile(decodeProfile(await mouse.readSector(mouse.factorySectorFor(slot)))));
    if (saved.get(slot) !== factory) return; // the slot was customised; nothing to compare against
    await mouse.restoreFactoryProfile(slot);
    expect(toHex(await mouse.readSector(slot))).toBe(factory);
  });

  it('writes, reads and erases a spare sector', async () => {
    const s = 15;
    const sector = macroSector([{ op: 'key-down', modifiers: 0, usage: 0x04 }, { op: 'delay', ms: 20 }, { op: 'key-up', modifiers: 0, usage: 0x04 }]);
    await mouse.writeSector(s, sector);
    expect(toHex(await mouse.readSector(s))).toBe(toHex(sector));
    await mouse.eraseSector(s);
    expect((await mouse.readSector(s)).every((b) => b === 0xff)).toBe(true);
  });

  it('the firmware rejects a sector with a bad checksum', async () => {
    const s = 14;
    const before = await mouse.readSector(s);
    const bad = macroSector([{ op: 'delay', ms: 1 }]);
    bad[254] ^= 0xff;
    await expect(
      (async () => {
        await mouse.call(0x8100, 6, [0, s, 0, 0, 0, 255]);
        for (let o = 0; o < 255; o += 16) await mouse.call(0x8100, 7, Array.from(bad.slice(o, o + 16)).concat(new Array(16).fill(0)).slice(0, 16));
        await mouse.call(0x8100, 8);
      })(),
    ).rejects.toThrow(/HARDWARE_ERROR/);
    if (!before.every((b) => b === 0xff)) await mouse.writeSector(s, before);
    else await mouse.eraseSector(s);
  });

  it('startup effect: toggle, read back, restore', async () => {
    const on = await mouse.getStartupEffect();
    try {
      await mouse.setStartupEffect(!on);
      expect(await mouse.getStartupEffect()).toBe(!on);
    } finally {
      await mouse.setStartupEffect(on);
    }
    expect(await mouse.getStartupEffect()).toBe(on);
  });

  it('lighting clusters match what G Hub enumerates', async () => {
    expect(await mouse.getLightingInfo()).toEqual([
      { cluster: 0, location: 1, effects: [0x00, 0x01, 0x0a, 0x03] },
      { cluster: 0xff, location: 0, effects: [0x04, 0x0c, 0x0f, 0x10, 0x13] },
    ]);
  });

  it('wheel state is readable', async () => {
    const w = await mouse.getWheel();
    expect(w).toMatchObject({ multiplier: 8, hasInvert: true, hasRatchetSwitch: true });
    expect(['ratchet', 'free-spin']).toContain(w.ratchet);
  });

  // Macros, software actions and Freestyle. That the mouse really types a macro, reports presses
  // and shows per-LED colours was checked by hand (docs/evidence/g502x/lab); these check the
  // writes and the protocol against the real firmware.
  it('stores a text macro in slot 5\'s macro sectors and points G9 at it', async () => {
    const store = new SoftwareStore(join(mkdtempSync(join(tmpdir(), 'g502x-hw-')), 'g502x.json'));
    const svc = new MouseService(mouse, store);
    await svc.apply({ type: 'button', profile: 5, control: 'g9', layer: 'base', assignment: 'text:Hello, World!' });
    await svc.apply({ type: 'button', profile: 5, control: 'back', layer: 'gshift', assignment: 'double-click' });
    const p = await mouse.readProfile(5);
    expect(p.buttons[8]).toEqual({ type: 'macro', sector: 14, offset: 0 });
    expect(p.gshift[3]).toEqual({ type: 'macro', sector: 14, offset: 79 });
    expect(decodeMacro(await mouse.readSector(14))).toHaveLength(26);
    const view = (await svc.snapshot()).profiles[4];
    expect([view.buttons[8].binding, view.buttons[3].gshift]).toEqual(['text:Hello, World!', 'double-click']);
  });

  it('the agent starts and stops the button spy and paints Freestyle without errors', () =>
    withOnboard(async () => {
      const store = new SoftwareStore(join(mkdtempSync(join(tmpdir(), 'g502x-hw-')), 'g502x.json'));
      const svc = new MouseService(mouse, store);
      const active = await mouse.getActiveProfile();
      await svc.apply({ type: 'freestyle', profile: active, colors: { 1: '#ff0000', 2: '#00ff00', 3: '#0000ff' } });
      const agent = new SoftwareAgent(svc, store, { runner: () => undefined, repaintMs: 300 });
      const errors: unknown[] = [];
      agent.on('error', (e) => errors.push(e));
      await agent.start();
      expect(agent.state.profile).toBe(active);
      await new Promise((r) => setTimeout(r, 500));
      await agent.stop();
      expect(errors).toEqual([]);
      expect(await mouse.call(0x8071, 5, [0])).toBeDefined();
    }));
});
