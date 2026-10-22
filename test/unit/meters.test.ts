import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ballistics, FLOOR_DB, HOLD_MS, LevelMeters, PeakReader, RELEASE_DB_PER_S, STALL_MS, recordArgs, toDb, type Frame, type MeterKey } from '../../src/audio/meters.js';

const NODES = {
  game: 'alsa_output.usb-Logitech_A50_X-00.pro-output-1',
  voice: 'alsa_output.usb-Logitech_A50_X-00.pro-output-0',
  mic: 'alsa_input.usb-Logitech_A50_X-00.pro-input-0',
  streamOut: 'alsa_input.usb-Logitech_A50_X-00.pro-input-1',
};

const floats = (...xs: number[]) => {
  const b = Buffer.alloc(xs.length * 4);
  xs.forEach((x, i) => b.writeFloatLE(x, i * 4));
  return b;
};

class FakeStdout extends EventEmitter {
  destroyed = false;
  /** Set for a pipe that's read on each tick (see takePipe). */
  _handle?: { fd: number; reading: boolean; readStop: () => number };
  destroy() {
    this.destroyed = true;
  }
}

class FakeProc extends EventEmitter {
  stdout = new FakeStdout();
  killed = false;
  constructor(public args: string[], fail?: NodeJS.ErrnoException | false, fd?: number) {
    super();
    if (fd !== undefined) this.stdout._handle = { fd, reading: true, readStop: () => 0 };
    setImmediate(() => (fail ? this.emit('error', fail) : this.emit('spawn')));
  }
  kill() {
    this.killed = true;
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

const eagain = () => Object.assign(new Error('EAGAIN: resource temporarily unavailable, read'), { code: 'EAGAIN' });

function setup({ nodes = NODES as Record<string, string> | null, fail = undefined as NodeJS.ErrnoException | undefined, failFor = '', installed = true, pipes = false } = {}) {
  const procs: FakeProc[] = [];
  /** With pipes: what each pw-record has written and nobody has read yet, by fd. */
  const written = new Map<number, (Buffer | Error)[]>();
  const reads: number[] = [];
  const frames: Frame[] = [];
  const lost: MeterKey[] = [];
  let timers = 0;
  let t = 0;
  const meters = new LevelMeters({
    nodes: async () => nodes,
    onFrame: (f) => frames.push(f),
    onLost: (k) => lost.push(k),
    spawn: (_cmd, args) => {
      const p = new FakeProc(args, failFor && args.includes(failFor) ? Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }) : fail, pipes ? 10 + procs.length : undefined);
      procs.push(p);
      return p as unknown as ChildProcess;
    },
    read: (fd, buf) => {
      reads.push(fd);
      const next = written.get(fd)?.shift();
      if (!next) throw eagain();
      if (next instanceof Error) throw next;
      // Like read(2): as much as fits, the rest stays in the pipe.
      if (next.length > buf.length) written.get(fd)!.unshift(next.subarray(buf.length));
      return next.copy(buf);
    },
    installed: () => installed,
    setInterval: () => ++timers,
    clearInterval: () => timers--,
    now: () => t,
  });
  const target = (p: FakeProc) => p.args[p.args.indexOf('--target') + 1];
  const write = (p: FakeProc, data: Buffer | Error) => {
    const fd = p.stdout._handle!.fd;
    written.set(fd, [...(written.get(fd) ?? []), data]);
  };
  return { meters, procs, frames, lost, target, write, reads, timers: () => timers, advance: (ms: number) => (t += ms) };
}

