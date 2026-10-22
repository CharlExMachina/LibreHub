import { describe, expect, it } from 'vitest';
import * as Eq from '../../src/protocol/eq.js';
import { decodeFrame, fromHex, toHex } from '../../src/protocol/packet.js';
import { CAPTURED } from '../fixtures/captures.js';
import { frame } from '../sim/simulated-a50x.js';

const params = (hex: string) => {
  const f = decodeFrame(frame(hex));
  if (f?.kind !== 'message') throw new Error('not a message');
  return f.params;
};

describe('EQ info', () => {
  it('decodes both instances', () => {
    const [mic, hp] = Eq.decodeInfo(params(CAPTURED.eqInfo));
    expect(mic).toEqual({ instance: 0, readonlyPresets: 3, customPresets: 1, gainMinDb: -6, gainMaxDb: 6, gainSteps: 241, audioPathMask: Eq.AUDIO_PATHS.headsetMic, bandCount: 10 });
    expect(hp.audioPathMask).toBe(Eq.AUDIO_PATHS.gameIn | Eq.AUDIO_PATHS.voiceIn | Eq.AUDIO_PATHS.streamOut | Eq.AUDIO_PATHS.bluetoothIn);
    expect(Eq.customSlot(hp)).toBe(3);
  });
});

describe('EQ bands', () => {
  const info = { gainMinDb: -6, gainMaxDb: 6, gainSteps: 241 };

  it('decodes the curated headphone presets G Hub applies', () => {
    const gaming = Eq.decodePresetBands(params(CAPTURED.eqHeadphonesPreset1));
    expect(gaming.map((b) => b.frequency)).toEqual([20, 50, 125, 250, 500, 1000, 2500, 5000, 10000, 20000]);
    expect(gaming.map((b) => Eq.stepToDb(b.gainStep, info))).toEqual([-5, -4.5, -3.5, -2, 0, 2, 3, 3, 3, 3]);
    // G Hub's "Gaming" event carries exactly the onboard preset 1 bands
    expect(Eq.decodeBandsEvent(params(CAPTURED.eqEventHeadphonesGaming))).toEqual({ instance: 1, slot: 3, bands: gaming });
  });

  it('decodes the curated mic presets', () => {
    const competition = Eq.decodePresetBands(params(CAPTURED.eqMicPreset1));
    expect(competition.map((b) => b.frequency)).toEqual([80, 150, 250, 400, 800, 1500, 2500, 5000, 10000, 19000]);
    expect(competition.map((b) => Eq.stepToDb(b.gainStep, info))).toEqual([-3, -3, -1.5, 0, 0, 1, 1.5, 1.5, 1.5, 2]);
    expect(competition.every((b) => b.q === 0)).toBe(true);
  });

  it('decodes live bands, which carry one leading byte', () => {
    const live = Eq.decodeLiveBands(params(CAPTURED.eqMicLive));
    expect(live).toHaveLength(10);
    expect(live[0]).toEqual({ frequency: 80, q: 0x16, gainStep: 120 });
  });

  it('encodes an apply request byte-identical to the one the device accepted (q=0 becomes 0x16)', () => {
    const flat = Eq.decodePresetBands(params(CAPTURED.eqMicPreset0));
    expect(toHex(Eq.encodeApply(0, 3, flat))).toBe(toHex(fromHex(CAPTURED.eqApplyMicFlatRequest).slice(6)));
  });

  it('converts between dB and steps, clamping to the device range', () => {
    expect(Eq.dbToStep(0, info)).toBe(120);
    expect(Eq.dbToStep(-6, info)).toBe(0);
    expect(Eq.dbToStep(6, info)).toBe(240);
    expect(Eq.dbToStep(9, info)).toBe(240);
    expect(Eq.dbToStep(2.52, info)).toBe(170);
    expect(Eq.stepToDb(170, info)).toBe(2.5);
    expect(() => Eq.dbToStep(Number.NaN, info)).toThrow(RangeError);
  });

  it('names curated presets in onboard order', () => {
    expect(Eq.CURATED_PRESETS[Eq.MIC]).toEqual(['Default', 'Competition', 'Broadcast']);
    expect(Eq.CURATED_PRESETS[Eq.HEADPHONES]).toEqual(['Default', 'Gaming', 'Media']);
  });
});
