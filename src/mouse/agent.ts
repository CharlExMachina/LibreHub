// The part of G Hub that has to run on the computer, for the two things the mouse cannot do alone:
//
// - Software actions (open an app, file or URL; run a command). The agent starts MouseButtonSpy
//   (0x8110), which makes the mouse report every press to the computer, in onboard mode too, while
//   the profile keeps working as usual. A control with a software action is stored on the mouse as
//   "disabled", so the mouse does nothing and the agent performs the action.
// - Freestyle lighting. The mouse shows per-LED colours (0x8081) only while software controls the
//   LEDs, and repaints its own effect when the profile changes or it wakes up, so the agent paints
//   them again after each of those.
//
// The agent follows the active onboard profile. In host mode (G Hub's software mode) it does
// nothing: there is no active profile to follow. Run one agent per mouse: the app runs one while
// it runs, `g502x agent` runs one without the app; a lock file keeps them from both acting.

import { EventEmitter } from 'node:events';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, unwatchFile, watchFile, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { MouseButtonSpy, RgbEffects } from './codecs.js';
import { Feature } from './features.js';
import type { G502X } from './g502x.js';
import { G502X_CONTROLS, type Binding } from './onboard.js';
import { runAction } from './actions.js';
import type { MouseService } from './service.js';
import { profileSoftware, rgbOf, type Layer, type ProfileSoftware, type SoftwareAction, type SoftwareStore } from './software.js';

export interface AgentOptions {
  /** Performs an action; defaults to spawning it (actions.ts). Tests pass a recorder. */
  runner?: (a: SoftwareAction) => void;
  /** Wait this long after a profile change or wake before repainting (the mouse repaints first). */
  settleMs?: number;
  /** Paint once more this long after that, in case the mouse's own repaint came late. */
  repaintMs?: number;
  /** Re-read the settings file when it changes (another process, e.g. the CLI, edited it). */
  watch?: boolean;
}

export interface AgentState {
  profile: number | null;
  software: ProfileSoftware | null;
}

export class SoftwareAgent extends EventEmitter {
  private readonly mouse: G502X;
  private readonly runner: (a: SoftwareAction) => void;
  private readonly settleMs: number;
  private readonly repaintMs: number;
  private profile: number | null = null;
  private bindings: Record<Layer, Binding[]> = { base: [], gshift: [] };
  private software: ProfileSoftware | null = null;
  private held = 0;
  private lightingTaken = false;
  private running = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private reloading?: Promise<void>;
  private reloadAgain = false;

  constructor(
    private readonly svc: MouseService,
    private readonly store: SoftwareStore,
    private readonly opts: AgentOptions = {},
  ) {
    super();
    this.mouse = svc.mouse;
    this.runner = opts.runner ?? ((a) => runAction(a, (err) => this.emit('error', err)));
    this.settleMs = opts.settleMs ?? 700;
    this.repaintMs = opts.repaintMs ?? 2000;
  }

  get state(): AgentState {
    return { profile: this.profile, software: this.software };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.mouse.on('raw', this.onRaw);
    this.mouse.on('connection', this.onConnection);
    if (this.opts.watch) watchFile(this.store.file, { interval: 1000 }, this.onFileChange);
    await this.svc.run(() => this.mouse.call(Feature.MOUSE_BUTTON_SPY, MouseButtonSpy.START_SPY));
    await this.reload();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.mouse.off('raw', this.onRaw);
    this.mouse.off('connection', this.onConnection);
    unwatchFile(this.store.file, this.onFileChange);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.reloading?.catch(() => undefined);
    // Don't wait for a sleeping mouse: it drops the spy and the per-LED colours by itself when it
    // sleeps, so there is nothing left to undo.
    await this.svc.run(async () => {
      await this.mouse.callOnce(Feature.MOUSE_BUTTON_SPY, MouseButtonSpy.STOP_SPY).catch(() => undefined);
      if (this.lightingTaken) await this.mouse.callOnce(Feature.RGB_EFFECTS, RgbEffects.SW_CONTROL, RgbEffects.encodeSwControl(0, 0)).catch(() => undefined);
    });
    this.lightingTaken = false;
  }

