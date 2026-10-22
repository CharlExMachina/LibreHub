import { describe, expect, it } from 'vitest';
import {
  AutoSleep, Battery, BtHostInfo, DeviceInfo, DeviceName, FeatureSet, GameVoiceMix, HeadsetTones,
  LedBrightness, MixerAudio, MixerMic, Root, Sidetone, Volume, gateName,
} from '../../src/protocol/codecs.js';
import { decodeFrame, fromHex, toHex } from '../../src/protocol/packet.js';
import { CAPTURED, FEATURE_TABLE } from '../fixtures/captures.js';
import { frame } from '../sim/simulated-a50x.js';

const params = (hex: string) => {
  const f = decodeFrame(frame(hex));
  if (f?.kind !== 'message') throw new Error(`not a message: ${hex}`);
  return f.params;
};

describe('discovery', () => {
  it('Root.getFeature', () => {
    expect(Root.encodeGetFeature(0x0604)).toEqual([0x06, 0x04]);
    expect(Root.decodeGetFeature(params(CAPTURED.rootGetFeatureSet))).toEqual({ index: 1, type: 0, version: 1 });
  });

  it('FeatureSet batches decode into the captured 24-entry table', () => {
    expect(FeatureSet.decodeCount(params(CAPTURED.featureSetCount))).toBe(24);
    const all = [...FeatureSet.decodeFeatures(params(CAPTURED.featureSetFrom0), 0), ...FeatureSet.decodeFeatures(params(CAPTURED.featureSetFrom14), 14)];
    expect(all.map((f) => [f.index, f.id, f.version])).toEqual(FEATURE_TABLE);
  });
});

describe('device information', () => {
  it('hardware, firmware, serial, names', () => {
    expect(DeviceInfo.decodeHardware(params(CAPTURED.deviceInfoHardware))).toMatchObject({ modelId: 36, hardwareRevision: 7 });
    expect(DeviceInfo.decodeFirmware(params(CAPTURED.deviceInfoFirmware))).toEqual({ major: 1, minor: 2, build: 18, branch: 'main', version: '1.2.18' });
    expect(DeviceInfo.decodeSerial(params(CAPTURED.deviceInfoSerial))).toBe('0000XX0X0X00');
    expect(DeviceName.decodeModelName(params(CAPTURED.deviceModelName))).toBe('A50 X');
    expect(DeviceName.decodeName(params(CAPTURED.deviceName))).toEqual({ maxLength: 30, name: "Carlos'" });
  });

  it('battery', () => expect(Battery.decode(params(CAPTURED.battery)).percent).toBe(95));

  it('bluetooth host', () => {
    expect(BtHostInfo.decodeCount(params(CAPTURED.btHostCount))).toBe(1);
    expect(BtHostInfo.decodeAddress(params(CAPTURED.btHostAddress))).toBe('00:00:5E:00:53:01');
    expect(BtHostInfo.decodeName(params(CAPTURED.btHostName))).toBe('Example Bluetooth Host 01234');
  });
});

