// Request/response layouts for the G502 X PLUS's HID++ 2.0 features (everything except the
// onboard-memory format, which is in onboard.ts). Function numbers are the high nibble of the
// fourth report byte. Every layout here was read off the real mouse; see docs/G502X-PROTOCOL.md.

const u16 = (p: Uint8Array, i: number) => (p[i] << 8) | p[i + 1];
const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const bcd = (b: number) => (b >> 4) * 10 + (b & 0x0f);
const ascii = (p: Uint8Array) => String.fromCharCode(...p.filter((c) => c !== 0));

export const Root = {
  GET_FEATURE: 0,
  PING: 1,
  encodeGetFeature: (id: number) => be16(id),
  /** [index, type, version]; index 0 means the feature is absent. */
  decodeGetFeature: (p: Uint8Array) => ({ index: p[0], type: p[1], version: p[2] }),
  decodePing: (p: Uint8Array) => ({ protocol: `${p[0]}.${p[1]}`, echo: p[2] }),
};

export const FeatureSet = {
  GET_COUNT: 0,
  GET_FEATURE_ID: 1,
  /** Number of features excluding the root. */
  decodeCount: (p: Uint8Array) => p[0],
  decodeFeatureId: (p: Uint8Array) => ({ id: u16(p, 0), type: p[2], version: p[3] }),
};

export const FirmwareInfo = {
  GET_INFO: 0,
  GET_ENTITY: 1,
  /** [entityCount][unitId u32][transport u16][modelId x3 u16][extendedModel][capabilities] */
  decodeInfo: (p: Uint8Array) => ({
    entityCount: p[0],
    unitId: Array.from(p.slice(1, 5), (b) => b.toString(16).padStart(2, '0')).join(''),
    serial: String(((p[1] << 24) >>> 0) + (p[2] << 16) + (p[3] << 8) + p[4]),
    transport: u16(p, 5),
    modelIds: [u16(p, 7), u16(p, 9), u16(p, 11)].filter((m) => m !== 0),
  }),
  /** [type][prefix x3][number BCD][revision BCD][build BCD u16][active][transport pid u16][extra] */
  decodeEntity: (p: Uint8Array) => {
    const TYPES = ['application', 'bootloader', 'hardware', 'touchpad', 'optical-sensor', 'softdevice', 'rf-companion'];
    const prefix = ascii(p.slice(1, 4));
    const number = bcd(p[4]);
    const build = Number(((p[6] << 8) | p[7]).toString(16));
    return {
      type: TYPES[p[0]] ?? `type-${p[0]}`,
      name: `${prefix}${number.toString().padStart(2, '0')}`,
      version: `${number}.${bcd(p[5])}.${build}`,
    };
  },
};

export const DeviceName = {
  GET_LENGTH: 0,
  GET_CHUNK: 1,
  decodeLength: (p: Uint8Array) => p[0],
  decodeChunk: (p: Uint8Array) => ascii(p),
};

/** Feature 0x1004 UnifiedBattery. The same layout is pushed as an event (fn0, swid 0). */
export const UnifiedBattery = {
  GET_CAPABILITIES: 0,
  GET_STATUS: 1,
  LEVELS: { 1: 'critical', 2: 'low', 4: 'good', 8: 'full' } as Record<number, string>,
  STATUS: ['discharging', 'charging', 'almost-full', 'full', 'slow-charging', 'invalid-battery', 'thermal-error'],
  decodeStatus(p: Uint8Array) {
    return {
      percent: p[0],
      level: this.LEVELS[p[1]] ?? 'empty',
      charging: this.STATUS[p[2]] ?? `status-${p[2]}`,
      externalPower: p[3] !== 0,
    };
  },
};

export interface DpiRange {
  min: number;
  max: number;
  step: number;
}

