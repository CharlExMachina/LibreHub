// AdvancedParaEQ (feature 0x020D): two 10-band parametric EQ instances.
//   instance 0 = microphone (audio path HEADSET_MIC)
//   instance 1 = headphones (audio paths GAME_IN | VOICE_IN | STREAM_OUT | BT_IN)
//
// Each instance has 3 read-only onboard presets (slots 0..2) and 1 writable custom slot (slot 3).
// G Hub applies every preset, curated or custom, by writing all 10 bands into the custom slot.
//
// A band is 5 bytes: [freq Hz u16 BE][q u8][gain step u16 BE].
// Gain steps map linearly onto gainMin..gainMax dB (-6..+6 in 241 steps, so 0.05 dB/step, 120 = 0 dB).

import { DecodeError } from './codecs.js';

export const EQ = {
  GET_INFO: 0, // also the function number of the "bands changed" event (swid 0)
  GET_BANDS: 1,
  APPLY: 2,
  GET_ACTIVE_SLOT: 3,
  GET_PRESET: 5,
} as const;

export const MIC = 0;
export const HEADPHONES = 1;

/** Q byte G Hub writes for every band; read-only mic presets report 0 here. */
export const DEFAULT_Q = 0x16;

/** Curated preset names, in onboard slot order, as G Hub labels them (verified by applying each one in G Hub). */
export const CURATED_PRESETS: Record<number, string[]> = {
  [MIC]: ['Default', 'Competition', 'Broadcast'],
  [HEADPHONES]: ['Default', 'Gaming', 'Media'],
};

export const AUDIO_PATHS = { headsetMic: 1, gameIn: 2, voiceIn: 4, streamOut: 8, bluetoothIn: 16 } as const;

export interface EqInstanceInfo {
  instance: number;
  readonlyPresets: number;
  customPresets: number;
  gainMinDb: number;
  gainMaxDb: number;
  gainSteps: number;
  audioPathMask: number;
  bandCount: number;
}

export interface Band {
  frequency: number;
  q: number;
  gainStep: number;
}

const i8 = (v: number) => (v > 0x7f ? v - 0x100 : v);

/** fn0: [instanceCount] then 12 bytes per instance:
 *  [readonly<<4 | custom][gainMin i8][gainMax i8][steps u16][pathMask u32][bandCount][2 unknown bytes] */
export function decodeInfo(p: Uint8Array): EqInstanceInfo[] {
  if (p.length < 1 || p.length < 1 + p[0] * 12) throw new DecodeError(`EQ.info: short payload (${p.length} bytes)`);
  return Array.from({ length: p[0] }, (_, k) => {
    const o = 1 + k * 12;
    return {
      instance: k,
      readonlyPresets: p[o] >> 4,
      customPresets: p[o] & 0x0f,
      gainMinDb: i8(p[o + 1]),
      gainMaxDb: i8(p[o + 2]),
      gainSteps: (p[o + 3] << 8) | p[o + 4],
      audioPathMask: ((p[o + 5] << 24) | (p[o + 6] << 16) | (p[o + 7] << 8) | p[o + 8]) >>> 0,
      bandCount: p[o + 9],
    };
  });
}

export function decodeBands(p: Uint8Array, offset = 0): Band[] {
  const n = Math.floor((p.length - offset) / 5);
  return Array.from({ length: n }, (_, k) => {
    const o = offset + k * 5;
    return { frequency: (p[o] << 8) | p[o + 1], q: p[o + 2], gainStep: (p[o + 3] << 8) | p[o + 4] };
  });
}

/** fn1 (live bands) response: [00] then bands. */
export function decodeLiveBands(p: Uint8Array): Band[] {
  if (p.length < 1 + 5) throw new DecodeError(`EQ.live: short payload (${p.length} bytes)`);
  return decodeBands(p, 1);
}

/** fn5 (onboard preset) response: bands only, no leading byte. */
export function decodePresetBands(p: Uint8Array): Band[] {
  if (p.length < 5) throw new DecodeError(`EQ.preset: short payload (${p.length} bytes)`);
  return decodeBands(p, 0);
}

/** fn0 event (swid 0): [instance][slot][00] then bands. */
export function decodeBandsEvent(p: Uint8Array): { instance: number; slot: number; bands: Band[] } {
  if (p.length < 3 + 5) throw new DecodeError(`EQ.event: short payload (${p.length} bytes)`);
  return { instance: p[0], slot: p[1], bands: decodeBands(p, 3) };
}

/** fn2 request: [instance][slot][00] then bands. */
export function encodeApply(instance: number, slot: number, bands: Band[]): number[] {
  const out = [instance, slot, 0x00];
  for (const b of bands) {
    if (!Number.isInteger(b.frequency) || b.frequency < 1 || b.frequency > 0xffff) throw new RangeError(`bad frequency ${b.frequency}`);
    if (!Number.isInteger(b.gainStep) || b.gainStep < 0 || b.gainStep > 0xffff) throw new RangeError(`bad gain step ${b.gainStep}`);
    const q = b.q === 0 ? DEFAULT_Q : b.q;
    out.push(b.frequency >> 8, b.frequency & 0xff, q, b.gainStep >> 8, b.gainStep & 0xff);
  }
  return out;
}

export function stepToDb(step: number, info: Pick<EqInstanceInfo, 'gainMinDb' | 'gainMaxDb' | 'gainSteps'>): number {
  const perStep = (info.gainMaxDb - info.gainMinDb) / (info.gainSteps - 1);
  return Math.round((info.gainMinDb + step * perStep) * 100) / 100;
}

export function dbToStep(db: number, info: Pick<EqInstanceInfo, 'gainMinDb' | 'gainMaxDb' | 'gainSteps'>): number {
  if (!Number.isFinite(db)) throw new RangeError(`gain ${db} dB is not a number`);
  const perStep = (info.gainMaxDb - info.gainMinDb) / (info.gainSteps - 1);
  const step = Math.round((db - info.gainMinDb) / perStep);
  return Math.min(info.gainSteps - 1, Math.max(0, step));
}

/** The custom (writable) slot follows the read-only ones. */
export const customSlot = (info: Pick<EqInstanceInfo, 'readonlyPresets'>) => info.readonlyPresets;
