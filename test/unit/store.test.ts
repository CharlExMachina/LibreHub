import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PresetStore } from '../../src/presets/store.js';

const fresh = async () => join(await mkdtemp(join(tmpdir(), 'a50x-presets-')), 'nested', 'presets.json');

describe('PresetStore', () => {
  it('starts empty, saves, updates, filters and removes', async () => {
    const store = new PresetStore(await fresh());
    expect(await store.list()).toEqual([]);
    const a = await store.save({ name: ' Bass ', instance: 1, gainsDb: [3, 2, 1, 0, 0, 0, 0, 0, 0, 0] });
    expect(a.name).toBe('Bass');
    await store.save({ name: 'Voice', instance: 0, gainsDb: new Array(10).fill(0) });
    await store.save({ ...a, name: 'Bass+' });
    expect((await store.list(1)).map((p) => p.name)).toEqual(['Bass+']);
    expect(await store.list()).toHaveLength(2);
    expect(await store.remove(a.id)).toBe(true);
    expect(await store.remove(a.id)).toBe(false);
    expect((await store.list()).map((p) => p.name)).toEqual(['Voice']);
  });

  it('validates input and refuses foreign files', async () => {
    const file = await fresh();
    const store = new PresetStore(file);
    await expect(store.save({ name: '  ', instance: 0, gainsDb: [] })).rejects.toThrow('name');
    await expect(store.save({ name: 'x', instance: 0, gainsDb: [Number.NaN] })).rejects.toThrow('finite');
    await store.save({ name: 'ok', instance: 0, gainsDb: [0] });
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
    await writeFile(file, '{"something":"else"}');
    await expect(store.list()).rejects.toThrow('not a preset file');
  });
});

describe('PresetStore concurrency', () => {
  it('does not lose updates when operations overlap (two quick clicks in the UI)', async () => {
    const store = new PresetStore(await fresh());
    const saved = await Promise.all(['a', 'b', 'c', 'd'].map((name) => store.save({ name, instance: 1, gainsDb: [0] })));
    expect(await store.list()).toHaveLength(4);
    await Promise.all(saved.map((p) => store.remove(p.id)));
    expect(await store.list()).toEqual([]);
  });
});
