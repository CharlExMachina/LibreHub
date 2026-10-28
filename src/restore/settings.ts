// Which headset settings the app can keep, how to read them out of a snapshot, and how to put
// them back: compare with what's on the headset, write only what differs, then read again.

import { DeviceError } from '../device/a50x.js';
import type { NoiseGateName, TonesName } from '../protocol/codecs.js';
import { HEADPHONES, MIC } from '../protocol/eq.js';
import type { A50XService, Action, Snapshot } from '../service.js';

export const GROUPS = [
  { id: 'sidetone', label: 'Sidetone' },
  { id: 'balance', label: 'Game/voice balance' },
  { id: 'volume', label: 'Volume and mute' },
  { id: 'headphonesEq', label: 'Headphones EQ' },
  { id: 'micEq', label: 'Mic EQ' },
  { id: 'noiseGate', label: 'Noise gate' },
  { id: 'mix', label: 'Stream mix' },
  { id: 'headset', label: 'Sleep timer, tones and brightness' },
] as const;

export type Group = (typeof GROUPS)[number]['id'];

export const ALL_GROUPS: Group[] = GROUPS.map((g) => g.id);

export interface Values {
  sidetone: number;
  /** Raw device value (0 = all game). */
  balance: number;
  volume: { level: number; muted: boolean };
  headphonesEq: number[];
  micEq: number[];
  noiseGate: string;
  mix: { gain: number; muted: boolean; inputs: { index: number; gain: number; muted: boolean }[] };
  headset: { sleep: number; tones: TonesName; brightness: number };
}

export type Saved = Partial<Values>;

export function capture(s: Snapshot): Values {
  const eq = (instance: number) => [...(s.equalizers.find((e) => e.instance === instance)?.gainsDb ?? [])];
  return {
    sidetone: s.sidetone.step,
    balance: s.balance.value,
    volume: { level: s.volume.level, muted: s.volume.muted },
    headphonesEq: eq(HEADPHONES),
    micEq: eq(MIC),
    noiseGate: String(s.noiseGate.value),
    mix: { gain: s.routing.output.gain, muted: s.routing.output.muted, inputs: s.routing.inputs.map(({ index, gain, muted }) => ({ index, gain, muted })) },
    headset: { sleep: s.sleep.minutes, tones: s.tones, brightness: s.brightness },
  };
}

export function pick(values: Saved, groups: readonly Group[]): Saved {
  return Object.fromEntries(groups.filter((g) => values[g] !== undefined).map((g) => [g, values[g]])) as Saved;
}

/** The settings an action changes, so the app can remember them. */
export function groupsTouchedBy(action: Action): Group[] {
  switch (action.type) {
    case 'sidetone': return ['sidetone'];
    case 'balance': return ['balance'];
    case 'volume':
    case 'mute': return ['volume'];
    case 'sleep':
    case 'tones':
    case 'brightness': return ['headset'];
    case 'noiseGate': return ['noiseGate'];
    case 'routingOutput':
    case 'routingInput': return ['mix'];
    case 'eqCurated':
    case 'eqGains': return [action.instance === MIC ? 'micEq' : 'headphonesEq'];
    case 'eqCustom': return ['micEq', 'headphonesEq'];
    default: return [];
  }
}

const sameGains = (a: number[], b: number[]) => a.length === b.length && a.every((g, k) => Math.abs(g - b[k]) < 0.026);

