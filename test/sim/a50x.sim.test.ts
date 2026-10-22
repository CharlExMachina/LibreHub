import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { A50X, DeviceError, TimeoutError } from '../../src/device/a50x.js';
import { Feature } from '../../src/protocol/features.js';
import { HEADPHONES, MIC } from '../../src/protocol/eq.js';
import { PresetStore } from '../../src/presets/store.js';
import { A50XService } from '../../src/service.js';
import { FEATURE_TABLE } from '../fixtures/captures.js';
import { SimulatedA50X } from './simulated-a50x.js';

const connect = async (opts = {}) => {
  const sim = new SimulatedA50X();
  const dev = await A50X.connect(sim, opts);
  return { sim, dev };
};

const nextEvent = <T>(dev: A50X, name: string) => new Promise<T>((resolve) => dev.once(name, resolve));

describe('A50X client against the simulated base station', () => {
  it('discovers the full feature table through Root and FeatureSet', async () => {
    const { dev } = await connect();
    expect(dev.features.map((f) => [f.index, f.id])).toEqual(FEATURE_TABLE.map(([i, id]) => [i, id]));
    expect(dev.has(Feature.PARAMETRIC_EQ)).toBe(true);
  });

  it('reads device information', async () => {
    const { dev } = await connect();
    expect(await dev.getDeviceInfo()).toMatchObject({ model: 'A50 X', name: "Carlos'", serial: '0000XX0X0X00', firmware: { version: '1.2.18' } });
    expect(await dev.getBluetoothHost()).toEqual({ name: 'Example Bluetooth Host 01234', address: '00:00:5E:00:53:01' });
  });

  it('sets each setting and receives the matching device event', async () => {
    const { dev, sim } = await connect();
    const sidetone = nextEvent<{ step: number }>(dev, 'sidetone');
    await dev.setSidetone(2);
    expect((await sidetone).step).toBe(2);
    expect(await dev.getSidetone()).toEqual({ step: 2, max: 6 });

    const volume = nextEvent<{ level: number }>(dev, 'volume');
    await dev.setVolume(10);
    expect((await volume).level).toBe(10);
    await dev.setMuted(true);
    expect(await dev.getVolume()).toEqual({ level: 10, max: 21, muted: true });

    await dev.setBalance(0);
    expect(await dev.getBalance()).toEqual({ value: 0, max: 12, center: 6 });
    await dev.setSleepTimer(0);
    expect((await dev.getSleepTimer()).minutes).toBe(0);
    await dev.setBrightness(40);
    expect(await dev.getBrightness()).toBe(40);
    await dev.setTones(2);
    expect(await dev.getTones()).toBe(2);
    await dev.setNoiseGate(4);
    expect(await dev.getNoiseGate()).toEqual({ value: 4, supported: [0, 1, 2, 4] });
    expect(sim.state).toMatchObject({ sidetone: 2, volume: 10, muted: true, balance: 0, sleep: [0x3c, 0], brightness: 40, tones: 2, gate: 4 });
  });

  it('round-trips routing and EQ', async () => {
    const { dev } = await connect();
    const routing = await dev.getRouting();
    expect(routing.inputs.map((i) => i.name)).toEqual(['mic', 'game', 'bluetooth', 'voice']);
    const changed = { ...routing.state, inputs: routing.state.inputs.map((i) => ({ ...i, gain: 8 })) };
    const ev = nextEvent(dev, 'routing');
    await dev.setRouting(changed);
    expect(await ev).toEqual(changed);
    expect((await dev.getRouting()).state).toEqual(changed);

    const gaming = await dev.getOnboardPreset(HEADPHONES, 1);
    const eqEvent = nextEvent<{ instance: number; bands: unknown }>(dev, 'equalizer');
    await dev.applyCuratedPreset(HEADPHONES, 1);
    expect(await eqEvent).toEqual({ instance: HEADPHONES, slot: 3, bands: gaming });
    expect((await dev.getEqualizer(HEADPHONES)).bands).toEqual(gaming);

    await dev.applyEqualizerGains(MIC, [1, 1, 1, 1, 1, -1, -1, -1, -1, -1]);
    const mic = await dev.getEqualizer(MIC);
    expect(mic.bands.map((b) => b.gainStep)).toEqual([140, 140, 140, 140, 140, 100, 100, 100, 100, 100]);
    expect(mic.bands.every((b) => b.q === 0x16)).toBe(true);
  });

  it('turns device error frames into DeviceError with the code', async () => {
    const { dev } = await connect();
    const err = await dev.request(9, 1, [0x01, 0xff, 0x09]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceError);
    expect(err).toMatchObject({ featureId: Feature.SIDETONE, fn: 1, code: 0x0b });
    await expect(dev.call(Feature.VOLUME, 1, [0x00, 0x05])).rejects.toMatchObject({ code: 0x05 });
  });

  it('validates arguments against device limits and never writes an out-of-range value', async () => {
    // The real firmware clamps instead of rejecting (balance 99 became 12), so this must hold client-side.
    const { dev, sim } = await connect();
    const writesTo = (idx: number, fn: number) => sim.written.filter((r) => r[4] === idx && r[5] >> 4 === fn).length;
    await expect(dev.setBalance(13)).rejects.toThrow('balance must be an integer 0..12');
    await expect(dev.setSidetone(7)).rejects.toThrow('0..6');
    await expect(dev.setVolume(22)).rejects.toThrow('0..21');
    await expect(dev.setVolume(1.5)).rejects.toThrow(RangeError);
    await expect(dev.setSleepTimer(61)).rejects.toThrow('0..60');
    await expect(dev.setTones(3)).rejects.toThrow('0..2');
    await expect(dev.setBrightness(150)).rejects.toThrow(RangeError);
    await expect(dev.setNoiseGate(6)).rejects.toThrow('not supported');
    const r = (await dev.getRouting()).state;
    await expect(dev.setRouting({ ...r, gain: 33 })).rejects.toThrow('output gain');
    await expect(dev.setRouting({ ...r, inputs: [{ index: 7, gain: 1, muted: false }] })).rejects.toThrow('no routing input 7');
    await expect(dev.setRouting({ ...r, output: 2 })).rejects.toThrow('no routing output 2');
    await expect(dev.applyEqualizer(MIC, [])).rejects.toThrow('expected 10 bands');
    await expect(dev.getOnboardPreset(MIC, 3)).rejects.toThrow(RangeError);
    for (const idx of [7, 8, 9, 10, 15, 16]) expect(writesTo(idx, 1)).toBe(0);
    expect(writesTo(22, 2)).toBe(0); // noise gate set
    expect(writesTo(12, 6)).toBe(0); // routing set
    expect(writesTo(13, 2)).toBe(0); // EQ apply
  });

  it('times out when the device does not answer, then keeps working', async () => {
    const { dev, sim } = await connect({ timeoutMs: 50 });
    sim.silentIndexes.add(15);
    await expect(dev.getBrightness()).rejects.toBeInstanceOf(TimeoutError);
    sim.silentIndexes.clear();
    expect(await dev.getBrightness()).toBe(100);
  });

  it('serializes concurrent requests so responses are never mixed up', async () => {
    const { dev } = await connect();
    const [a, b, c] = await Promise.all([dev.getSidetone(), dev.getBrightness(), dev.getBalance()]);
    expect([a.step, b, c.value]).toEqual([6, 100, 6]);
  });

  it('ignores responses meant for another software id (e.g. G Hub on macOS)', async () => {
    const { dev, sim } = await connect({ timeoutMs: 100 });
    // G Hub's own brightness reply (swid 0xE, value 7) arrives while ours is in flight; it must not resolve our request.
    sim.beforeReply = () => sim.inject([0x00, 15, 0x0e, 7, 0]);
    expect(await dev.getBrightness()).toBe(100);
    expect(sim.beforeReply).toBeUndefined();
  });

  it('emits events the headset sends on its own (e.g. sidetone wheel)', async () => {
    const { dev, sim } = await connect();
    const ev = nextEvent<{ step: number }>(dev, 'sidetone');
    sim.emitEvent(9, [1, 1, 0xff, 3]);
    expect((await ev).step).toBe(3);
  });

  it('rejects calls to features the device does not have', async () => {
    const { dev } = await connect();
    await expect(dev.call(0x0605, 0)).rejects.toThrow('not present');
  });
});

