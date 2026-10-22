// Custom EQ presets. Like G Hub, these live on the computer; applying one writes its bands
// into the headset's single custom EQ slot.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface CustomPreset {
  id: string;
  name: string;
  /** 0 = microphone, 1 = headphones */
  instance: number;
  /** One gain per band, in dB, in the device's band order. */
  gainsDb: number[];
}

interface FileShape {
  version: 1;
  presets: CustomPreset[];
}

export class PresetStore {
  /** Read-modify-write operations run one at a time so overlapping UI actions don't lose updates. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async list(instance?: number): Promise<CustomPreset[]> {
    const all = (await this.exclusive(() => this.read())).presets;
    return instance === undefined ? all : all.filter((p) => p.instance === instance);
  }

  async save(input: Omit<CustomPreset, 'id'> & { id?: string }): Promise<CustomPreset> {
    const name = input.name.trim();
    if (!name) throw new Error('preset name is required');
    if (!Array.isArray(input.gainsDb) || input.gainsDb.some((g) => !Number.isFinite(g))) throw new Error('gains must be finite numbers');
    return this.exclusive(async () => {
      const data = await this.read();
      const preset: CustomPreset = { id: input.id ?? randomUUID(), name, instance: input.instance, gainsDb: [...input.gainsDb] };
      const at = data.presets.findIndex((p) => p.id === preset.id);
      if (at >= 0) data.presets[at] = preset;
      else data.presets.push(preset);
      await this.write(data);
      return preset;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const data = await this.read();
      const before = data.presets.length;
      data.presets = data.presets.filter((p) => p.id !== id);
      if (data.presets.length === before) return false;
      await this.write(data);
      return true;
    });
  }

  private async read(): Promise<FileShape> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, presets: [] };
      throw err;
    }
    const parsed = JSON.parse(text) as FileShape;
    if (parsed?.version !== 1 || !Array.isArray(parsed.presets)) throw new Error(`${this.file} is not a preset file`);
    return parsed;
  }

  private async write(data: FileShape): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.file);
  }
}