/** Writes that turn `have` into `want`; none when they already match. */
const ACTIONS: { [G in Group]: (want: Values[G], have: Values[G]) => Action[] } = {
  sidetone: (w, h) => (w === h ? [] : [{ type: 'sidetone', step: w }]),
  balance: (w, h) => (w === h ? [] : [{ type: 'balance', value: w }]),
  volume: (w, h) => [
    ...(w.level !== h.level ? [{ type: 'volume', level: w.level } as const] : []),
    ...(w.muted !== h.muted ? [{ type: 'mute', muted: w.muted } as const] : []),
  ],
  // A curve with a different band count can't be written back; leave it alone.
  headphonesEq: (w, h) => (w.length !== h.length || sameGains(w, h) ? [] : [{ type: 'eqGains', instance: HEADPHONES, gainsDb: w }]),
  micEq: (w, h) => (w.length !== h.length || sameGains(w, h) ? [] : [{ type: 'eqGains', instance: MIC, gainsDb: w }]),
  noiseGate: (w, h) => (w === h ? [] : [{ type: 'noiseGate', value: w as NoiseGateName }]),
  mix: (w, h) => [
    ...(w.gain !== h.gain || w.muted !== h.muted ? [{ type: 'routingOutput', gain: w.gain, muted: w.muted } as const] : []),
    ...w.inputs.flatMap((i) => {
      const now = h.inputs.find((x) => x.index === i.index);
      return now && (now.gain !== i.gain || now.muted !== i.muted) ? [{ type: 'routingInput', index: i.index, gain: i.gain, muted: i.muted } as const] : [];
    }),
  ],
  headset: (w, h) => [
    ...(w.sleep !== h.sleep ? [{ type: 'sleep', minutes: w.sleep } as const] : []),
    ...(w.tones !== h.tones ? [{ type: 'tones', value: w.tones } as const] : []),
    ...(w.brightness !== h.brightness ? [{ type: 'brightness', percent: w.brightness } as const] : []),
  ],
};

/**
 * Settings a read can't vouch for. The base station answers with its own copy; the headset starts
 * without them and gets them from the base station when they connect, except when the base station
 * powers up with the headset on the dock. Then reads match while the headset plays no sidetone, so
 * every check sends these again, matching or not.
 */
const RESEND: { [G in Group]?: (want: Values[G]) => Action[] } = {
  sidetone: (w) => [{ type: 'sidetone', step: w }],
};

export interface Drift {
  group: Group;
  actions: Action[];
}

/** Saved settings (among `groups`) that differ from what the headset has now. */
export function drift(saved: Saved, current: Values, groups: readonly Group[]): Drift[] {
  const out: Drift[] = [];
  for (const group of groups) {
    const want = saved[group];
    if (want === undefined) continue;
    const actions = (ACTIONS[group] as (w: unknown, h: unknown) => Action[])(want, current[group]);
    if (actions.length) out.push({ group, actions });
  }
  return out;
}

export interface CheckResult {
  /** Settings that had changed on the headset and are now back the way they were saved. */
  restored: Group[];
  /** Settings that still differ after writing them back, with the reason when a write was rejected. */
  failed: { group: Group; error?: string }[];
  /** The last read of the headset. */
  snapshot: Snapshot;
}

/**
 * Read the headset, write back any saved setting that differs, then read again to verify.
 * Anything still off gets one more try. Settings in RESEND that match are sent anyway, and
 * aren't reported as restored. Errors other than rejected writes (e.g. the link dropping)
 * propagate.
 */
export async function restore(service: A50XService, saved: Saved, groups: readonly Group[], first?: Snapshot): Promise<CheckResult> {
  let snapshot = first ?? (await service.snapshot());
  const found = drift(saved, capture(snapshot), groups);
  let pending = found;
  const errors = new Map<Group, string>();
  const send = async ({ group, actions }: Drift) => {
    for (const action of actions) {
      try {
        await service.apply(action);
      } catch (err) {
        // The headset (or the service) turned this value down; anything else means the link is gone.
        if (!(err instanceof RangeError || err instanceof DeviceError || /^(unknown|no routing)/.test((err as Error)?.message ?? ''))) throw err;
        errors.set(group, (err as Error).message);
      }
    }
  };
  for (const group of groups) {
    const resend = RESEND[group] as ((w: unknown) => Action[]) | undefined;
    if (resend && saved[group] !== undefined && !found.some((d) => d.group === group)) await send({ group, actions: resend(saved[group]) });
  }
  for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
    for (const d of pending) await send(d);
    snapshot = await service.snapshot();
    pending = drift(saved, capture(snapshot), pending.map((d) => d.group));
  }
  const failed = pending.map(({ group }) => ({ group, ...(errors.has(group) ? { error: errors.get(group) } : {}) }));
  return { restored: found.map((d) => d.group).filter((g) => !pending.some((p) => p.group === g)), failed, snapshot };
}