describe('A50XService (what the Electron app and CLI use)', () => {
  const service = async () => {
    const { sim, dev } = await connect();
    const file = join(await mkdtemp(join(tmpdir(), 'a50x-svc-')), 'presets.json');
    return { sim, file, svc: new A50XService(dev, new PresetStore(file)) };
  };

  it('builds a full snapshot', async () => {
    const { svc } = await service();
    const s = await svc.snapshot();
    expect(s).toMatchObject({
      battery: 95,
      sidetone: { step: 6, max: 6 },
      volume: { level: 21, max: 21, muted: false },
      balance: { value: 6, max: 12 },
      sleep: { minutes: 30, choices: [0, 15, 30, 60] },
      brightness: 100,
      tones: 'all',
      noiseGate: { value: 'off', supported: ['off', 'home', 'night', 'tournament'] },
      routing: { output: { gain: 26, muted: false }, maxGain: 32 },
    });
    expect(s.routing.inputs.map((i) => [i.name, i.muted])).toEqual([['mic', true], ['game', false], ['bluetooth', true], ['voice', false]]);
    expect(s.equalizers.map((e) => [e.label, e.matches])).toEqual([['Microphone', 'Default'], ['Headphones', 'Default']]);
    expect(s.equalizers[1].frequencies).toEqual([20, 50, 125, 250, 500, 1000, 2500, 5000, 10000, 20000]);
  });

  it('applies named settings and routing tweaks', async () => {
    const { svc, sim } = await service();
    await svc.apply({ type: 'tones', value: 'minimal' });
    await svc.apply({ type: 'noiseGate', value: 'night' });
    await svc.apply({ type: 'routingInput', index: 1, gain: 4, muted: true });
    await svc.apply({ type: 'routingOutput', gain: 32 });
    expect(sim.state.tones).toBe(2);
    expect(sim.state.gate).toBe(2);
    expect(sim.state.routing.gain).toBe(32);
    expect(sim.state.routing.inputs[1]).toEqual([1, 4, 1]);
    await expect(svc.apply({ type: 'noiseGate', value: 'clearVoice' })).rejects.toThrow('not supported');
    await expect(svc.apply({ type: 'routingInput', index: 9, gain: 1 })).rejects.toThrow('no routing input');
  });

  it('applies curated presets and saves/applies/deletes custom ones', async () => {
    const { svc } = await service();
    await svc.apply({ type: 'eqCurated', instance: HEADPHONES, preset: 2 });
    expect((await svc.snapshot()).equalizers[1].matches).toBe('Media');

    const gains = [2, 2, 1, 0, 0, 0, 1, 2, 3, 3];
    await svc.apply({ type: 'savePreset', instance: HEADPHONES, name: 'Mine', gainsDb: gains });
    const [mine] = (await svc.snapshot()).equalizers[1].custom;
    await svc.apply({ type: 'eqCustom', id: mine.id });
    const after = (await svc.snapshot()).equalizers[1];
    expect(after.gainsDb).toEqual(gains);
    expect(after.matches).toBe('Mine');
    await svc.apply({ type: 'deletePreset', id: mine.id });
    expect((await svc.snapshot()).equalizers[1].custom).toEqual([]);
  });

  it('still works when the preset file is unreadable, and refuses to overwrite it', async () => {
    const { svc, file } = await service();
    await writeFile(file, '{"something":"else"}');
    const snap = await svc.snapshot();
    expect(snap.equalizers[1].custom).toEqual([]);
    expect(snap.presetsError).toMatch('not a preset file');
    await expect(svc.apply({ type: 'savePreset', instance: 1, name: 'x', gainsDb: new Array(10).fill(0) })).rejects.toThrow('not a preset file');
    expect(await readFile(file, 'utf8')).toBe('{"something":"else"}');
  });

  it('keeps both changes when routing actions overlap', async () => {
    const { svc, sim } = await service();
    const before = sim.state.routing.inputs.map((i) => [...i]);
    await Promise.all([
      svc.apply({ type: 'routingInput', index: 0, muted: false }),
      svc.apply({ type: 'routingOutput', muted: true }),
      svc.apply({ type: 'routingInput', index: 1, gain: 3 }),
    ]);
    const { routing } = await svc.snapshot();
    expect(routing.output.muted).toBe(true);
    expect(routing.inputs.find((i) => i.index === 0)?.muted).toBe(false);
    expect(routing.inputs.find((i) => i.index === 1)?.gain).toBe(3);
    expect(before[0][2]).toBe(1);
  });

  it('restores or overwrites a custom preset when saved with its id', async () => {
    const { svc } = await service();
    await svc.apply({ type: 'savePreset', instance: HEADPHONES, name: 'Mine', gainsDb: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
    const [mine] = (await svc.snapshot()).equalizers[1].custom;
    await svc.apply({ type: 'deletePreset', id: mine.id });
    await svc.apply({ type: 'savePreset', id: mine.id, instance: HEADPHONES, name: 'Mine', gainsDb: mine.gainsDb });
    expect((await svc.snapshot()).equalizers[1].custom).toEqual([mine]);
    await svc.apply({ type: 'savePreset', id: mine.id, instance: HEADPHONES, name: 'Mine v2', gainsDb: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2] });
    const custom = (await svc.snapshot()).equalizers[1].custom;
    expect(custom.map((p) => [p.id, p.name, p.gainsDb[0]])).toEqual([[mine.id, 'Mine v2', 2]]);
  });
});
