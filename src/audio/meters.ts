// Linux only: live audio levels for the Stream Mix and Microphone pages.
//
// Each meter runs `pw-record` on one of the base station's PipeWire nodes (the ones the audio split
// names, see split.ts) and boils the samples down to a level about 30 times a second. Samples stay
// in this process and are dropped as soon as they're measured: nothing is recorded or stored, and
// the window only ever sees the numbers. Meters run only while the window asks for them.
//
// Chromium's getUserMedia could read the Mic and Stream Out sources, but it can't open the monitors
// of the Game and Voice outputs, and it would need a media permission in the sandboxed window.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioSplitStatus } from './split.js';

/** What can be metered: the mic, the stream port's output, and what this computer plays to Game and Voice. */
export const METER_KEYS = ['mic', 'streamOut', 'game', 'voice'] as const;
export type MeterKey = (typeof METER_KEYS)[number];

/** Outputs are read from their monitor, i.e. what's being played into them. */
const MONITORS: ReadonlySet<MeterKey> = new Set(['game', 'voice']);

export const FRAME_MS = 33;
/** Levels are floored here; anything quieter reads as silence. */
export const FLOOR_DB = -100;
/** How fast the bar falls after a peak, and how long the peak marker stays put. */
export const RELEASE_DB_PER_S = 24;
export const HOLD_MS = 1500;
/** A source (not an output's monitor) that sends nothing for this long has stopped. */
export const STALL_MS = 1500;

export const toDb = (amplitude: number) => (amplitude > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(amplitude)) : FLOOR_DB);

/** Peak meter with an instant attack, a steady release and a peak marker that holds, then falls. */
export class Ballistics {
  level = FLOOR_DB;
  hold = FLOOR_DB;
  private heldFor = 0;

  /** Feed the loudest sample (in dBFS) of the last `ms`; returns the bar and peak-marker levels. */
  step(peakDb: number, ms: number): { level: number; hold: number } {
    const fall = (RELEASE_DB_PER_S * ms) / 1000;
    this.level = Math.max(peakDb, this.level - fall, FLOOR_DB);
    if (peakDb >= this.hold) {
      this.hold = peakDb;
      this.heldFor = 0;
    } else {
      this.heldFor += ms;
      if (this.heldFor > HOLD_MS) this.hold = Math.max(this.level, this.hold - fall, FLOOR_DB);
    }
    return { level: this.level, hold: this.hold };
  }
}

const NONE = Buffer.alloc(0);

/** Running peak over raw 32-bit float samples that arrive in arbitrary chunks. */
export class PeakReader {
  peak = 0;
  /** Whether any samples arrived since the last take(). */
  fed = false;
  private rest = Buffer.alloc(0);

  push(chunk: Buffer): void {
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const whole = buf.length - (buf.length % 4);
    // A Float32Array view needs 4-byte alignment; pipe chunks almost always have it.
    if (buf.byteOffset % 4) buf = Buffer.from(buf);
    const samples = new Float32Array(buf.buffer, buf.byteOffset, whole / 4);
    let peak = this.peak;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak && a < Infinity) peak = a;
    }
    this.peak = peak;
    this.rest = whole === buf.length ? NONE : Buffer.from(buf.subarray(whole));
    this.fed ||= whole > 0;
  }

  /** The peak since the last call (0 when nothing arrived, e.g. an idle output), then start over. */
  take(): number {
    const p = this.peak;
    this.peak = 0;
    this.fed = false;
    return p;
  }
}

/** pw-record arguments for one meter. */
export function recordArgs(key: MeterKey, node: string): string[] {
  const props = [
    'application.name = "A50 X level meter"',
    `node.name = "a50x-level-${key}"`,
    'media.name = "Level meter (nothing is recorded)"',
    // Never let WirePlumber remember this stream or move it to some other device.
    'state.restore-props = false',
    'state.restore-target = false',
    'node.dont-reconnect = true',
    'node.dont-fallback = true',
    // Read what's played into an output, without keeping it awake when nothing plays.
    ...(MONITORS.has(key) ? ['stream.capture.sink = true', 'node.passive = true'] : []),
  ];
  return ['--raw', '--format', 'f32', '--channels', '2', '--rate', '48000', '--latency', '20ms',
    '--target', node, '-P', `{ ${props.join(' ')} }`, '-'];
}

/** One frame: [bar level, peak marker, raw peak of the last frame] in dBFS, per meter. */
export type Frame = Partial<Record<MeterKey, [number, number, number]>>;

