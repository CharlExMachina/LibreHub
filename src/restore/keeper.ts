// Decides when to check the headset against the saved settings: when the app starts, after the
// computer wakes or unlocks, and whenever the headset (re)connects. A check whose headset isn't
// reachable waits for the next connection. A check that found something to fix, or that ran
// right after a wake-up, gets a quiet follow-up a little later to confirm the settings stuck.

import type { A50XService, Action, Snapshot } from '../service.js';
import { capture, groupsTouchedBy, pick, restore, type Group, type Saved } from './settings.js';
import type { HistoryEntry, RestoreStore, Trigger } from './store.js';

/** Reasons that say why settings may have changed. A reconnect or follow-up never renames one of these. */
const STRONG = new Set<Trigger>(['startup', 'wake', 'unlock', 'manual']);

export interface KeeperOptions {
  store: RestoreStore;
  /** The connected headset (connecting if needed), or undefined if there is none. */
  service: () => Promise<A50XService | undefined>;
  config: () => { enabled: boolean; groups: Group[] };
  /** Errors that mean the headset went away; the check is retried on the next connection. */
  isLinkError: (err: unknown) => boolean;
  onLinkError?: (err: unknown) => void;
  /** After each logged check. */
  onCheck?: (entry: HistoryEntry) => void;
  followUpMs?: number;
}

export class SettingsKeeper {
  private pending?: Trigger = 'startup';
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<unknown> = Promise.resolve();
  private requests = 0;
  /**
   * False from a wake-up or connection until its check is done. Changes the headset reports in
   * between may be a reset rather than a choice, so they aren't remembered.
   */
  private settled = false;
  private serial?: string;
  private stopped = false;

  constructor(private readonly opts: KeeperOptions) {}

  /** Check after `delayMs`. A check already waiting for a wake-up (say) keeps that name when the headset reconnects. */
  request(trigger: Trigger, delayMs = 0): void {
    if (this.stopped) return;
    this.reason(trigger);
    this.settled = false;
    this.requests++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delayMs);
  }

  /** The computer is going to sleep: don't trust anything until the check after it wakes. */
  suspend(): void {
    clearTimeout(this.timer);
    this.settled = false;
  }

  /** Check right away and resolve with what it found (undefined if there's no headset or it's off). */
  async checkNow(): Promise<HistoryEntry | undefined> {
    clearTimeout(this.timer);
    this.reason('manual');
    this.requests++;
    return this.run();
  }

  /** Save what's on the headset now as the settings to keep. */
  async rememberNow(): Promise<HistoryEntry | undefined> {
    return this.serialize(async () => {
      const svc = await this.opts.service();
      if (!svc) return undefined;
      return this.remember(await svc.snapshot(), 'manual');
    });
  }

  /** A change the user made in the app (or CLI): `snapshot` is the read right after it. */
  async record(action: Action, snapshot: Snapshot): Promise<void> {
    if (!this.opts.config().enabled) return;
    await this.opts.store.remember(snapshot.device.serial, pick(capture(snapshot), groupsTouchedBy(action)));
  }

  /** A change reported by the headset itself (e.g. its volume wheel). Ignored until settled. */
  async observe(values: Saved): Promise<void> {
    if (!this.settled || !this.serial || !this.opts.config().enabled) return;
    await this.opts.store.remember(this.serial, values);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private reason(trigger: Trigger): void {
    if (!this.pending || STRONG.has(trigger) || !STRONG.has(this.pending)) this.pending = trigger;
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private run(): Promise<HistoryEntry | undefined> {
    return this.serialize(() => this.runNow());
  }

  private async runNow(): Promise<HistoryEntry | undefined> {
    const trigger = this.pending;
    if (!trigger || this.stopped) return undefined;
    const ticket = this.requests;
    const { enabled, groups } = this.opts.config();
    if (!enabled) {
      this.pending = undefined;
      this.settled = true;
      return undefined;
    }
    const svc = await this.opts.service();
    if (!svc) return undefined; // stays pending: the next connection runs it
    this.pending = undefined;
    let entry: HistoryEntry | undefined;
    try {
      const snapshot = await svc.snapshot();
      this.serial = snapshot.device.serial;
      const saved = await this.opts.store.saved(this.serial);
      if (!saved) entry = await this.remember(snapshot, trigger);
      else {
        const result = await restore(svc, saved, groups, snapshot);
        const at = new Date().toISOString();
        if (trigger === 'follow-up' && !result.restored.length && !result.failed.length) {
          await this.opts.store.confirm(at);
        } else {
          entry = {
            at,
            trigger,
            outcome: result.failed.length ? 'failed' : result.restored.length ? 'restored' : 'matched',
            ...(result.restored.length ? { restored: result.restored } : {}),
            ...(result.failed.length ? { failed: result.failed } : {}),
          };
          await this.opts.store.log(entry);
          this.opts.onCheck?.(entry);
        }
        const settling = trigger === 'startup' || trigger === 'wake' || trigger === 'unlock';
        if (trigger !== 'follow-up' && (result.restored.length || settling)) this.request('follow-up', this.opts.followUpMs ?? 20000);
      }
    } catch (err) {
      if (this.opts.isLinkError(err)) {
        if (!this.pending || !STRONG.has(this.pending)) this.pending = trigger;
        this.opts.onLinkError?.(err);
        return undefined;
      }
      entry = { at: new Date().toISOString(), trigger, outcome: 'failed', error: (err as Error)?.message ?? String(err) };
      await this.opts.store.log(entry);
      this.opts.onCheck?.(entry);
    }
    // Settled only if nothing asked for another check while this one ran.
    if (ticket === this.requests && !this.pending) this.settled = true;
    return entry;
  }

  private async remember(snapshot: Snapshot, trigger: Trigger): Promise<HistoryEntry> {
    this.serial = snapshot.device.serial;
    await this.opts.store.replace(this.serial, capture(snapshot));
    const entry: HistoryEntry = { at: new Date().toISOString(), trigger, outcome: 'remembered' };
    await this.opts.store.log(entry);
    this.opts.onCheck?.(entry);
    return entry;
  }
}
