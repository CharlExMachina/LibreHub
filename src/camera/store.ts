// What Libre Hub keeps on this computer for the MX Brio: the settings you chose (per camera, by
// serial number) and your own presets. The camera forgets its framing when it restarts and has no
// profile memory (G Hub's capability block: hasPersistentMemory false), so, like G Hub, Libre Hub
// puts your settings back whenever the camera connects.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SETTINGS, toRaw, type CameraSettings, type Preset, type SettingKey } from './settings.js';

export interface CameraConfig {
  version: 1;
  /** Settings by camera serial number: only the ones you changed. */
  cameras: Record<string, Partial<CameraSettings>>;
  presets: Preset[];
}

export function defaultCameraFile(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.MXBRIO_CONFIG) return env.MXBRIO_CONFIG;
  return platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'logitech-manager', 'mx-brio.json')
    : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'logitech-manager', 'mx-brio.json');
}

const GROUPS = new Set(['crop', 'exposure', 'image', 'focus']);

/** Keep only settings this version knows, with valid values (a hand-edited file may have anything). */
export function cleanSettings(input: unknown): Partial<CameraSettings> {
  const out: Partial<Record<SettingKey, unknown>> = {};
  if (!input || typeof input !== 'object') return {};
  for (const [k, v] of Object.entries(input)) {
    if (!(k in SETTINGS)) continue;
    try {
      toRaw(k as SettingKey, v as never);
      out[k as SettingKey] = v;
    } catch {
      // dropped
    }
  }
  return out as Partial<CameraSettings>;
}

function sanitize(raw: unknown): CameraConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<CameraConfig>;
  const cameras: CameraConfig['cameras'] = {};
  for (const [serial, s] of Object.entries(c.cameras ?? {})) cameras[serial] = cleanSettings(s);
  const presets = (Array.isArray(c.presets) ? c.presets : [])
    .filter((p): p is Preset => !!p && typeof p.name === 'string' && !!p.name.trim() && GROUPS.has(p.group))
    .map((p) => ({ name: p.name.trim(), group: p.group, settings: cleanSettings(p.settings) }));
  return { version: 1, cameras, presets };
}

export class CameraStore {
  /** Read-modify-write operations run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string = defaultCameraFile()) {}

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  read(): Promise<CameraConfig> {
    return this.exclusive(() => this.load());
  }

  private async load(): Promise<CameraConfig> {
    try {
      return sanitize(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, cameras: {}, presets: [] };
      if (err instanceof SyntaxError) throw new Error(`${this.file} is not valid JSON: ${err.message}`);
      throw err;
    }
  }

  /** Change the file and save it atomically (a temp file, then rename). */
  update<T>(change: (c: CameraConfig) => T): Promise<T> {
    return this.exclusive(async () => {
      const c = await this.load();
      const result = change(c);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(c, null, 2) + '\n');
      await rename(tmp, this.file);
      return result;
    });
  }
}