export interface WatchResult {
  /** The meters that are running. */
  running: MeterKey[];
  /** Why none could start, when none did. */
  error?: string;
}

const onPath = (cmd: string) => (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, cmd)));

/**
 * Take over reading a child's stdout pipe: returns its file descriptor, to read without waiting for
 * events. Node's own pipes are non-blocking, so a read returns EAGAIN rather than waiting when nothing
 * has arrived (an idle output sends nothing). Node starts reading a child's stdout as soon as it's
 * created, so this stops it first: otherwise Node would buffer what comes first (and could close the fd
 * by itself at the end). Undefined if it isn't such a pipe: then the stream's events are used instead.
 */
export function takePipe(proc: ChildProcess): number | undefined {
  const handle = (proc.stdout as unknown as { _handle?: { fd?: unknown; reading?: boolean; readStop?: () => number } } | null)?._handle;
  const fd = handle?.fd;
  if (typeof fd !== 'number' || fd < 0 || typeof handle!.readStop !== 'function') return undefined;
  handle!.reading = false;
  handle!.readStop();
  return fd;
}

/** Start pw-record so that it also ends if this process dies without stopping it (setpriv execs, keeping the pid). */
function spawnRecorder(cmd: string, args: string[]): ChildProcess {
  const [file, argv] = onPath('setpriv') ? ['setpriv', ['--pdeathsig', 'TERM', '--', cmd, ...args]] : [cmd, args];
  return nodeSpawn(file, argv, { stdio: ['ignore', 'pipe', 'ignore'] });
}

export interface MeterDeps {
  /** PipeWire node names of the split's devices (AudioSplitStatus.nodes). */
  nodes: () => Promise<AudioSplitStatus['nodes'] | null>;
  onFrame: (frame: Frame) => void;
  /** A running meter stopped by itself (pw-record ended, or a source stopped sending). */
  onLost?: (key: MeterKey) => void;
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  /** Reads what's waiting in a pipe (fs.readSync); throws EAGAIN when nothing is. */
  read?: (fd: number, buf: Buffer) => number;
  /** Whether pw-record is installed. */
  installed?: () => boolean;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  now?: () => number;
}

interface Meter {
  key: MeterKey;
  proc: ChildProcess;
  reader: PeakReader;
  /** pw-record's stdout, read on each tick; undefined when it's read as it arrives instead. */
  fd?: number;
  ballistics: Ballistics;
  /** Last raw peak (dBFS) and when samples last arrived. */
  peak: number;
  heard: number;
}

export class LevelMeters {
  private readonly meters = new Map<MeterKey, Meter>();
  private timer: unknown;
  private last = 0;
  private generation = 0;
  private readonly spawn: NonNullable<MeterDeps['spawn']>;
  private readonly read: NonNullable<MeterDeps['read']>;
  private readonly now: () => number;
  private readonly buf = Buffer.alloc(64 * 1024);

  constructor(private readonly deps: MeterDeps) {
    this.spawn = deps.spawn ?? spawnRecorder;
    this.read = deps.read ?? ((fd, buf) => readSync(fd, buf, 0, buf.length, null));
    this.now = deps.now ?? Date.now;
  }

  get running(): MeterKey[] {
    return [...this.meters.keys()];
  }

  /** Run exactly these meters (an empty list stops everything). Unknown keys are ignored. */
  async watch(keys: unknown[]): Promise<WatchResult> {
    const want = METER_KEYS.filter((k) => keys.includes(k));
    const gen = ++this.generation;
    for (const key of this.meters.keys()) if (!want.includes(key)) this.end(key);
    const missing = want.filter((k) => !this.meters.has(k));
    if (!missing.length) {
      this.schedule();
      return { running: this.running };
    }
    if (!(this.deps.installed ?? (() => onPath('pw-record')))()) {
      this.stop();
      return { running: [], error: NOT_INSTALLED };
    }
    const nodes = await this.deps.nodes().catch(() => null);
    // A newer watch() call ran while the nodes were being looked up: that one decides.
    if (gen !== this.generation) return { running: this.running };
    const errors = missing.some((key) => !nodes?.[key])
      ? ['The base station’s audio devices aren’t available.']
      : await Promise.all(missing.map((key) => this.begin(key, nodes![key]!)));
    if (gen !== this.generation) return { running: this.running };
    const error = errors.find(Boolean);
    // All or nothing: never leave the mic running behind an error message.
    if (error) {
      this.stop();
      return { running: [], error };
    }
    this.schedule();
    return { running: this.running };
  }

