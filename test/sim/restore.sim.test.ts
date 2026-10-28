import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { A50X, TimeoutError } from '../../src/device/a50x.js';
import { HEADPHONES, MIC } from '../../src/protocol/eq.js';
import { PresetStore } from '../../src/presets/store.js';
import { SettingsKeeper } from '../../src/restore/keeper.js';
import { capture, drift, GROUPS, groupsTouchedBy, restore, type Group } from '../../src/restore/settings.js';
import { RestoreStore } from '../../src/restore/store.js';
import { A50XService } from '../../src/service.js';
import { SimulatedA50X } from './simulated-a50x.js';

const ALL = GROUPS.map((g) => g.id) as Group[];
const tmp = async (name: string) => join(await mkdtemp(join(tmpdir(), 'a50x-restore-')), name);

const setup = async () => {
  const sim = new SimulatedA50X();
  const dev = await A50X.connect(sim);
  const svc = new A50XService(dev, new PresetStore(await tmp('presets.json')));
  return { sim, dev, svc };
};

/** What a power cycle that forgot the user's settings might look like. */
async function reset(dev: A50X) {
  await dev.setSidetone(0);
  await dev.setBalance(0);
  await dev.setNoiseGate(4);
  await dev.setBrightness(30);
  await dev.applyCuratedPreset(HEADPHONES, 2);
  const { state } = await dev.getRouting();
  await dev.setRouting({ ...state, gain: 3, inputs: state.inputs.map((i) => ({ ...i, muted: !i.muted })) });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

describe('restoring kept settings', () => {
  it('finds nothing to do when the headset matches', async () => {
    const { svc } = await setup();
    const s = await svc.snapshot();
    expect(drift(capture(s), capture(s), ALL)).toEqual([]);
    const result = await restore(svc, capture(s), ALL, s);
    expect(result).toMatchObject({ restored: [], failed: [] });
  });

  it('writes back only what changed, then confirms it with a fresh read', async () => {
    const { sim, dev, svc } = await setup();
    const applied: string[] = [];
    const apply = svc.apply.bind(svc);
    svc.apply = (a) => (applied.push(a.type), apply(a));
    const before = await svc.snapshot();
    const saved = capture(before);
    await reset(dev);
    const found = drift(saved, capture(await svc.snapshot()), ALL).map((d) => d.group);
    expect(found.sort()).toEqual(['balance', 'headphonesEq', 'headset', 'mix', 'noiseGate', 'sidetone']);

    const result = await restore(svc, saved, ALL);
    expect(result.failed).toEqual([]);
    expect(result.restored.sort()).toEqual(found);
    expect(applied.sort()).toEqual(['balance', 'brightness', 'eqGains', 'noiseGate', 'routingInput', 'routingInput', 'routingInput', 'routingInput', 'routingOutput', 'sidetone']);
    expect(capture(result.snapshot)).toEqual(saved);
    expect(capture(await svc.snapshot())).toEqual(saved);
    expect(sim.state).toMatchObject({ sidetone: 6, balance: 6, gate: 0, brightness: 100 });

    // A second pass has nothing left to write except sidetone, which a read can't confirm.
    applied.length = 0;
    expect((await restore(svc, saved, ALL)).restored).toEqual([]);
    expect(applied).toEqual(['sidetone']);
  });

  it('sends sidetone even when the base station reports it, without calling it restored', async () => {
    const { sim, svc } = await setup();
    const saved = capture(await svc.snapshot());
    const sent = sim.written.length;
    const result = await restore(svc, saved, ALL);
    expect(result).toMatchObject({ restored: [], failed: [] });
    const writes = sim.written.slice(sent).map((r) => [r[4], r[5] >> 4, ...r.slice(6, 9)]);
    expect(writes).toContainEqual([9, 1, 0x01, 0xff, 6]);

    // Not when sidetone isn't kept.
    const before = sim.written.length;
    await restore(svc, saved, ['balance']);
    expect(sim.written.slice(before).some((r) => r[4] === 9 && r[5] >> 4 === 1)).toBe(false);
  });

  it('leaves settings that aren’t kept alone', async () => {
    const { dev, svc } = await setup();
    const saved = capture(await svc.snapshot());
    await reset(dev);
    const result = await restore(svc, saved, ['sidetone']);
    expect(result.restored).toEqual(['sidetone']);
    expect((await svc.snapshot()).balance.value).toBe(0);
  });

  it('reports a value the headset refuses and still restores the rest', async () => {
    const { dev, svc } = await setup();
    const saved = { ...capture(await svc.snapshot()), noiseGate: 'stream' };
    await dev.setSidetone(1);
    const result = await restore(svc, saved, ALL);
    expect(result.restored).toEqual(['sidetone']);
    expect(result.failed).toEqual([{ group: 'noiseGate', error: expect.stringMatching(/not supported/) }]);
  });

  it('maps app actions to the settings they change', () => {
    expect(groupsTouchedBy({ type: 'mute', muted: true })).toEqual(['volume']);
    expect(groupsTouchedBy({ type: 'eqGains', instance: MIC, gainsDb: [] })).toEqual(['micEq']);
    expect(groupsTouchedBy({ type: 'routingInput', index: 1, gain: 2 })).toEqual(['mix']);
    expect(groupsTouchedBy({ type: 'savePreset', instance: 1, name: 'x', gainsDb: [] })).toEqual([]);
  });
});

describe('SettingsKeeper', () => {
  const keeperFor = async (svc: () => A50XService | undefined, groups: Group[] = ALL) => {
    const store = new RestoreStore(await tmp('restore.json'));
    const checks: string[] = [];
    const keeper = new SettingsKeeper({
      store,
      service: async () => svc(),
      config: () => ({ enabled: true, groups }),
      isLinkError: (err) => err instanceof TimeoutError,
      onCheck: (e) => checks.push(`${e.trigger}:${e.outcome}`),
      followUpMs: 30,
    });
    return { store, keeper, checks };
  };

  it('remembers on first sight, keeps app changes, restores after a wake-up and confirms it later', async () => {
    const { dev, svc } = await setup();
    const { store, keeper, checks } = await keeperFor(() => svc);
    keeper.request('reconnect');
    await until(() => checks.length === 1);
    expect(checks).toEqual(['startup:remembered']);

    // A change made in the app is kept.
    await svc.apply({ type: 'sidetone', step: 3 });
    await keeper.record({ type: 'sidetone', step: 3 }, await svc.snapshot());
    const serial = (await svc.snapshot()).device.serial;
    expect((await store.saved(serial))?.sidetone).toBe(3);

    // Sleep, the headset forgets, the computer wakes.
    keeper.suspend();
    await reset(dev);
    keeper.request('wake');
    await until(() => checks.length === 2);
    expect(checks[1]).toBe('wake:restored');
    expect((await svc.snapshot()).sidetone.step).toBe(3);
    const [entry] = await store.history();
    expect(entry.restored?.sort()).toEqual(['balance', 'headphonesEq', 'headset', 'mix', 'noiseGate', 'sidetone']);

    // The follow-up finds everything still in place and says so on the same entry.
    await until(async () => !!(await store.history())[0].confirmedAt);
    expect(checks).toHaveLength(2);
    keeper.stop();
  });

  it('waits for the headset when it isn’t there, then checks under the original reason', async () => {
    const { dev, svc } = await setup();
    let present = false;
    const { store, keeper, checks } = await keeperFor(() => (present ? svc : undefined));
    await store.replace((await svc.snapshot()).device.serial, capture(await svc.snapshot()));
    await reset(dev);
    keeper.request('wake');
    await wait(30);
    expect(checks).toEqual([]);
    present = true;
    keeper.request('reconnect');
    await until(() => checks.length === 1);
    expect(checks).toEqual(['wake:restored']);
    keeper.stop();
  });

  it('retries after the link drops mid-check', async () => {
    const { svc } = await setup();
    let fail = true;
    const flaky = Object.create(svc) as A50XService;
    flaky.snapshot = () => (fail ? Promise.reject(new TimeoutError('no response')) : svc.snapshot());
    const store = new RestoreStore(await tmp('restore.json'));
    const lost: unknown[] = [];
    const checks: string[] = [];
    const keeper = new SettingsKeeper({
      store, service: async () => flaky, config: () => ({ enabled: true, groups: ALL }),
      isLinkError: (err) => err instanceof TimeoutError, onLinkError: (e) => lost.push(e), onCheck: (e) => checks.push(`${e.trigger}:${e.outcome}`),
    });
    keeper.request('unlock');
    await until(() => lost.length === 1);
    expect(await store.history()).toEqual([]);
    fail = false;
    keeper.request('reconnect');
    await until(() => checks.length === 1);
    expect(checks).toEqual(['unlock:remembered']);
    keeper.stop();
  });

  it('ignores what the headset reports until its check has run', async () => {
    const { svc } = await setup();
    const { store, keeper, checks } = await keeperFor(() => svc);
    const serial = (await svc.snapshot()).device.serial;
    keeper.request('reconnect');
    await until(() => checks.length === 1);
    await keeper.observe({ volume: { level: 4, muted: false } });
    expect((await store.saved(serial))?.volume?.level).toBe(4);
    keeper.suspend();
    await keeper.observe({ volume: { level: 9, muted: true } });
    expect((await store.saved(serial))?.volume?.level).toBe(4);
    keeper.stop();
  });

  it('does nothing while turned off', async () => {
    const { svc } = await setup();
    const store = new RestoreStore(await tmp('restore.json'));
    const keeper = new SettingsKeeper({ store, service: async () => svc, config: () => ({ enabled: false, groups: ALL }), isLinkError: () => false });
    expect(await keeper.checkNow()).toBeUndefined();
    await keeper.record({ type: 'sidetone', step: 2 }, await svc.snapshot());
    expect(await store.history()).toEqual([]);
    expect(await store.headset()).toBeUndefined();
  });
});

describe('RestoreStore', () => {
  it('only updates headsets it keeps, skips no-op writes and caps the history', async () => {
    const file = await tmp('restore.json');
    const store = new RestoreStore(file);
    await store.remember('A', { sidetone: 1 });
    expect(await store.headset()).toBeUndefined();
    await store.replace('A', { sidetone: 1, balance: 6 });
    await store.remember('A', { sidetone: 2 });
    expect(await store.saved('A')).toEqual({ sidetone: 2, balance: 6 });
    const text = await readFile(file, 'utf8');
    await store.remember('A', { sidetone: 2 });
    expect(await readFile(file, 'utf8')).toBe(text);
    for (let i = 0; i < 50; i++) await store.log({ at: new Date(i).toISOString(), trigger: 'manual', outcome: 'matched' });
    expect(await store.history()).toHaveLength(40);
    await store.forgetAll();
    expect(await store.headset()).toBeUndefined();
  });

  it('sets a broken file aside instead of failing', async () => {
    const file = await tmp('restore.json');
    await writeFile(file, '{ nope');
    const store = new RestoreStore(file);
    expect(await store.history()).toEqual([]);
    expect(await readFile(`${file}.broken`, 'utf8')).toBe('{ nope');
  });
});
