// One place that turns device state into what the UI/CLI shows and applies user actions.
// Shared by the Electron main process and the CLI so both are covered by the same tests.

import type { A50X } from './device/a50x.js';
import { AutoSleep, HeadsetTones, MixerMic, gateName, type NoiseGateName, type TonesName } from './protocol/codecs.js';
import * as Eq from './protocol/eq.js';
import type { CustomPreset, PresetStore } from './presets/store.js';

export interface EqualizerView {
  instance: number;
  label: 'Microphone' | 'Headphones';
  frequencies: number[];
  gainsDb: number[];
  gainMinDb: number;
  gainMaxDb: number;
  curated: string[];
  custom: CustomPreset[];
  /** Name of the curated or custom preset whose gains match the live EQ, if any. */
  matches: string | null;
}

export interface Snapshot {
  device: Awaited<ReturnType<A50X['getDeviceInfo']>>;
  battery: number;
  bluetoothHost: { name: string; address: string } | null;
  sidetone: { step: number; max: number };
  volume: { level: number; max: number; muted: boolean };
  balance: { value: number; max: number };
  sleep: { minutes: number; choices: readonly number[] };
  brightness: number;
  tones: TonesName;
  noiseGate: { value: NoiseGateName | string; supported: string[] };
  routing: {
    output: { index: number; gain: number; muted: boolean };
    maxGain: number;
    inputs: { index: number; name: string; gain: number; muted: boolean }[];
  };
  equalizers: EqualizerView[];
  /** Set when the custom preset file can't be read; the headset still works, custom presets are hidden. */
  presetsError?: string;
}

export type Action =
  | { type: 'sidetone'; step: number }
  | { type: 'volume'; level: number }
  | { type: 'mute'; muted: boolean }
  | { type: 'balance'; value: number }
  | { type: 'sleep'; minutes: number }
  | { type: 'brightness'; percent: number }
  | { type: 'tones'; value: TonesName }
  | { type: 'noiseGate'; value: NoiseGateName }
  | { type: 'routingOutput'; gain?: number; muted?: boolean }
  | { type: 'routingInput'; index: number; gain?: number; muted?: boolean }
  | { type: 'eqCurated'; instance: number; preset: number }
  | { type: 'eqGains'; instance: number; gainsDb: number[] }
  | { type: 'eqCustom'; id: string }
  | { type: 'savePreset'; instance: number; name: string; gainsDb: number[]; id?: string }
  | { type: 'deletePreset'; id: string };

const tonesName = (v: number): TonesName =>
  (Object.entries(HeadsetTones.VALUES).find(([, n]) => n === v)?.[0] as TonesName | undefined) ?? 'all';

const sameGains = (a: number[], b: number[]) => a.length === b.length && a.every((g, k) => Math.abs(g - b[k]) < 0.026);