/** Feature 0x2201 AdjustableDpi (version 2). */
export const AdjustableDpi = {
  GET_SENSOR_COUNT: 0,
  GET_DPI_LIST: 1,
  GET_DPI: 2,
  SET_DPI: 3,
  /**
   * [sensor] then big-endian u16 values ending in 0. A value with the top three bits set
   * (0xE000) is a step size that applies between the values on either side of it:
   * 00 64 e0 32 64 00 = 100..25600 in steps of 50.
   */
  decodeDpiList(p: Uint8Array): { ranges: DpiRange[]; values: number[] } {
    const words: number[] = [];
    for (let i = 1; i + 1 < p.length; i += 2) {
      const w = u16(p, i);
      if (w === 0) break;
      words.push(w);
    }
    const ranges: DpiRange[] = [];
    const values: number[] = [];
    for (let i = 0; i < words.length; i++) {
      if ((words[i] & 0xe000) === 0xe000) {
        const step = words[i] & 0x1fff;
        const min = values.pop()!;
        ranges.push({ min, max: words[i + 1], step });
        i++;
      } else {
        values.push(words[i]);
      }
    }
    return { ranges, values };
  },
  /** [sensor][current dpi][default dpi] */
  decodeDpi: (p: Uint8Array) => ({ dpi: u16(p, 1), defaultDpi: u16(p, 3) }),
  /** G Hub also sends the 1-based level so the mouse's DPI indicator shows the right step. */
  encodeSetDpi: (dpi: number, level = 0, sensor = 0) => [sensor, ...be16(dpi), level],
  isValid(dpi: number, list: { ranges: DpiRange[]; values: number[] }): boolean {
    if (list.values.includes(dpi)) return true;
    return list.ranges.some((r) => dpi >= r.min && dpi <= r.max && (dpi - r.min) % r.step === 0);
  },
};

/** Feature 0x8060 ReportRate. Rates are in milliseconds per report. */
export const ReportRate = {
  GET_LIST: 0,
  GET: 1,
  SET: 2,
  /** Bit n set = (n + 1) ms supported. 0x8b = 1, 2, 4, 8 ms = 1000, 500, 250, 125 Hz. */
  decodeList: (p: Uint8Array) => [...Array(8).keys()].filter((b) => p[0] & (1 << b)).map((b) => b + 1),
  decode: (p: Uint8Array) => p[0],
  encodeSet: (ms: number) => [ms],
};

export const msToHz = (ms: number) => Math.round(1000 / ms);
export const hzToMs = (hz: number) => Math.round(1000 / hz);

/** Feature 0x2121 HiResWheel. */
export const HiResWheel = {
  GET_CAPABILITY: 0,
  GET_MODE: 1,
  SET_MODE: 2,
  GET_RATCHET: 3,
  decodeCapability: (p: Uint8Array) => ({ multiplier: p[0], hasInvert: (p[1] & 0x08) !== 0, hasRatchetSwitch: (p[1] & 0x04) !== 0 }),
  /** bit0 = report through HID++ (diverted), bit1 = high resolution, bit2 = inverted. */
  decodeMode: (p: Uint8Array) => ({ diverted: (p[0] & 1) !== 0, highResolution: (p[0] & 2) !== 0, inverted: (p[0] & 4) !== 0 }),
  encodeMode: (m: { diverted?: boolean; highResolution?: boolean; inverted?: boolean }) => [(m.diverted ? 1 : 0) | (m.highResolution ? 2 : 0) | (m.inverted ? 4 : 0)],
  /** 1 = ratchet (clicky), 0 = free spin. The mechanical switch behind the wheel sets this. */
  decodeRatchet: (p: Uint8Array) => ((p[0] & 1) !== 0 ? 'ratchet' : 'free-spin'),
};

/** Feature 0x8110 MouseButtonSpy: G Hub diverts every button to itself in software mode. */
export const MouseButtonSpy = {
  GET_BUTTON_COUNT: 0,
  START_SPY: 1,
  STOP_SPY: 2,
  GET_REMAPPING: 3,
  SET_REMAPPING: 4,
  /** While spying, the mouse sends event 0 on every press and release. */
  BUTTON_EVENT: 0,
  decodeButtonCount: (p: Uint8Array) => p[0],
  /**
   * Event 0: [mask u16 BE] of the controls held down. Bit k is control k in onboard order
   * (G502X_CONTROLS): left 0x0001 ... DPI down 0x0400. Measured on the mouse, in onboard and
   * host mode (docs/evidence/g502x/lab/lab.txt).
   */
  decodeButtons: (p: ArrayLike<number>) => (p[0] << 8) | p[1],
};