  /** Re-read the active profile and the settings, and repaint Freestyle. Calls coalesce. */
  reload(): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      try {
        do {
          this.reloadAgain = false;
          await this.load();
          await this.paint();
        } while (this.reloadAgain && this.running);
      } finally {
        this.reloading = undefined;
      }
    })();
    return this.reloading;
  }

  private async load(): Promise<void> {
    const config = await this.store.read();
    const profile = await this.svc.run(async () => {
      if ((await this.mouse.getMode()) !== 'onboard') return null;
      const slot = await this.mouse.getActiveProfile();
      const p = await this.mouse.readProfile(slot);
      this.bindings = { base: p.buttons, gshift: p.gshift };
      return slot;
    });
    this.profile = profile;
    this.software = profile === null ? null : profileSoftware(config, profile);
    this.emit('state', this.state);
  }

  private async paint(): Promise<void> {
    const f = this.software?.freestyle;
    if (f) {
      const colors = Object.entries(f).map(([led, hex]) => ({ led: Number(led), color: rgbOf(hex) }));
      await this.svc.run(() => this.mouse.setLedColors(colors));
      this.lightingTaken = true;
      this.later(this.repaintMs, () => (this.software?.freestyle === f ? this.svc.run(() => this.mouse.setLedColors(colors)) : undefined));
    } else if (this.lightingTaken) {
      await this.svc.run(() => this.mouse.returnLightingToDevice());
      this.lightingTaken = false;
    }
  }

  private later(ms: number, fn: () => Promise<unknown> | unknown): void {
    if (!this.running) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.running) return;
      Promise.resolve()
        .then(fn)
        .catch((err) => this.emit('error', err));
    }, ms);
    this.timers.add(t);
  }

  private readonly onFileChange = () => {
    void this.reload().catch((err) => this.emit('error', err));
  };

  private readonly onRaw = (e: { featureId: number; fn: number; params: Uint8Array }) => {
    if (e.featureId === Feature.MOUSE_BUTTON_SPY && e.fn === MouseButtonSpy.BUTTON_EVENT) this.onButtons(MouseButtonSpy.decodeButtons(e.params));
    // The onboard profile changed (the profile button, or another program): follow it.
    else if (e.featureId === Feature.ONBOARD_PROFILES && e.fn === 0) this.later(this.settleMs, () => this.reload());
  };

  private readonly onConnection = (c: { linkEstablished: boolean }) => {
    this.held = 0;
    if (!c.linkEstablished) return;
    // Woke up or reconnected: the spy and the LEDs start from scratch.
    this.later(this.settleMs, async () => {
      await this.svc.run(() => this.mouse.call(Feature.MOUSE_BUTTON_SPY, MouseButtonSpy.START_SPY));
      this.lightingTaken = false;
      await this.reload();
    });
  };

  private onButtons(mask: number): void {
    const pressed = mask & ~this.held;
    this.held = mask;
    if (!pressed || !this.software) return;
    // G-Shift: another held control whose normal binding is the G-Shift function.
    const shiftHeld = this.bindings.base.some((b, k) => b.type === 'function' && b.fn === 'g-shift' && mask & (1 << k) && !(pressed & (1 << k)));
    const layer: Layer = shiftHeld ? 'gshift' : 'base';
    G502X_CONTROLS.forEach((c, k) => {
      if (!(pressed & (1 << k))) return;
      const action = this.software!.actions[layer][c.id];
      // Only act if the mouse itself does nothing for this control, as set up by the service.
      if (!action || this.bindings[layer][k]?.type !== 'disabled') return;
      this.emit('action', { control: c.id, layer, action });
      try {
        this.runner(action);
      } catch (err) {
        this.emit('error', err);
      }
    });
  }
}

// ------------------------------------------------------------------ one agent at a time

/**
 * Take the agent lock (a file holding the owner's pid). Returns a release function, or null if a
 * live process holds it. A lock left by a process that died is taken over.
 */
export function acquireAgentLock(file: string): (() => void) | null {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (pid && pid !== process.pid && alive(pid)) return null;
      unlinkSync(file);
    }
  }
  return null;
}

/** The pid of the live process holding the agent lock, or null. */
export function agentLockHolder(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