export class A50XService {
  /** Actions run one at a time: several are read-modify-write (routing), so overlapping ones would lose updates. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly device: A50X,
    private readonly presets: PresetStore,
  ) {}

  async snapshot(): Promise<Snapshot> {
    const d = this.device;
    const routing = await d.getRouting(0);
    const gate = await d.getNoiseGate();
    const inputName = (i: number) => routing.inputs.find((x) => x.index === i)?.name ?? `input ${i}`;
    return {
      device: await d.getDeviceInfo(),
      battery: (await d.getBattery()).percent,
      bluetoothHost: await d.getBluetoothHost(),
      sidetone: await d.getSidetone(),
      volume: await d.getVolume(),
      balance: await d.getBalance(),
      sleep: { minutes: (await d.getSleepTimer()).minutes, choices: AutoSleep.CHOICES },
      brightness: await d.getBrightness(),
      tones: tonesName(await d.getTones()),
      noiseGate: { value: gateName(gate.value), supported: gate.supported.map(gateName) },
      routing: {
        output: { index: routing.state.output, gain: routing.state.gain, muted: routing.state.muted },
        maxGain: routing.info.steps - 1,
        inputs: routing.state.inputs.map((i) => ({ ...i, name: inputName(i.index) })),
      },
      equalizers: [await this.equalizer(Eq.MIC), await this.equalizer(Eq.HEADPHONES)],
      ...(this.presetsError ? { presetsError: this.presetsError } : {}),
    };
  }

  private presetsError?: string;

  private async equalizer(instance: number): Promise<EqualizerView> {
    const { info, bands } = await this.device.getEqualizer(instance);
    const gainsDb = bands.map((b) => Eq.stepToDb(b.gainStep, info));
    const curated = Eq.CURATED_PRESETS[instance] ?? [];
    // A broken preset file must not take the whole device offline.
    const custom = await this.presets.list(instance).then(
      (list) => ((this.presetsError = undefined), list),
      (err: Error) => ((this.presetsError = err.message), []),
    );
    let matches: string | null = null;
    for (let p = 0; p < info.readonlyPresets && !matches; p++) {
      const preset = await this.device.getOnboardPreset(instance, p);
      if (sameGains(preset.map((b) => Eq.stepToDb(b.gainStep, info)), gainsDb)) matches = curated[p] ?? `Preset ${p}`;
    }
    matches ??= custom.find((c) => sameGains(c.gainsDb, gainsDb))?.name ?? null;
    return {
      instance,
      label: instance === Eq.MIC ? 'Microphone' : 'Headphones',
      frequencies: bands.map((b) => b.frequency),
      gainsDb,
      gainMinDb: info.gainMinDb,
      gainMaxDb: info.gainMaxDb,
      curated,
      custom,
      matches,
    };
  }

  apply(action: Action): Promise<void> {
    const run = this.queue.then(() => this.applyNow(action), () => this.applyNow(action));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyNow(action: Action): Promise<void> {
    const d = this.device;
    switch (action.type) {
      case 'sidetone': return d.setSidetone(action.step);
      case 'volume': return d.setVolume(action.level);
      case 'mute': return d.setMuted(action.muted);
      case 'balance': return d.setBalance(action.value);
      case 'sleep': return d.setSleepTimer(action.minutes);
      case 'brightness': return d.setBrightness(action.percent);
      case 'tones': {
        const v = HeadsetTones.VALUES[action.value];
        if (v === undefined) throw new Error(`unknown tones setting "${action.value}"`);
        return d.setTones(v);
      }
      case 'noiseGate': {
        const v = MixerMic.GATES[action.value];
        if (v === undefined) throw new Error(`unknown noise gate "${action.value}"`);
        return d.setNoiseGate(v);
      }
      case 'routingOutput': {
        const { state } = await d.getRouting(0);
        return d.setRouting({ ...state, gain: action.gain ?? state.gain, muted: action.muted ?? state.muted });
      }
      case 'routingInput': {
        const { state } = await d.getRouting(0);
        if (!state.inputs.some((i) => i.index === action.index)) throw new Error(`no routing input ${action.index}`);
        const inputs = state.inputs.map((i) => (i.index === action.index ? { ...i, gain: action.gain ?? i.gain, muted: action.muted ?? i.muted } : i));
        return d.setRouting({ ...state, inputs });
      }
      case 'eqCurated': return d.applyCuratedPreset(action.instance, action.preset);
      case 'eqGains': return d.applyEqualizerGains(action.instance, action.gainsDb);
      case 'eqCustom': {
        const preset = (await this.presets.list()).find((p) => p.id === action.id);
        if (!preset) throw new Error(`no custom preset ${action.id}`);
        return d.applyEqualizerGains(preset.instance, preset.gainsDb);
      }
      case 'savePreset': {
        await this.presets.save({ id: action.id, name: action.name, instance: action.instance, gainsDb: action.gainsDb });
        return;
      }
      case 'deletePreset': {
        await this.presets.remove(action.id);
        return;
      }
    }
  }
}
