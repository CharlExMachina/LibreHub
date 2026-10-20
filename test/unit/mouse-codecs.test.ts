// Replies captured from the real G502 X PLUS (tools/re/hidpp.mjs; docs/evidence/g502x/).
import { describe, expect, it } from 'vitest';
import { AdjustableDpi, FirmwareInfo, HiResWheel, OnboardProfiles, ReportRate, RgbEffects, UnifiedBattery } from '../../src/mouse/codecs.js';
import { decodeConnection, decodeFrame, encodeRequest, fromHex, toHex } from '../../src/mouse/hidpp.js';
import { EFFECT_DEFAULTS, formatEffect, parseEffect } from '../../src/mouse/presets.js';
import { dimmed, placeEffect } from '../../src/mouse/service.js';
import { formatBinding, parseBinding } from '../../src/mouse/usages.js';

const params = (hex: string) => fromHex(hex).slice(4);

describe('HID++ framing', () => {
  it('encodes a long request with our software id', () => {
    expect(toHex(encodeRequest({ deviceIndex: 1, featureIndex: 0x0b, fn: 5, swid: 0x0b, params: [0, 1, 0, 0] }))).toBe('11 01 0b 5b 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00');
    expect(() => encodeRequest({ deviceIndex: 1, featureIndex: 0, fn: 16, swid: 1 })).toThrow(RangeError);
  });

  it('tells replies, events, feature errors, receiver errors and notifications apart', () => {
    expect(decodeFrame(fromHex('11 01 07 2d 00 04 b0 06 40 00 00 00 00 00 00 00 00 00 00 00'))).toMatchObject({ kind: 'message', featureIndex: 7, fn: 2, swid: 0xd });
    expect(decodeFrame(fromHex('11 01 06 00 22 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00'))).toMatchObject({ kind: 'message', featureIndex: 6, fn: 0, swid: 0 });
    expect(decodeFrame(fromHex('11 01 ff 0b 5b 02 00 00 00 00 00 00 00 00 00 00 00 00 00 00'))).toMatchObject({ kind: 'error', featureIndex: 0x0b, fn: 5, code: 2 });
    expect(decodeFrame(fromHex('10 01 8f 00 1b 08 00'))).toMatchObject({ kind: 'receiverError', featureIndex: 0, fn: 1, swid: 0xb, code: 8 });
    const n = decodeFrame(fromHex('10 01 41 11 32 99 40'));
    expect(n).toMatchObject({ kind: 'notification', subId: 0x41 });
    expect(decodeConnection((n as { params: Uint8Array }).params)).toMatchObject({ linkEstablished: true, wirelessPid: 0x4099 });
    expect(decodeFrame(fromHex('11 ff 83 b5 20 07 08 40 99 11 00 02 b1 00 00 00 00 24 00 00'))).toMatchObject({ kind: 'notification', deviceIndex: 0xff, subId: 0x83 });
  });
});

