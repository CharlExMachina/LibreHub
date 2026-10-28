// Parameter codecs for each A50 X feature. Every function number and byte layout here was
// observed on a real A50 X (base station firmware 1.2.18); see docs/PROTOCOL.md for the captures.

export class DecodeError extends Error {}

function need(params: Uint8Array, n: number, what: string): void {
  if (params.length < n) throw new DecodeError(`${what}: expected at least ${n} bytes, got ${params.length}`);
}

const u16 = (p: Uint8Array, i: number) => (p[i] << 8) | p[i + 1];
const i8 = (v: number) => (v > 0x7f ? v - 0x100 : v);
const ascii = (p: Uint8Array, start: number, len: number) => String.fromCharCode(...p.slice(start, start + len));

function checkByte(value: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${what} must be an integer ${min}..${max}, got ${value}`);
  return value;
}

// ---------------------------------------------------------------- Root (0x0000)
export const Root = {
  GET_FEATURE: 0,
  encodeGetFeature: (featureId: number) => [featureId >> 8, featureId & 0xff],
  /** fn0 response: [index][type][version] */
  decodeGetFeature(p: Uint8Array) {
    need(p, 3, 'Root.getFeature');
    return { index: p[0], type: p[1], version: p[2] };
  },
};

// ---------------------------------------------------------------- FeatureSet (0x0001)
export const FeatureSet = {
  GET_COUNT: 0,
  GET_FEATURES: 1,
  decodeCount: (p: Uint8Array) => (need(p, 1, 'FeatureSet.count'), p[0]),
  /** fn1(start) response: [n] then n × (idHi idLo type version), starting at index `start`. */
  decodeFeatures(p: Uint8Array, start: number) {
    need(p, 1, 'FeatureSet.features');
    const n = p[0];
    need(p, 1 + n * 4, 'FeatureSet.features');
    return Array.from({ length: n }, (_, k) => ({
      index: start + k,
      id: u16(p, 1 + k * 4),
      type: p[3 + k * 4],
      version: p[4 + k * 4],
    }));
  },
};

// ---------------------------------------------------------------- DeviceInfo (0x0100)
export const DeviceInfo = {
  GET_HARDWARE: 0,
  GET_FIRMWARE: 1,
  GET_SERIAL: 2,
  /** fn0: [modelId][hardwareRevision][...7 more bytes, meaning unknown] */
  decodeHardware(p: Uint8Array) {
    need(p, 2, 'DeviceInfo.hardware');
    return { modelId: p[0], hardwareRevision: p[1], raw: Array.from(p) };
  },
  /** fn1: [major][minor][build u16][branchLen][branch ascii]  e.g. 01 02 00 12 04 "main" = 1.2.18 main */
  decodeFirmware(p: Uint8Array) {
    need(p, 5, 'DeviceInfo.firmware');
    const branch = ascii(p, 5, p[4]);
    return { major: p[0], minor: p[1], build: u16(p, 2), branch, version: `${p[0]}.${p[1]}.${u16(p, 2)}` };
  },
  /** fn2: [len][ascii] */
  decodeSerial: (p: Uint8Array) => (need(p, 1, 'DeviceInfo.serial'), ascii(p, 1, p[0])),
};

// ---------------------------------------------------------------- DeviceName (0x0101)
export const DeviceName = {
  GET_NAME: 0,
  GET_MODEL_NAME: 2,
  /** fn0: [maxLength][length][utf8 name] (the user-given name, e.g. "Carlos'") */
  decodeName(p: Uint8Array) {
    need(p, 2, 'DeviceName.name');
    return { maxLength: p[0], name: new TextDecoder().decode(p.slice(2, 2 + p[1])) };
  },
  /** fn2: [length][ascii]  e.g. "A50 X" */
  decodeModelName: (p: Uint8Array) => (need(p, 1, 'DeviceName.model'), ascii(p, 1, p[0])),
};

// ---------------------------------------------------------------- Battery (0x0104)
export const Battery = {
  GET: 0,
  /** fn0 and event: [percent][second byte, equal to percent in every observation] */
  decode: (p: Uint8Array) => (need(p, 1, 'Battery'), { percent: p[0], raw: Array.from(p.slice(0, 2)) }),
};

// ---------------------------------------------------------------- AutoSleep (0x0108)
export const AutoSleep = {
  GET: 0,
  SET: 1,
  /** G Hub offers exactly these; 0 means never. */
  CHOICES: [0, 15, 30, 60] as const,
  /** First byte G Hub writes with every sleep setting (Never/15/30/60 → 3c 00 / 3c 0f / 3c 1e / 3c 3c). Meaning unknown. */
  LEAD: 0x3c,
  /** fn0 and event: [lead][minutes]. */
  decode: (p: Uint8Array) => (need(p, 2, 'AutoSleep'), { minutes: p[1], lead: p[0] }),
  /** The device accepts a 1-byte write too, but then stores [minutes][00] (i.e. "never"). Always send both bytes. */
  encodeSet: (minutes: number) => [AutoSleep.LEAD, checkByte(minutes, 0, 0xff, 'sleep minutes')],
};

// ---------------------------------------------------------------- LEDBrightness (0x0110)
export const LedBrightness = {
  GET: 0,
  SET: 1,
  /** fn0: [percent 0..100] */
  decode: (p: Uint8Array) => (need(p, 1, 'LedBrightness'), p[0]),
  encodeSet: (percent: number) => [checkByte(percent, 0, 100, 'brightness')],
};

// ---------------------------------------------------------------- VolumeSet (0x0200)
export const Volume = {
  GET: 0,
  SET_LEVEL: 1,
  SET_MUTE: 2,
  GET_INFO: 3,
  /** Channel byte the set call requires; G Hub logs "Only Render volume can be set through feature 0200". */
  RENDER: 0xff,
  /** fn0 and event: [deviceScale 0..31][muted][level]; deviceScale tracks level (31 at 21, 28 at 19). */
  decode(p: Uint8Array) {
    need(p, 3, 'Volume');
    return { level: p[2], muted: p[1] !== 0, deviceScale: p[0] };
  },
  /** fn3: [levelCount] (22 → levels 0..21) */
  decodeInfo: (p: Uint8Array) => (need(p, 1, 'Volume.info'), { levels: p[0] }),
  encodeSetLevel: (level: number) => [0xff, checkByte(level, 0, 0xfe, 'volume level')],
  encodeSetMute: (muted: boolean) => [muted ? 1 : 0],
};

// ---------------------------------------------------------------- HeadsetAudioSidetone (0x0604)
export const Sidetone = {
  GET: 0,
  SET: 1,
  GET_INFO: 2,
  /** fn0 and event: [count=1][channel 01][ff][step] */
  decode(p: Uint8Array) {
    need(p, 4, 'Sidetone');
    return { step: p[3], channel: p[1] };
  },
  /** fn2: [minDb i8?][?][steps]  e.g. ee 00 07 → 7 steps (0..6) */
  decodeInfo(p: Uint8Array) {
    need(p, 3, 'Sidetone.info');
    return { steps: p[2], rawMin: i8(p[0]) };
  },
  encodeSet: (step: number) => [0x01, 0xff, checkByte(step, 0, 0xfe, 'sidetone step')],
};

// ---------------------------------------------------------------- HeadsetMix (0x0609), game/voice balance
export const GameVoiceMix = {
  GET: 0,
  SET: 1,
  GET_INFO: 2,
  decode: (p: Uint8Array) => (need(p, 1, 'Mix'), p[0]),
  /** fn2: [maxStep][leftSource][rightSource] e.g. 0c 05 04 */
  decodeInfo(p: Uint8Array) {
    need(p, 3, 'Mix.info');
    return { maxStep: p[0], leftSource: p[1], rightSource: p[2] };
  },
  encodeSet: (balance: number) => [checkByte(balance, 0, 0xfe, 'balance')],
};

// ---------------------------------------------------------------- HeadsetTones (0x060B)
export const HeadsetTones = {
  GET: 0,
  SET: 1,
  /** G Hub labels: NONE / ALL / MINIMAL (protobuf DISABLED / ENABLED / PARTIALLY_ENABLED). */
  VALUES: { none: 0, all: 1, minimal: 2 } as const,
  decode: (p: Uint8Array) => (need(p, 1, 'HeadsetTones'), p[0]),
  encodeSet: (state: number) => [checkByte(state, 0, 2, 'tones state')],
};

export type TonesName = keyof typeof HeadsetTones.VALUES;

// ---------------------------------------------------------------- MicTest (0x020E)
export const MicTest = {
  /** Event fn0: [00] when the headset comes off the dock or is turned on, [05] when it's docked or turned off. */
  decodeEvent: (p: Uint8Array) => (need(p, 1, 'MicTest'), { ready: p[0] === 0, code: p[0] }),
};

// ---------------------------------------------------------------- MixerMic (0x0801), noise gate
export const MixerMic = {
  GET_CAPABILITIES: 0,
  GET_NOISE_GATE: 1,
  SET_NOISE_GATE: 2,
  GET_SUPPORTED_GATES: 3,
  /** Values match G Hub's protobuf enum logi.protocol.audio.MixerMic.NoiseGateSetting. */
  GATES: { off: 0, home: 1, night: 2, stream: 3, tournament: 4, pushToTalk: 5, clearVoice: 6 } as const,
  decodeGate: (p: Uint8Array) => (need(p, 1, 'NoiseGate'), p[0]),
  /** fn3: [count][gate...]  e.g. 04 00 01 02 04 */
  decodeSupported(p: Uint8Array) {
    need(p, 1, 'NoiseGate.supported');
    need(p, 1 + p[0], 'NoiseGate.supported');
    return Array.from(p.slice(1, 1 + p[0]));
  },
  encodeSet: (gate: number) => [checkByte(gate, 0, 0xfe, 'noise gate')],
};

export type NoiseGateName = keyof typeof MixerMic.GATES;

export function gateName(value: number): NoiseGateName | `unknown(${number})` {
  const hit = Object.entries(MixerMic.GATES).find(([, v]) => v === value);
  return hit ? (hit[0] as NoiseGateName) : `unknown(${value})`;
}

// ---------------------------------------------------------------- BtHostInfo (0x0305)
export const BtHostInfo = {
  GET_COUNT: 0,
  GET_ADDRESS: 1,
  GET_NAME: 2,
  decodeCount: (p: Uint8Array) => (need(p, 1, 'BtHost.count'), p[0]),
  decodeAddress: (p: Uint8Array) => (need(p, 6, 'BtHost.address'), Array.from(p.slice(0, 6), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')),
  /** fn2: [maxLength][length][utf8 name] */
  decodeName: (p: Uint8Array) => (need(p, 2, 'BtHost.name'), new TextDecoder().decode(p.slice(2, 2 + p[1]))),
};

// ---------------------------------------------------------------- MixerAudio (0x0800), stream-port routing
export const MixerAudio = {
  GET_INPUTS: 0,
  GET_OUTPUTS: 1,
  EVENT_STATE: 2,
  GET_INFO: 4,
  GET_STATE: 5,
  SET_STATE: 6,
  /** Type codes match G Hub's logi.protocol.audio.MixingMatrix enums. */
  INPUT_TYPES: { 6: 'game', 7: 'voice', 9: 'bluetooth', 10: 'mic' } as Record<number, string>,
  OUTPUT_TYPES: { 9: 'stream' } as Record<number, string>,
  /** fn0: [count] then count × (type ? ? index) */
  decodeInputs(p: Uint8Array) {
    need(p, 1, 'MixerAudio.inputs');
    need(p, 1 + p[0] * 4, 'MixerAudio.inputs');
    return Array.from({ length: p[0] }, (_, k) => {
      const type = p[1 + k * 4];
      return { index: p[4 + k * 4], type, name: MixerAudio.INPUT_TYPES[type] ?? `type${type}` };
    });
  },
  /** fn1: [count] then count × (type ? ? index routedInputMask) */
  decodeOutputs(p: Uint8Array) {
    need(p, 1, 'MixerAudio.outputs');
    need(p, 1 + p[0] * 5, 'MixerAudio.outputs');
    return Array.from({ length: p[0] }, (_, k) => {
      const type = p[1 + k * 5];
      return { index: p[4 + k * 5], type, name: MixerAudio.OUTPUT_TYPES[type] ?? `type${type}`, routedMask: p[5 + k * 5] };
    });
  },
  /** fn4: [maxInputs][minGain dB i8][maxGain dB i8][steps]  e.g. 04 e0 00 21 → -32..0 dB, 33 steps */
  decodeInfo(p: Uint8Array) {
    need(p, 4, 'MixerAudio.info');
    return { maxInputs: p[0], minGainDb: i8(p[1]), maxGainDb: i8(p[2]), steps: p[3] };
  },
  /** fn5 response (no output byte): [gain][mute][count] then count × (input gain mute) */
  decodeState(p: Uint8Array, output: number): RoutingState {
    need(p, 3, 'MixerAudio.state');
    need(p, 3 + p[2] * 3, 'MixerAudio.state');
    return {
      output,
      gain: p[0],
      muted: p[1] !== 0,
      inputs: Array.from({ length: p[2] }, (_, k) => ({ index: p[3 + k * 3], gain: p[4 + k * 3], muted: p[5 + k * 3] !== 0 })),
    };
  },
  /** fn2 event and fn6 set share this layout, prefixed by the output index. */
  decodeEvent: (p: Uint8Array) => (need(p, 1, 'MixerAudio.event'), MixerAudio.decodeState(p.slice(1), p[0])),
  encodeSetState(s: RoutingState) {
    const out = [checkByte(s.output, 0, 0xfe, 'output'), checkByte(s.gain, 0, 0xfe, 'output gain'), s.muted ? 1 : 0, s.inputs.length];
    for (const i of s.inputs) out.push(checkByte(i.index, 0, 0xfe, 'input'), checkByte(i.gain, 0, 0xfe, 'input gain'), i.muted ? 1 : 0);
    return out;
  },
};

export interface RoutingState {
  output: number;
  gain: number;
  muted: boolean;
  inputs: { index: number; gain: number; muted: boolean }[];
}