  stop(): void {
    this.generation++;
    for (const key of [...this.meters.keys()]) this.end(key);
    this.schedule();
  }

  /** Start one meter; resolves with an error message if pw-record couldn't be started. */
  private begin(key: MeterKey, node: string): Promise<string | undefined> {
    const proc = this.spawn('pw-record', recordArgs(key, node));
    // Allow twice the stall time for pw-record to start (measured: 10-30 ms).
    const meter: Meter = { key, proc, reader: new PeakReader(), fd: takePipe(proc), ballistics: new Ballistics(), peak: FLOOR_DB, heard: this.now() + STALL_MS };
    // pw-record writes about 47 times a second per meter. Reading the pipe on each tick instead wakes
    // this process 30 times a second in all, rather than once per write of every meter.
    if (meter.fd === undefined) proc.stdout?.on('data', (chunk: Buffer) => meter.reader.push(chunk));
    proc.on('exit', () => this.lost(meter));
    this.meters.set(key, meter);
    return new Promise((resolve) => {
      proc.once('spawn', () => resolve(undefined));
      proc.once('error', (err: NodeJS.ErrnoException) => {
        // Reported by watch() itself, not as a meter that stopped later.
        if (this.meters.get(key) === meter) this.end(key);
        resolve(err.code === 'ENOENT' ? NOT_INSTALLED : err.message);
      });
    });
  }

  /** pw-record went away or went quiet (PipeWire restarted, the device vanished...): drop the meter and say so. */
  private lost(meter: Meter): void {
    if (this.meters.get(meter.key) !== meter) return;
    this.meters.delete(meter.key);
    close(meter);
    this.schedule();
    this.deps.onLost?.(meter.key);
  }

  private end(key: MeterKey): void {
    const meter = this.meters.get(key);
    if (!meter) return;
    this.meters.delete(key);
    close(meter);
  }

  /** Take in what pw-record wrote since the last tick. */
  private drain(m: Meter): void {
    if (m.fd === undefined) return;
    for (;;) {
      let n: number;
      try {
        n = this.read(m.fd, this.buf);
      } catch (err) {
        // EAGAIN: nothing more for now. Anything else: the pipe broke, which counts as the meter stopping.
        if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') this.lost(m);
        return;
      }
      // 0 is the end of the pipe: pw-record ended, and its exit is reported as the meter stopping.
      if (!n) return;
      m.reader.push(this.buf.subarray(0, n));
    }
  }

  private schedule(): void {
    const set = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    const clear = this.deps.clearInterval ?? ((t) => clearInterval(t as NodeJS.Timeout));
    if (this.meters.size && !this.timer) {
      this.last = this.now();
      this.timer = set(() => this.tick(), FRAME_MS);
    } else if (!this.meters.size && this.timer) {
      clear(this.timer);
      this.timer = undefined;
    }
  }

  /** Measure every meter once; exposed for tests. */
  tick(): void {
    const now = this.now();
    const ms = Math.max(1, now - this.last);
    this.last = now;
    // The process was stalled or the machine slept: pipes haven't been read yet, so that's no stall.
    if (ms > STALL_MS / 2) for (const m of this.meters.values()) m.heard = now;
    for (const m of [...this.meters.values()]) this.drain(m);
    const frame: Frame = {};
    for (const m of [...this.meters.values()]) {
      // An output's monitor sends nothing while nothing plays: that's silence. A source always
      // sends; a tick that caught no samples keeps the last reading, and a long gap means it stopped.
      if (m.reader.fed) m.heard = now;
      else if (!MONITORS.has(m.key) && now - m.heard > STALL_MS) {
        this.lost(m);
        continue;
      }
      if (m.reader.fed || MONITORS.has(m.key)) m.peak = toDb(m.reader.take());
      const { level, hold } = m.ballistics.step(m.peak, ms);
      frame[m.key] = [round(level), round(hold), round(m.peak)];
    }
    if (Object.keys(frame).length) this.deps.onFrame(frame);
  }
}

const round = (db: number) => Math.round(db * 10) / 10;

/** Stop pw-record and close our end of its pipe (an unread pipe isn't closed by the process ending). */
function close(meter: Meter): void {
  meter.proc.stdout?.removeAllListeners('data');
  meter.proc.kill();
  meter.proc.stdout?.destroy();
}
const NOT_INSTALLED = 'pw-record (part of PipeWire) isn’t installed.';