describe('feature codecs', () => {
  it('decodes the onboard description', () => {
    expect(OnboardProfiles.decodeDescription(params('11 01 0b 0b 01 05 01 05 02 0b 10 00 ff 0a 04 00 00 00 00 00'))).toEqual({
      memoryModel: 1, profileFormat: 5, macroFormat: 1, profileCount: 5, factoryProfileCount: 2, buttonCount: 11,
      sectorCount: 16, sectorSize: 255, mechanicalLayout: 0x0a, variousInfo: 4, hasGShift: true,
    });
  });

  it('decodes the DPI range list (100..25600 in steps of 50) and validates against it', () => {
    const list = AdjustableDpi.decodeDpiList(params('11 01 07 1b 00 00 64 e0 32 64 00 00 00 00 00 00 00 00 00 00'));
    expect(list).toEqual({ ranges: [{ min: 100, max: 25600, step: 50 }], values: [] });
    expect([100, 1650, 25600, 75, 1625, 25650].map((d) => AdjustableDpi.isValid(d, list))).toEqual([true, true, true, false, false, false]);
    expect(AdjustableDpi.decodeDpi(params('11 01 07 2d 00 04 b0 06 40 00 00 00 00 00 00 00 00 00 00 00'))).toEqual({ dpi: 1200, defaultDpi: 1600 });
    expect(AdjustableDpi.encodeSetDpi(2400, 4)).toEqual([0, 0x09, 0x60, 4]); // G Hub: 07 3d 00 09 60 04
  });

  it('decodes the report-rate list and battery', () => {
    expect(ReportRate.decodeList([0x8b] as unknown as Uint8Array)).toEqual([1, 2, 4, 8]);
    expect(UnifiedBattery.decodeStatus(params('11 01 06 1b 24 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00'))).toEqual({ percent: 36, level: 'good', charging: 'discharging', externalPower: false });
  });

  it('decodes firmware entities the way G Hub shows them', () => {
    expect(FirmwareInfo.decodeEntity(params('11 01 02 1b 00 4d 50 4d 27 00 00 16 01 40 99 fb b1 3a 33 00'))).toEqual({ type: 'application', name: 'MPM27', version: '27.0.16' });
    expect(FirmwareInfo.decodeEntity(params('11 01 02 1b 01 42 4c 31 42 00 00 16 00 ab 0b fb b1 3a 33 00'))).toEqual({ type: 'bootloader', name: 'BL142', version: '42.0.16' });
    expect(FirmwareInfo.decodeInfo(params('11 01 02 0b 0c 49 96 02 d2 00 0c 40 99 c0 95 00 00 00 01 00')).serial).toBe('1234567890');
  });

  it('decodes wheel capability and RGB power config', () => {
    expect(HiResWheel.decodeCapability(fromHex('08 0c'))).toEqual({ multiplier: 8, hasInvert: true, hasRatchetSwitch: true });
    expect(RgbEffects.decodePowerConfig(fromHex('00 00 00 00 3c 01 2c'))).toEqual({ idleSeconds: 60, sleepSeconds: 300 });
    expect(RgbEffects.encodeSetPowerConfig(120, 900)).toEqual([1, 0, 0, 0, 120, 3, 0x84]);
    expect(RgbEffects.decodeStartupEffect(fromHex('00 00 01 02'))).toBe(false);
  });
});

describe('binding text syntax', () => {
  it.each(['mouse:left', 'mouse:back+forward', 'key:ctrl+shift+t', 'key:f13', 'media:volume-up', 'fn:dpi-shift', 'fn:g-shift', 'disabled', 'default'])('%s round-trips', (t) => {
    expect(formatBinding(parseBinding(t))).toBe(t);
  });

  it('rejects nonsense with a useful message', () => {
    expect(() => parseBinding('key:hyper+a')).toThrow(/unknown modifier/);
    expect(() => parseBinding('fn:teleport')).toThrow(/unknown function/);
    expect(() => parseBinding('media:louder')).toThrow(/unknown media key/);
  });
});

describe('lighting text syntax', () => {
  it.each(['off', 'fixed:#00ffff', 'cycle:5000:100', 'breathing:#ff2000:4000:60', 'wave:7000:reverse-horizontal:70', 'pulsar-point:32:100', 'neutron-null:48:30'])('%s round-trips', (t) => {
    expect(formatEffect(parseEffect(t))).toBe(t);
  });

  it('uses G Hub defaults for missing parameters and enforces its slider ranges', () => {
    expect(parseEffect('wave')).toEqual(EFFECT_DEFAULTS.wave);
    expect(() => parseEffect('cycle:500')).toThrow(/1000..20000/);
    expect(() => parseEffect('pulsar-point:16')).toThrow(/32..64/);
  });

  it('places effects in G Hub\'s LED slots and dims like "Dim Active Effect"', () => {
    expect(placeEffect(parseEffect('cycle')).primary.type).toBe('cycle');
    expect(placeEffect(parseEffect('wave')).all.type).toBe('wave');
    expect(dimmed(parseEffect('wave:5000:horizontal:100'), 50)).toMatchObject({ brightness: 50 });
    expect(dimmed(parseEffect('fixed:#00ff80'), 50)).toEqual({ type: 'fixed', color: [0, 128, 64] });
  });
});
