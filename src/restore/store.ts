// The settings the app keeps for each headset (by serial number), and a short history of checks.
// Shared with the CLI, so a change made with `librehub headset set` is kept too.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Group, Saved } from './settings.js';

export type Trigger = 'startup' | 'wake' | 'unlock' | 'reconnect' | 'manual' | 'follow-up';

export interface HistoryEntry {
  at: string;
  trigger: Trigger;
  /** remembered: first look at this headset, its current settings are now the saved ones. */
  outcome: 'matched' | 'restored' | 'failed' | 'remembered';
  restored?: Group[];
  failed?: { group: Group; error?: string }[];
  error?: string;
  /** Set when a later check found the settings still in place. */
  confirmedAt?: string;
}

interface FileShape {
  version: 1;
  headsets: Record<string, { saved: Saved; updatedAt: string }>;
  history: HistoryEntry[];
}

const HISTORY = 40;

export class RestoreStore {
  /** Read-modify-write operations run one at a time so overlapping changes don't lose updates. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async saved(serial: string): Promise<Saved | undefined> {
    return (await this.exclusive(() => this.read())).headsets[serial]?.saved;
  }

  /** The given headset's saved settings, or the most recently updated headset's. */
  async headset(serial?: string): Promise<{ serial: string; saved: Saved } | undefined> {
    const { headsets } = await this.exclusive(() => this.read());
    const pickSerial = serial && headsets[serial] ? serial : Object.keys(headsets).sort((a, b) => headsets[b].updatedAt.localeCompare(headsets[a].updatedAt))[0];
    return pickSerial ? { serial: pickSerial, saved: headsets[pickSerial].saved } : undefined;
  }

  async history(): Promise<HistoryEntry[]> {
    return (await this.exclusive(() => this.read())).history;
  }

  /** Replace everything saved for this headset. */
  replace(serial: string, saved: Saved): Promise<void> {
    return this.update((data) => {
      data.headsets[serial] = { saved, updatedAt: new Date().toISOString() };
    });
  }

  /** Update some settings. Ignored for a headset the app isn't keeping settings for yet. */
  remember(serial: string, values: Saved): Promise<void> {
    return this.update((data) => {
      const entry = data.headsets[serial];
      if (!entry) return false;
      const saved = { ...entry.saved, ...values };
      if (JSON.stringify(saved) === JSON.stringify(entry.saved)) return false;
      entry.saved = saved;
      entry.updatedAt = new Date().toISOString();
    });
  }

  /** Forget every headset's saved settings; the next check remembers what's on the headset then. */
  forgetAll(): Promise<void> {
    return this.update((data) => {
      if (!Object.keys(data.headsets).length) return false;
      data.headsets = {};
    });
  }

  log(entry: HistoryEntry): Promise<void> {
    return this.update((data) => {
      data.history = [entry, ...data.history].slice(0, HISTORY);
    });
  }

  /** Mark the newest entry as still in place. */
  confirm(at = new Date().toISOString()): Promise<void> {
    return this.update((data) => {
      if (!data.history[0]) return false;
      data.history[0].confirmedAt = at;
    });
  }

  /** `change` returns false when it changed nothing, to skip the write. */
  private update(change: (data: FileShape) => boolean | void): Promise<void> {
    return this.exclusive(async () => {
      const data = await this.read();
      if (change(data) === false) return;
      await this.write(data);
    });
  }

  private async read(): Promise<FileShape> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, headsets: {}, history: [] };
      throw err;
    }
    let parsed: FileShape | undefined;
    try {
      parsed = JSON.parse(text) as FileShape;
    } catch {
      // fall through
    }
    if (parsed?.version !== 1 || typeof parsed.headsets !== 'object' || !Array.isArray(parsed.history)) {
      // Not worth stopping over: set the broken file aside and start again.
      await rename(this.file, `${this.file}.broken`).catch(() => undefined);
      return { version: 1, headsets: {}, history: [] };
    }
    return parsed;
  }

  private async write(data: FileShape): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.file);
  }
}
