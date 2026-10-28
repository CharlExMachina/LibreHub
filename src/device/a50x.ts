import { EventEmitter } from 'node:events';
import { decodeFrame, encodeRequest, ErrorCode, toHex } from '../protocol/packet.js';
import { Feature, featureName } from '../protocol/features.js';
import {
  AutoSleep,
  Battery,
  BtHostInfo,
  DeviceInfo,
  DeviceName,
  FeatureSet,
  GameVoiceMix,
  HeadsetTones,
  LedBrightness,
  MicTest,
  MixerAudio,
  MixerMic,
  Root,
  Sidetone,
  Volume,
  type RoutingState,
} from '../protocol/codecs.js';
import * as Eq from '../protocol/eq.js';
import type { HidTransport } from './transport.js';

export interface FeatureEntry {
  id: number;
  index: number;
  type: number;
  version: number;
}

export class DeviceError extends Error {
  constructor(
    readonly featureId: number,
    readonly fn: number,
    readonly code: number,
  ) {
    const meaning = Object.entries(ErrorCode).find(([, v]) => v === code)?.[0] ?? 'UNKNOWN';
    super(`${featureName(featureId)} fn${fn} failed with device error 0x${code.toString(16).padStart(2, '0')} (${meaning})`);
  }
}

export class TimeoutError extends Error {}

export interface A50XOptions {
  /** Software id for our requests (1..15). G Hub picks its own per session; responses are matched on it. */
  swid?: number;
  timeoutMs?: number;
  /** Optional wire log for debugging. */
  log?: (direction: 'out' | 'in', bytes: Uint8Array) => void;
}

interface Pending {
  featureIndex: number;
  fn: number;
  resolve: (params: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  featureId: number;
}

export interface Routing {
  info: ReturnType<typeof MixerAudio.decodeInfo>;
  inputs: ReturnType<typeof MixerAudio.decodeInputs>;
  outputs: ReturnType<typeof MixerAudio.decodeOutputs>;
  state: RoutingState;
}

export interface EqualizerState {
  info: Eq.EqInstanceInfo;
  activeSlot: number;
  bands: Eq.Band[];
}

/**
 * Client for the A50 X base station. Requests are serialized (one in flight), matched by
 * feature index + function + software id; unsolicited device events (swid 0) are re-emitted
 * as typed events: 'sidetone', 'volume', 'balance', 'sleep', 'tones', 'noiseGate', 'routing',
 * 'equalizer', 'battery', 'settingsChecksum', 'headsetReady' (the headset left or went back on
 * the dock, or was turned on or off), plus 'raw' for everything.
 */
export class A50X extends EventEmitter {
  readonly swid: number;
  private readonly timeoutMs: number;
  private readonly log?: A50XOptions['log'];
  private readonly unsubscribe: () => void;
  private chain: Promise<unknown> = Promise.resolve();
  private pending?: Pending;
  private readonly byId = new Map<number, FeatureEntry>();
  private readonly byIndex = new Map<number, FeatureEntry>();
  private eqInfoCache?: Eq.EqInstanceInfo[];

  private constructor(
    private readonly transport: HidTransport,
    opts: A50XOptions,
  ) {
    super();
    this.swid = opts.swid ?? 0x0b;
    if (this.swid < 1 || this.swid > 15) throw new RangeError('swid must be 1..15');
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.log = opts.log;
    this.unsubscribe = transport.onReport((r) => this.onReport(r));
  }

  /** Connect and discover the feature table. */
  static async connect(transport: HidTransport, opts: A50XOptions = {}): Promise<A50X> {
    const device = new A50X(transport, opts);
    try {
      await device.discover();
    } catch (err) {
      device.close();
      throw err;
    }
    return device;
  }