/** Feature 0x8100 OnboardProfiles: functions only; the memory layout is in onboard.ts. */
export const OnboardProfiles = {
  GET_DESCRIPTION: 0,
  SET_MODE: 1,
  GET_MODE: 2,
  SET_CURRENT_PROFILE: 3,
  GET_CURRENT_PROFILE: 4,
  MEMORY_READ: 5,
  MEMORY_WRITE_START: 6,
  MEMORY_WRITE: 7,
  MEMORY_WRITE_END: 8,
  GET_CURRENT_DPI_INDEX: 11,
  SET_CURRENT_DPI_INDEX: 12,
  /** 1 = the mouse runs from its onboard profiles; 2 = host (software) mode, which G Hub uses. */
  MODE: { onboard: 1, host: 2 } as const,
  decodeDescription: (p: Uint8Array) => ({
    memoryModel: p[0],
    profileFormat: p[1],
    macroFormat: p[2],
    profileCount: p[3],
    factoryProfileCount: p[4],
    buttonCount: p[5],
    sectorCount: p[6],
    sectorSize: u16(p, 7),
    /** Bits 0-1 = 2: the profiles carry a G-Shift layer (libratbag/Solaar read it the same way). */
    mechanicalLayout: p[9],
    variousInfo: p[10],
    hasGShift: (p[9] & 0x03) === 0x02,
  }),
  decodeMode: (p: Uint8Array) => (p[0] === 1 ? 'onboard' : p[0] === 2 ? 'host' : `mode-${p[0]}`),
  /** Profile number (1-based); 0 while in host mode. */
  decodeCurrentProfile: (p: Uint8Array) => u16(p, 0),
  encodeSetCurrentProfile: (profile: number) => be16(profile),
  encodeRead: (sector: number, offset: number) => [...be16(sector), ...be16(offset)],
  encodeWriteStart: (sector: number, offset: number, length: number) => [...be16(sector), ...be16(offset), ...be16(length)],
};

/**
 * Feature 0x8071 RgbEffects. Clusters on the G502 X PLUS: 0 = the primary zone (fixed, cycle,
 * breathing) and 0xFF = all LEDs (colour wave, the signature animations, stored animations).
 */
export const RgbEffects = {
  GET_INFO: 0,
  SET_EFFECT: 1,
  NV_CONFIG: 3,
  SW_CONTROL: 5,
  SYNC_CORRECTION: 6,
  POWER_CONFIG: 7,
  POWER_MODE: 8,
  ALL_CLUSTERS: 0xff,
  /** getInfo(0xFF, 0xFF): [ff][ff?][clusterCount][...][capabilities u16]. */
  decodeDeviceInfo: (p: Uint8Array) => ({ clusterCount: p[2] }),
  /** getInfo(cluster, 0xFF): [cluster][ff][location u16][effectCount]. */
  decodeClusterInfo: (p: Uint8Array) => ({ cluster: p[0], location: u16(p, 2), effectCount: p[4] }),
  /** getInfo(cluster, effect): [cluster][effect][effectId u16][capabilities u16][period u16]. */
  decodeEffectInfo: (p: Uint8Array) => ({ cluster: p[0], index: p[1], effectId: u16(p, 2), capabilities: u16(p, 4), period: u16(p, 6) }),
  /** setEffect: [cluster][effect index][10 parameter bytes][persistence: 1 = this session only]. */
  encodeSetEffect: (cluster: number, effectIndex: number, params: ArrayLike<number>, persist = 1) => {
    const out = [cluster, effectIndex, ...Array.from({ length: 10 }, (_, i) => params[i] ?? 0), persist];
    return out;
  },
  /** manageSWControl: [1 = set][mode 3 = software][flags: 1 effects, 2 power, 4 NV config]. */
  encodeSwControl: (mode: number, flags: number) => [1, mode, flags],
  /** getPowerConfig reply: [00][00][00][idle s u16][sleep s u16]. */
  decodePowerConfig: (p: Uint8Array) => ({ idleSeconds: u16(p, 3), sleepSeconds: u16(p, 5) }),
  encodeSetPowerConfig: (idleSeconds: number, sleepSeconds: number) => [1, 0, 0, ...be16(idleSeconds), ...be16(sleepSeconds)],
  /** NV config capability 0x0001 = startup animation. Reply [00][cap u16][1 = on, 2 = off]... */
  STARTUP_EFFECT: 0x0001,
  encodeGetNv: (cap: number) => [0, ...be16(cap)],
  encodeSetNv: (cap: number, data: ArrayLike<number>) => [1, ...be16(cap), ...Array.from(data)],
  decodeStartupEffect: (p: Uint8Array) => p[3] === 1,
};

/** Feature 0x8081 PerKeyLighting (v2): direct per-LED colours, the "Freestyle" tab in software mode. */
export const PerKeyLighting = {
  GET_INFO: 0,
  SET_INDIVIDUAL: 1,
  SET_SINGLE_VALUE: 6,
  FRAME_END: 7,
  /** setIndividualRgbZones: up to four [zone, r, g, b] groups per report. */
  encodeSetIndividual: (zones: { zone: number; color: [number, number, number] }[]) => zones.flatMap((z) => [z.zone, ...z.color]),
  /** setRgbZonesSingleValue: [r, g, b] then up to 13 zone ids. */
  encodeSetSingleValue: (color: [number, number, number], zones: number[]) => [...color, ...zones],
  encodeFrameEnd: () => [0, 0, 0, 0, 0],
};
