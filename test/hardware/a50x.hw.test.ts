// Real-hardware verification. Run with:  npm run test:hardware
// Every test reads the current value, changes it, checks the device's own event and a fresh read,
// then restores the original and checks that too. Expect brief audible changes (volume, sidetone).
// Quit G Hub first: when it runs it mirrors device events and can re-apply its own values.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A50X } from '../../src/device/a50x.js';
import { openA50X } from '../../src/device/transport.js';
import { HEADPHONES, MIC, stepToDb } from '../../src/protocol/eq.js';

const enabled = process.env.A50X_HARDWARE === '1';
let dev: A50X;

const eventOrTimeout = <T>(name: string, ms = 2000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no '${name}' event within ${ms} ms`)), ms);
    dev.once(name, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });

async function roundTrip<T>(opts: {
  read: () => Promise<T>;
  write: (v: T) => Promise<void>;
  pick: (orig: T) => T;
  event?: string;
  checkEvent?: (ev: any, want: T) => void;
}) {
  const orig = await opts.read();
  const alt = opts.pick(orig);
  expect(alt).not.toEqual(orig);
  try {
    const ev = opts.event ? eventOrTimeout(opts.event) : undefined;
    await opts.write(alt);
    if (ev) opts.checkEvent?.(await ev, alt);
    expect(await opts.read()).toEqual(alt);
  } finally {
    await opts.write(orig);
  }
  expect(await opts.read()).toEqual(orig);
}

describe.skipIf(!enabled)('A50 X hardware', { timeout: 20000 }, () => {
  beforeAll(async () => {
    dev = await A50X.connect(openA50X());
  });
  afterAll(() => dev?.close());

  it('identifies the device', async () => {
    const info = await dev.getDeviceInfo();
    expect(info.model).toBe('A50 X');
    expect(info.firmware.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await dev.getBattery()).percent).toBeGreaterThanOrEqual(0);
    console.log(`connected: ${info.model} "${info.name}" fw ${info.firmware.version}, ${dev.features.length} features`);
  });

  it('sidetone', () =>
    roundTrip({
      read: async () => (await dev.getSidetone()).step,
      write: (v) => dev.setSidetone(v),
      pick: (o) => (o === 0 ? 1 : o - 1),
      event: 'sidetone',
      checkEvent: (ev, want) => expect(ev.step).toBe(want),
    }));

  it('device volume level', () =>
    roundTrip({
      read: async () => (await dev.getVolume()).level,
      write: (v) => dev.setVolume(v),
      pick: (o) => (o === 0 ? 1 : o - 1),
      event: 'volume',
      checkEvent: (ev, want) => expect(ev.level).toBe(want),
    }));

  it('device mute', () =>
    roundTrip({
      read: async () => (await dev.getVolume()).muted,
      write: (v) => dev.setMuted(v),
      pick: (o) => !o,
      event: 'volume',
      checkEvent: (ev, want) => expect(ev.muted).toBe(want),
    }));

  it('game/voice balance', () =>
    roundTrip({
      read: async () => (await dev.getBalance()).value,
      write: (v) => dev.setBalance(v),
      pick: (o) => (o === 0 ? 1 : o - 1),
      event: 'balance',
      checkEvent: (ev, want) => expect(ev).toBe(want),
    }));

  it('sleep timer (power management), compared byte-for-byte with what G Hub writes', async () => {
    // Read the raw pair so a restore that only fixes the minutes (but not the lead byte) fails.
    const orig = await dev.getSleepTimer();
    expect(orig.lead).toBe(0x3c);
    await roundTrip({
      read: () => dev.getSleepTimer(),
      write: (v) => dev.setSleepTimer(v.minutes),
      pick: (o) => ({ lead: 0x3c, minutes: o.minutes === 15 ? 60 : 15 }),
      event: 'sleep',
      checkEvent: (ev, want) => expect(ev).toEqual(want),
    });
  });

  it('base station brightness', () =>
    roundTrip({
      read: () => dev.getBrightness(),
      write: (v) => dev.setBrightness(v),
      pick: (o) => (o >= 50 ? o - 30 : o + 30),
      event: 'settingsChecksum',
    }));

  it('headset tones', () =>
    roundTrip({
      read: () => dev.getTones(),
      write: (v) => dev.setTones(v),
      pick: (o) => (o === 2 ? 1 : 2),
      event: 'tones',
      checkEvent: (ev, want) => expect(ev).toBe(want),
    }));

  it('mic noise gate', async () => {
    const { supported } = await dev.getNoiseGate();
    expect(supported.length).toBeGreaterThan(1);
    await roundTrip({
      read: async () => (await dev.getNoiseGate()).value,
      write: (v) => dev.setNoiseGate(v),
      pick: (o) => supported.find((g) => g !== o)!,
      event: 'noiseGate',
      checkEvent: (ev, want) => expect(ev).toBe(want),
    });
  });

  it('stream-port routing: output level and every input level/mute', async () => {
    const { inputs } = await dev.getRouting();
    expect(inputs.length).toBeGreaterThan(0);
    await roundTrip({
      read: async () => (await dev.getRouting()).state,
      write: (s) => dev.setRouting(s),
      pick: (o) => ({
        ...o,
        gain: o.gain > 4 ? o.gain - 4 : o.gain + 4,
        inputs: o.inputs.map((i) => ({ ...i, gain: i.gain > 4 ? i.gain - 4 : i.gain + 4, muted: !i.muted })),
      }),
      event: 'routing',
      checkEvent: (ev, want) => expect(ev).toEqual(want),
    });
  });

  for (const [label, instance, preset] of [['microphone', MIC, 1], ['headphones', HEADPHONES, 1]] as const) {
    it(`${label} EQ: apply a curated preset and custom gains, then restore`, async () => {
      const before = await dev.getEqualizer(instance);
      const curated = await dev.getOnboardPreset(instance, preset);
      try {
        const ev = eventOrTimeout<{ instance: number; bands: { gainStep: number }[] }>('equalizer');
        await dev.applyCuratedPreset(instance, preset);
        const got = await ev;
        expect(got.instance).toBe(instance);
        expect(got.bands.map((b) => b.gainStep)).toEqual(curated.map((b) => b.gainStep));
        expect((await dev.getEqualizer(instance)).bands.map((b) => b.gainStep)).toEqual(curated.map((b) => b.gainStep));

        const custom = [1.5, -1, 0.5, 0, 2, -2, 0, 1, -0.5, 3];
        await dev.applyEqualizerGains(instance, custom);
        const now = await dev.getEqualizer(instance);
        expect(now.bands.map((b) => stepToDb(b.gainStep, now.info))).toEqual(custom);
      } finally {
        await dev.applyEqualizer(instance, before.bands);
      }
      expect((await dev.getEqualizer(instance)).bands).toEqual(before.bands);
    });
  }
});