  close(): void {
    this.unsubscribe();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('device closed'));
      this.pending = undefined;
    }
    this.transport.close();
  }

  get features(): FeatureEntry[] {
    return [...this.byIndex.values()].sort((a, b) => a.index - b.index);
  }

  has(featureId: number): boolean {
    return this.byId.has(featureId);
  }

  // ------------------------------------------------------------ transport plumbing

  private onReport(report: Uint8Array): void {
    this.log?.('in', report);
    const frame = decodeFrame(report);
    if (!frame) return;
    const p = this.pending;
    if (p && frame.swid === this.swid && frame.featureIndex === p.featureIndex && frame.fn === p.fn) {
      clearTimeout(p.timer);
      this.pending = undefined;
      if (frame.kind === 'error') p.reject(new DeviceError(p.featureId, p.fn, frame.code));
      else p.resolve(frame.params);
      return;
    }
    if (frame.kind === 'message' && frame.swid === 0) this.onEvent(frame.featureIndex, frame.fn, frame.params);
  }

  /** Send one request to a feature index and resolve with the response parameters. */
  request(featureIndex: number, fn: number, params: ArrayLike<number> = [], featureId = this.byIndex.get(featureIndex)?.id ?? -1): Promise<Uint8Array> {
    const run = () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = undefined;
          reject(new TimeoutError(`${featureName(featureId)} fn${fn}: no response within ${this.timeoutMs} ms`));
        }, this.timeoutMs);
        this.pending = { featureIndex, fn, resolve, reject, timer, featureId };
        const report = encodeRequest({ featureIndex, fn, swid: this.swid, params });
        this.log?.('out', report);
        try {
          this.transport.write(report);
        } catch (err) {
          clearTimeout(timer);
          this.pending = undefined;
          reject(err as Error);
        }
      });
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** Call a function on a feature by its ID (resolved through the discovered feature table). */
  call(featureId: number, fn: number, params: ArrayLike<number> = []): Promise<Uint8Array> {
    const entry = this.byId.get(featureId);
    if (!entry) return Promise.reject(new Error(`feature ${featureName(featureId)} is not present on this device`));
    return this.request(entry.index, fn, params, featureId);
  }

  private async discover(): Promise<void> {
    this.addFeature({ id: Feature.ROOT, index: 0, type: 0, version: 0 });
    const fs = Root.decodeGetFeature(await this.request(0, Root.GET_FEATURE, Root.encodeGetFeature(Feature.FEATURE_SET), Feature.ROOT));
    this.addFeature({ id: Feature.FEATURE_SET, index: fs.index, type: fs.type, version: fs.version });
    const count = FeatureSet.decodeCount(await this.call(Feature.FEATURE_SET, FeatureSet.GET_COUNT));
    let next = 0;
    while (next < count) {
      const batch = FeatureSet.decodeFeatures(await this.call(Feature.FEATURE_SET, FeatureSet.GET_FEATURES, [next]), next);
      if (batch.length === 0) break;
      for (const f of batch) if (f.index < count) this.addFeature(f);
      next += batch.length;
    }
  }

  private addFeature(f: FeatureEntry): void {
    this.byId.set(f.id, f);
    this.byIndex.set(f.index, f);
  }

  private onEvent(featureIndex: number, fn: number, params: Uint8Array): void {
    const id = this.byIndex.get(featureIndex)?.id ?? -1;
    this.emit('raw', { featureId: id, featureIndex, fn, params });
    try {
      switch (id) {
        case Feature.SIDETONE: this.emit('sidetone', Sidetone.decode(params)); break;
        case Feature.VOLUME: this.emit('volume', Volume.decode(params)); break;
        case Feature.GAME_VOICE_MIX: this.emit('balance', GameVoiceMix.decode(params)); break;
        case Feature.AUTO_SLEEP: this.emit('sleep', AutoSleep.decode(params)); break;
        case Feature.HEADSET_TONES: this.emit('tones', HeadsetTones.decode(params)); break;
        case Feature.MIXER_MIC: this.emit('noiseGate', MixerMic.decodeGate(params)); break;
        case Feature.BATTERY: this.emit('battery', Battery.decode(params)); break;
        case Feature.MIXER_AUDIO: if (fn === MixerAudio.EVENT_STATE) this.emit('routing', MixerAudio.decodeEvent(params)); break;
        case Feature.PARAMETRIC_EQ: if (fn === Eq.EQ.GET_INFO) this.emit('equalizer', Eq.decodeBandsEvent(params)); break;
        case Feature.PROFILE: this.emit('settingsChecksum', toHex(params)); break;
        case Feature.MIC_TEST: if (fn === 0) this.emit('headsetReady', MicTest.decodeEvent(params)); break;
      }
    } catch (err) {
      this.emit('decodeError', err);
    }
  }

  /** The firmware clamps out-of-range values instead of rejecting them, so check limits first. */
  private static inRange(value: number, min: number, max: number, what: string): void {
    if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${what} must be an integer ${min}..${max}, got ${value}`);
  }

  // ------------------------------------------------------------ device information

  async getDeviceInfo() {
    const hw = DeviceInfo.decodeHardware(await this.call(Feature.DEVICE_INFO, DeviceInfo.GET_HARDWARE));
    const firmware = DeviceInfo.decodeFirmware(await this.call(Feature.DEVICE_INFO, DeviceInfo.GET_FIRMWARE));
    const serial = DeviceInfo.decodeSerial(await this.call(Feature.DEVICE_INFO, DeviceInfo.GET_SERIAL));
    const model = DeviceName.decodeModelName(await this.call(Feature.DEVICE_NAME, DeviceName.GET_MODEL_NAME));
    const { name } = DeviceName.decodeName(await this.call(Feature.DEVICE_NAME, DeviceName.GET_NAME));
    return { model, name, serial, firmware, modelId: hw.modelId, hardwareRevision: hw.hardwareRevision };
  }

  async getBattery() {
    return Battery.decode(await this.call(Feature.BATTERY, Battery.GET));
  }

  async getBluetoothHost(): Promise<{ name: string; address: string } | null> {
    const count = BtHostInfo.decodeCount(await this.call(Feature.BT_HOST_INFO, BtHostInfo.GET_COUNT));
    if (count === 0) return null;
    const address = BtHostInfo.decodeAddress(await this.call(Feature.BT_HOST_INFO, BtHostInfo.GET_ADDRESS));
    const name = BtHostInfo.decodeName(await this.call(Feature.BT_HOST_INFO, BtHostInfo.GET_NAME));
    return { name, address };
  }

  // ------------------------------------------------------------ sidetone

  async getSidetone() {
    const { step } = Sidetone.decode(await this.call(Feature.SIDETONE, Sidetone.GET));
    const { steps } = Sidetone.decodeInfo(await this.call(Feature.SIDETONE, Sidetone.GET_INFO));
    return { step, max: steps - 1 };
  }

  async setSidetone(step: number): Promise<void> {
    const { steps } = Sidetone.decodeInfo(await this.call(Feature.SIDETONE, Sidetone.GET_INFO));
    A50X.inRange(step, 0, steps - 1, 'sidetone step');
    await this.call(Feature.SIDETONE, Sidetone.SET, Sidetone.encodeSet(step));
  }

  // ------------------------------------------------------------ device (output) volume

  async getVolume() {
    const v = Volume.decode(await this.call(Feature.VOLUME, Volume.GET));
    const { levels } = Volume.decodeInfo(await this.call(Feature.VOLUME, Volume.GET_INFO));
    return { level: v.level, max: levels - 1, muted: v.muted };
  }

  async setVolume(level: number): Promise<void> {
    const { levels } = Volume.decodeInfo(await this.call(Feature.VOLUME, Volume.GET_INFO));
    A50X.inRange(level, 0, levels - 1, 'volume level');
    await this.call(Feature.VOLUME, Volume.SET_LEVEL, Volume.encodeSetLevel(level));
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.call(Feature.VOLUME, Volume.SET_MUTE, Volume.encodeSetMute(muted));
  }

  // ------------------------------------------------------------ game / voice balance

  async getBalance() {
    const value = GameVoiceMix.decode(await this.call(Feature.GAME_VOICE_MIX, GameVoiceMix.GET));
    const info = GameVoiceMix.decodeInfo(await this.call(Feature.GAME_VOICE_MIX, GameVoiceMix.GET_INFO));
    return { value, max: info.maxStep, center: info.maxStep / 2 };
  }

  async setBalance(value: number): Promise<void> {
    const { maxStep } = GameVoiceMix.decodeInfo(await this.call(Feature.GAME_VOICE_MIX, GameVoiceMix.GET_INFO));
    A50X.inRange(value, 0, maxStep, 'balance');
    await this.call(Feature.GAME_VOICE_MIX, GameVoiceMix.SET, GameVoiceMix.encodeSet(value));
  }

  // ------------------------------------------------------------ power management

  async getSleepTimer() {
    return AutoSleep.decode(await this.call(Feature.AUTO_SLEEP, AutoSleep.GET));
  }

  /** Minutes until the headset sleeps; 0 = never. G Hub offers 0, 15, 30, 60. */
  async setSleepTimer(minutes: number): Promise<void> {
    A50X.inRange(minutes, 0, AutoSleep.LEAD, 'sleep minutes');
    await this.call(Feature.AUTO_SLEEP, AutoSleep.SET, AutoSleep.encodeSet(minutes));
  }

  // ------------------------------------------------------------ base station brightness

  async getBrightness(): Promise<number> {
    return LedBrightness.decode(await this.call(Feature.LED_BRIGHTNESS, LedBrightness.GET));
  }

  async setBrightness(percent: number): Promise<void> {
    await this.call(Feature.LED_BRIGHTNESS, LedBrightness.SET, LedBrightness.encodeSet(percent));
  }

  // ------------------------------------------------------------ headset tones

  async getTones(): Promise<number> {
    return HeadsetTones.decode(await this.call(Feature.HEADSET_TONES, HeadsetTones.GET));
  }

  async setTones(state: number): Promise<void> {
    A50X.inRange(state, 0, 2, 'tones state');
    await this.call(Feature.HEADSET_TONES, HeadsetTones.SET, HeadsetTones.encodeSet(state));
  }

  // ------------------------------------------------------------ mic noise gate

  async getNoiseGate() {
    const value = MixerMic.decodeGate(await this.call(Feature.MIXER_MIC, MixerMic.GET_NOISE_GATE));
    const supported = MixerMic.decodeSupported(await this.call(Feature.MIXER_MIC, MixerMic.GET_SUPPORTED_GATES));
    return { value, supported };
  }

  async setNoiseGate(gate: number): Promise<void> {
    const supported = MixerMic.decodeSupported(await this.call(Feature.MIXER_MIC, MixerMic.GET_SUPPORTED_GATES));
    if (!supported.includes(gate)) throw new RangeError(`noise gate ${gate} is not supported (device supports ${supported.join(', ')})`);
    await this.call(Feature.MIXER_MIC, MixerMic.SET_NOISE_GATE, MixerMic.encodeSet(gate));
  }

  // ------------------------------------------------------------ stream-port routing (mixing matrix)

  async getRouting(output = 0): Promise<Routing> {
    const info = MixerAudio.decodeInfo(await this.call(Feature.MIXER_AUDIO, MixerAudio.GET_INFO));
    const inputs = MixerAudio.decodeInputs(await this.call(Feature.MIXER_AUDIO, MixerAudio.GET_INPUTS));
    const outputs = MixerAudio.decodeOutputs(await this.call(Feature.MIXER_AUDIO, MixerAudio.GET_OUTPUTS));
    const state = MixerAudio.decodeState(await this.call(Feature.MIXER_AUDIO, MixerAudio.GET_STATE, [output]), output);
    return { info, inputs, outputs, state };
  }

  async setRouting(state: RoutingState): Promise<void> {
    const info = MixerAudio.decodeInfo(await this.call(Feature.MIXER_AUDIO, MixerAudio.GET_INFO));
    const inputs = MixerAudio.decodeInputs(await this.call(Feature.MIXER_AUDIO, MixerAudio.GET_INPUTS));
    const outputs = MixerAudio.decodeOutputs(await this.call(Feature.MIXER_AUDIO, MixerAudio.GET_OUTPUTS));
    if (!outputs.some((o) => o.index === state.output)) throw new RangeError(`no routing output ${state.output}`);
    A50X.inRange(state.gain, 0, info.steps - 1, 'output gain');
    for (const i of state.inputs) {
      if (!inputs.some((x) => x.index === i.index)) throw new RangeError(`no routing input ${i.index}`);
      A50X.inRange(i.gain, 0, info.steps - 1, `input ${i.index} gain`);
    }
    await this.call(Feature.MIXER_AUDIO, MixerAudio.SET_STATE, MixerAudio.encodeSetState(state));
  }

  // ------------------------------------------------------------ equalizers

  async getEqualizerInfo(): Promise<Eq.EqInstanceInfo[]> {
    this.eqInfoCache ??= Eq.decodeInfo(await this.call(Feature.PARAMETRIC_EQ, Eq.EQ.GET_INFO));
    return this.eqInfoCache;
  }

  private async eqInstance(instance: number): Promise<Eq.EqInstanceInfo> {
    const info = (await this.getEqualizerInfo())[instance];
    if (!info) throw new RangeError(`EQ instance ${instance} does not exist`);
    return info;
  }

  async getEqualizer(instance: number): Promise<EqualizerState> {
    const info = await this.eqInstance(instance);
    const [activeSlot] = await this.call(Feature.PARAMETRIC_EQ, Eq.EQ.GET_ACTIVE_SLOT, [instance]);
    const bands = Eq.decodeLiveBands(await this.call(Feature.PARAMETRIC_EQ, Eq.EQ.GET_BANDS, [instance, Eq.customSlot(info)]));
    return { info, activeSlot, bands };
  }

  /** Read one of the read-only onboard presets (the curated presets G Hub shows). */
  async getOnboardPreset(instance: number, preset: number): Promise<Eq.Band[]> {
    const info = await this.eqInstance(instance);
    if (preset < 0 || preset >= info.readonlyPresets) throw new RangeError(`preset ${preset} out of range 0..${info.readonlyPresets - 1}`);
    return Eq.decodePresetBands(await this.call(Feature.PARAMETRIC_EQ, Eq.EQ.GET_PRESET, [instance, preset]));
  }

  /** Write bands into the custom slot and make it active, exactly as G Hub applies presets. */
  async applyEqualizer(instance: number, bands: Eq.Band[]): Promise<void> {
    const info = await this.eqInstance(instance);
    if (bands.length !== info.bandCount) throw new RangeError(`expected ${info.bandCount} bands, got ${bands.length}`);
    for (const b of bands) {
      if (b.gainStep < 0 || b.gainStep >= info.gainSteps) throw new RangeError(`gain step ${b.gainStep} out of range 0..${info.gainSteps - 1}`);
    }
    await this.call(Feature.PARAMETRIC_EQ, Eq.EQ.APPLY, Eq.encodeApply(instance, Eq.customSlot(info), bands));
  }

  /** Apply gains in dB to the instance's current band frequencies. */
  async applyEqualizerGains(instance: number, gainsDb: number[]): Promise<void> {
    const { info, bands } = await this.getEqualizer(instance);
    if (gainsDb.length !== bands.length) throw new RangeError(`expected ${bands.length} gains, got ${gainsDb.length}`);
    await this.applyEqualizer(instance, bands.map((b, k) => ({ ...b, gainStep: Eq.dbToStep(gainsDb[k], info) })));
  }

  async applyCuratedPreset(instance: number, preset: number): Promise<void> {
    await this.applyEqualizer(instance, await this.getOnboardPreset(instance, preset));
  }
}