describe('settings', () => {
  it('sidetone: get, info, event and the accepted set layout', () => {
    expect(Sidetone.decode(params(CAPTURED.sidetoneGet))).toEqual({ step: 6, channel: 1 });
    expect(Sidetone.decode(params(CAPTURED.sidetoneEvent)).step).toBe(5);
    expect(Sidetone.decodeInfo(params(CAPTURED.sidetoneInfo))).toEqual({ steps: 7, rawMin: -18 });
    expect(toHex(Sidetone.encodeSet(5))).toBe(toHex(fromHex(CAPTURED.sidetoneSetRequest).slice(6)));
  });

  it('volume: level is the third byte, mute the second; set needs the 0xff render channel', () => {
    expect(Volume.decode(params(CAPTURED.volumeGet))).toEqual({ level: 21, muted: false, deviceScale: 31 });
    expect(Volume.decode(params(CAPTURED.volumeEventLevel19))).toEqual({ level: 19, muted: false, deviceScale: 28 });
    expect(Volume.decode(params(CAPTURED.volumeEventMuted)).muted).toBe(true);
    expect(Volume.decodeInfo(params(CAPTURED.volumeInfo))).toEqual({ levels: 22 });
    expect(toHex(Volume.encodeSetLevel(19))).toBe(toHex(fromHex(CAPTURED.volumeSetRequest).slice(6)));
    expect(Volume.encodeSetMute(true)).toEqual([1]);
  });

  it('game/voice balance', () => {
    expect(GameVoiceMix.decode(params(CAPTURED.mixGet))).toBe(6);
    expect(GameVoiceMix.decode(params(CAPTURED.mixEvent))).toBe(5);
    expect(GameVoiceMix.decodeInfo(params(CAPTURED.mixInfo))).toEqual({ maxStep: 12, leftSource: 5, rightSource: 4 });
  });

  it('sleep timer, brightness, tones', () => {
    expect(AutoSleep.decode(params(CAPTURED.sleepGet))).toEqual({ lead: 0x3c, minutes: 30 });
    expect(AutoSleep.decode(params(CAPTURED.sleepEvent15)).minutes).toBe(15);
    expect(AutoSleep.decode(params(CAPTURED.sleepEventNever)).minutes).toBe(0);
    expect(AutoSleep.decode(params(CAPTURED.sleepEvent60)).minutes).toBe(60);
    expect(AutoSleep.decode(params(CAPTURED.sleepAfterOneByteWrite))).toEqual({ lead: 0x1e, minutes: 0 });
    // the setter must reproduce G Hub's two-byte layout exactly
    for (const [minutes, hex] of [[0, CAPTURED.sleepEventNever], [15, CAPTURED.sleepEvent15], [60, CAPTURED.sleepEvent60]] as const) {
      expect(AutoSleep.encodeSet(minutes)).toEqual(Array.from(params(hex)));
    }
    expect(LedBrightness.decode(params(CAPTURED.brightnessGet))).toBe(100);
    expect(() => LedBrightness.encodeSet(101)).toThrow(RangeError);
    expect(HeadsetTones.decode(params(CAPTURED.tonesGet))).toBe(HeadsetTones.VALUES.all);
    expect(HeadsetTones.decode(params(CAPTURED.tonesEventMinimal))).toBe(HeadsetTones.VALUES.minimal);
  });

  it('noise gate: supported list and events use G Hub enum values', () => {
    expect(MixerMic.decodeSupported(params(CAPTURED.gateSupported))).toEqual([0, 1, 2, 4]);
    expect(MixerMic.decodeGate(params(CAPTURED.gateGet))).toBe(0);
    expect(gateName(MixerMic.decodeGate(params(CAPTURED.gateEventHome)))).toBe('home');
    expect(gateName(MixerMic.decodeGate(params(CAPTURED.gateEventTournament)))).toBe('tournament');
    expect(gateName(9)).toBe('unknown(9)');
  });
});

describe('stream-port routing', () => {
  it('inputs, outputs and info', () => {
    expect(MixerAudio.decodeInputs(params(CAPTURED.routingInputs)).map((i) => [i.index, i.name])).toEqual([[0, 'mic'], [1, 'game'], [2, 'bluetooth'], [3, 'voice']]);
    expect(MixerAudio.decodeOutputs(params(CAPTURED.routingOutputs))).toEqual([{ index: 0, type: 9, name: 'stream', routedMask: 0x0f }]);
    expect(MixerAudio.decodeInfo(params(CAPTURED.routingInfo))).toEqual({ maxInputs: 4, minGainDb: -32, maxGainDb: 0, steps: 33 });
  });

  it('state, event, and a set request identical to the one the device accepted', () => {
    const state = MixerAudio.decodeState(params(CAPTURED.routingState), 0);
    expect(state).toEqual({ output: 0, gain: 26, muted: false, inputs: [
      { index: 0, gain: 16, muted: true }, { index: 1, gain: 16, muted: false },
      { index: 2, gain: 16, muted: true }, { index: 3, gain: 16, muted: false }] });
    const game25 = { ...state, inputs: state.inputs.map((i) => (i.index === 1 ? { ...i, gain: 8 } : i)) };
    expect(MixerAudio.decodeEvent(params(CAPTURED.routingEventGame25))).toEqual(game25);
    expect(toHex(MixerAudio.encodeSetState(game25))).toBe(toHex(fromHex(CAPTURED.routingSetGame25Request).slice(6)) + ' 00');
  });
});
