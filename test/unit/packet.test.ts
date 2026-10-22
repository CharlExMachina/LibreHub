import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeRequest, fromHex, toHex } from '../../src/protocol/packet.js';
import { CAPTURED } from '../fixtures/captures.js';
import { frame } from '../sim/simulated-a50x.js';

const trimmed = (r: Uint8Array) => toHex(r.slice(0, 3 + r[2]));

describe('encodeRequest', () => {
  it('reproduces the sidetone write that the device accepted', () => {
    const r = encodeRequest({ featureIndex: 0x09, fn: 1, swid: 0xb, params: [0x01, 0xff, 0x05] });
    expect(r.length).toBe(64);
    expect(trimmed(r)).toBe(CAPTURED.sidetoneSetRequest);
    expect(Array.from(r.slice(9)).every((b) => b === 0)).toBe(true);
  });

  it('reproduces the EQ apply request byte for byte', () => {
    const want = fromHex(CAPTURED.eqApplyMicFlatRequest);
    const r = encodeRequest({ featureIndex: 0x0d, fn: 2, swid: 0xb, params: want.slice(6) });
    expect(trimmed(r)).toBe(CAPTURED.eqApplyMicFlatRequest);
  });

  it('rejects out-of-range function, software id and oversized params', () => {
    expect(() => encodeRequest({ featureIndex: 1, fn: 16, swid: 1 })).toThrow(RangeError);
    expect(() => encodeRequest({ featureIndex: 1, fn: 0, swid: 16 })).toThrow(RangeError);
    expect(() => encodeRequest({ featureIndex: 1, fn: 0, swid: 1, params: new Array(59).fill(0) })).toThrow(RangeError);
  });
});

describe('decodeFrame', () => {
  it('decodes a response', () => {
    const f = decodeFrame(frame(CAPTURED.sidetoneGet));
    expect(f).toEqual({ kind: 'message', device: 0, featureIndex: 9, fn: 0, swid: 0xb, params: Uint8Array.from([1, 1, 0xff, 6]) });
  });

  it('decodes an unsolicited event as swid 0', () => {
    const f = decodeFrame(frame(CAPTURED.mixEvent));
    expect(f).toMatchObject({ kind: 'message', featureIndex: 0x0a, fn: 0, swid: 0 });
  });

  it('decodes an error frame', () => {
    expect(decodeFrame(frame(CAPTURED.sidetoneSetOutOfRange))).toEqual({ kind: 'error', device: 0, featureIndex: 9, fn: 1, swid: 0xb, code: 0x0b });
  });

  it('ignores reports that are not Centurion frames or are truncated', () => {
    expect(decodeFrame(Uint8Array.from([0x01, 0x0c, 3, 0, 0, 0]))).toBeUndefined();
    expect(decodeFrame(Uint8Array.from([0x02, 0x0d, 3, 0, 0, 0]))).toBeUndefined();
    expect(decodeFrame(fromHex(CAPTURED.routingState))).toBeUndefined(); // trailing zero trimmed → shorter than LEN
  });
});

describe('hex helpers', () => {
  it('round-trips', () => expect(toHex(fromHex('02 0c ff'))).toBe('02 0c ff'));
  it('rejects garbage', () => expect(() => fromHex('02 zz')).toThrow());
});