describe('levels', () => {
  it('converts amplitude to dBFS with a floor', () => {
    expect(toDb(1)).toBe(0);
    expect(toDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(toDb(1 / 32768)).toBeCloseTo(-90.3, 1);
    expect(toDb(0)).toBe(FLOOR_DB);
  });

  it('reads float samples split across chunks at any byte offset', () => {
    const r = new PeakReader();
    const data = floats(0.1, -0.7, 0.25);
    r.push(data.subarray(0, 5));
    r.push(data.subarray(5, 9));
    expect(r.peak).toBeCloseTo(0.7, 5);
    r.push(data.subarray(9));
    expect(r.take()).toBeCloseTo(0.7, 5);
    expect(r.take()).toBe(0);
  });

  it('attacks instantly, falls steadily and holds the peak marker', () => {
    const b = new Ballistics();
    expect(b.step(-10, 33)).toEqual({ level: -10, hold: -10 });
    const fell = b.step(FLOOR_DB, 100);
    expect(fell.level).toBeCloseTo(-10 - RELEASE_DB_PER_S * 0.1, 5);
    expect(fell.hold).toBe(-10);
    // The marker stays until the hold time has passed, then falls too.
    for (let ms = 100; ms < HOLD_MS; ms += 100) b.step(FLOOR_DB, 100);
    expect(b.hold).toBe(-10);
    b.step(FLOOR_DB, 200);
    expect(b.hold).toBeLessThan(-10);
    for (let i = 0; i < 100; i++) b.step(FLOOR_DB, 100);
    expect(b.level).toBe(FLOOR_DB);
    expect(b.hold).toBe(FLOOR_DB);
  });
});

describe('pw-record arguments', () => {
  it('reads a source directly, and an output from its monitor without keeping it awake', () => {
    const mic = recordArgs('mic', NODES.mic).join(' ');
    expect(mic).toContain(`--target ${NODES.mic}`);
    expect(mic).not.toContain('stream.capture.sink');
    expect(mic).not.toContain('node.passive');
    const game = recordArgs('game', NODES.game).join(' ');
    expect(game).toContain('stream.capture.sink = true');
    expect(game).toContain('node.passive = true');
  });

  it('writes to stdout only, and keeps WirePlumber from remembering or moving the stream', () => {
    for (const key of ['mic', 'streamOut', 'game', 'voice'] as const) {
      const args = recordArgs(key, NODES[key]);
      expect(args.at(-1)).toBe('-');
      const props = args[args.indexOf('-P') + 1];
      for (const p of ['state.restore-props = false', 'state.restore-target = false', 'node.dont-reconnect = true', 'node.dont-fallback = true']) {
        expect(props).toContain(p);
      }
    }
  });
});

describe('LevelMeters', () => {
  it('runs exactly the meters asked for, keeping ones that are already running', async () => {
    const { meters, procs, target, timers } = setup();
    expect(await meters.watch(['mic'])).toEqual({ running: ['mic'] });
    expect(procs.map(target)).toEqual([NODES.mic]);
    expect(timers()).toBe(1);

    await meters.watch(['streamOut', 'mic', 'game', 'voice']);
    expect(procs).toHaveLength(4);
    expect(procs[0].killed).toBe(false);

    await meters.watch(['mic']);
    expect(procs.slice(1).every((p) => p.killed)).toBe(true);
    expect(procs[0].killed).toBe(false);

    await meters.watch([]);
    expect(procs[0].killed).toBe(true);
    expect(meters.running).toEqual([]);
    expect(timers()).toBe(0);
  });

  it('ignores keys it doesn’t know, so the window can’t pick other devices', async () => {
    const { meters, procs } = setup();
    expect(await meters.watch(['bluetooth', '../../etc', 42, 'mic'])).toEqual({ running: ['mic'] });
    expect(procs).toHaveLength(1);
  });

  it('starts nothing without the split’s devices, and says so', async () => {
    const { meters, procs } = setup({ nodes: null });
    const res = await meters.watch(['mic']);
    expect(res.running).toEqual([]);
    expect(res.error).toMatch(/aren’t available/);
    expect(procs).toHaveLength(0);
  });

  it('reports a missing pw-record instead of showing silence', async () => {
    expect((await setup({ installed: false }).meters.watch(['mic'])).error).toMatch(/isn’t installed/);
    const enoent = Object.assign(new Error('spawn pw-record ENOENT'), { code: 'ENOENT' });
    const { meters } = setup({ fail: enoent });
    const res = await meters.watch(['mic']);
    expect(res).toEqual({ running: [], error: 'pw-record (part of PipeWire) isn’t installed.' });
  });

  it('sends one frame per tick with the level, the peak marker and the raw peak', async () => {
    const { meters, procs, frames, advance } = setup();
    await meters.watch(['mic', 'game']);
    procs[0].stdout.emit('data', floats(0.5, -0.25));
    advance(33);
    meters.tick();
    expect(frames.at(-1)).toEqual({ mic: [-6, -6, -6], game: [FLOOR_DB, FLOOR_DB, FLOOR_DB] });
  });

  it('reads an idle output as silence, and keeps a source’s last reading through a tick without samples', async () => {
    const { meters, procs, frames, advance } = setup();
    await meters.watch(['mic', 'game']);
    const [mic, game] = procs;
    mic.stdout.emit('data', floats(0.5));
    game.stdout.emit('data', floats(0.5));
    advance(33);
    meters.tick();
    // Nothing new: the output's monitor went idle (silence); the mic's samples are just late.
    advance(100);
    meters.tick();
    const { mic: m, game: g } = frames.at(-1)!;
    expect(m).toEqual([-6, -6, -6]);
    expect(g![2]).toBe(FLOOR_DB);
    expect(g![0]).toBeCloseTo(-6 - RELEASE_DB_PER_S * 0.1, 1);
    expect(g![1]).toBe(-6);
  });

  it('ends a source that stops sending, and says so', async () => {
    const { meters, procs, lost, advance } = setup();
    await meters.watch(['mic', 'game']);
    // pw-record gets extra time to start, then a source that stays quiet has stopped.
    for (let t = 0; t <= 2 * STALL_MS + 100; t += 100) {
      advance(100);
      meters.tick();
    }
    expect(lost).toEqual(['mic']);
    expect(procs[0].killed).toBe(true);
    // An idle output is fine: nothing plays.
    expect(meters.running).toEqual(['game']);
  });

  it('drops a meter whose pw-record ends, and stops everything on stop()', async () => {
    const { meters, procs, lost, timers } = setup();
    await meters.watch(['mic', 'streamOut']);
    procs[1].emit('exit', 1, null);
    expect(meters.running).toEqual(['mic']);
    expect(lost).toEqual(['streamOut']);
    meters.stop();
    expect(procs[0].killed).toBe(true);
    expect(timers()).toBe(0);
    expect(lost).toEqual(['streamOut']);
  });

  it('starts all meters or none, so the mic never runs behind an error', async () => {
    const { meters, procs, lost } = setup({ failFor: NODES.game });
    const res = await meters.watch(['mic', 'game']);
    // The spawn error is the answer; it isn't also reported as a meter that stopped later.
    expect(res).toEqual({ running: [], error: 'spawn EAGAIN' });
    expect(lost).toEqual([]);
    expect(procs.find((p) => p.args.includes(NODES.mic))!.killed).toBe(true);
  });

  it('starts nothing, and stops what runs, when one of the devices is missing', async () => {
    const { meters, procs } = setup({ nodes: { mic: NODES.mic, streamOut: NODES.streamOut } });
    await meters.watch(['mic']);
    const res = await meters.watch(['mic', 'game']);
    expect(res.running).toEqual([]);
    expect(res.error).toMatch(/aren’t available/);
    expect(procs[0].killed).toBe(true);
  });

  it('doesn’t mistake a stalled event loop (or a sleeping machine) for a stopped source', async () => {
    const { meters, lost, advance } = setup();
    await meters.watch(['mic']);
    advance(10_000);
    meters.tick();
    expect(lost).toEqual([]);
    expect(meters.running).toEqual(['mic']);
  });

  it('lets the newest request win when two overlap', async () => {
    const { meters, procs } = setup();
    const first = meters.watch(['mic']);
    const second = meters.watch([]);
    await Promise.all([first, second]);
    expect(procs).toHaveLength(0);
    expect(meters.running).toEqual([]);
  });

  it('reads each pipe on the tick, not as samples arrive', async () => {
    const { meters, procs, frames, write, reads, advance } = setup({ pipes: true });
    await meters.watch(['mic', 'game']);
    const [mic, game] = procs;
    expect(mic.stdout.listenerCount('data')).toBe(0);
    // Two writes since the last tick, one split mid-sample: both are read, and the peak covers them.
    const data = floats(0.25, -0.5, 0.125);
    write(mic, data.subarray(0, 6));
    write(mic, data.subarray(6));
    advance(33);
    meters.tick();
    expect(frames.at(-1)).toEqual({ mic: [-6, -6, -6], game: [FLOOR_DB, FLOOR_DB, FLOOR_DB] });
    expect(reads.filter((fd) => fd === game.stdout._handle!.fd)).toHaveLength(1);
    // More than the buffer holds (after a long stall): read until the pipe is empty.
    write(game, floats(...Array<number>(40_000).fill(0.1), 0.5));
    advance(33);
    meters.tick();
    expect(frames.at(-1)!.game![2]).toBe(-6);
  });

  it('waits for pw-record’s exit at the end of its pipe', async () => {
    const { meters, procs, lost, write, advance } = setup({ pipes: true });
    await meters.watch(['mic']);
    write(procs[0], floats(0.5));
    write(procs[0], Buffer.alloc(0));
    advance(33);
    meters.tick();
    expect(meters.running).toEqual(['mic']);
    procs[0].emit('exit', 0, null);
    expect(lost).toEqual(['mic']);
  });

  it('gets every byte a real child writes: Node doesn’t read the pipe first', async () => {
    const written = 40_000;
    let got = 0;
    const meters = new LevelMeters({
      nodes: async () => NODES,
      onFrame: () => {},
      installed: () => true,
      spawn: () => spawn('sh', ['-c', `head -c ${written} /dev/zero; exec sleep 5`], { stdio: ['ignore', 'pipe', 'ignore'] }),
      read: (fd, buf) => {
        const n = readSync(fd, buf, 0, buf.length, null);
        got += n;
        return n;
      },
      setInterval: () => 1,
      clearInterval: () => {},
    });
    await meters.watch(['mic']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    meters.tick();
    meters.stop();
    expect(got).toBe(written);
  });

  it('drops a meter whose pipe breaks, and closes the pipes it stops reading', async () => {
    const { meters, procs, lost, write, advance } = setup({ pipes: true });
    await meters.watch(['mic', 'streamOut']);
    write(procs[1], Object.assign(new Error('EBADF: bad file descriptor, read'), { code: 'EBADF' }));
    advance(33);
    meters.tick();
    expect(lost).toEqual(['streamOut']);
    expect(procs[1].killed).toBe(true);
    expect(procs[1].stdout.destroyed).toBe(true);
    expect(meters.running).toEqual(['mic']);
    meters.stop();
    expect(procs[0].stdout.destroyed).toBe(true);
  });

  it('doesn’t report an error for a request that stop() overtook', async () => {
    const { meters, procs } = setup();
    const pending = meters.watch(['mic']);
    // pw-record has been started but hasn't reported back yet (e.g. the window was minimized).
    while (!procs.length) await Promise.resolve();
    meters.stop();
    expect(await pending).toEqual({ running: [] });
  });
});
