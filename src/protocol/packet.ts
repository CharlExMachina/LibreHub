// Framing for the A50 X base station's vendor HID interface (usage page 0xFF32, usage 0x74).
//
// Every packet is a 64-byte HID report with report ID 0x02:
//
//   02 0c LEN | DEV IDX FNSW params... | zero padding
//
//   LEN   number of bytes that follow (DEV + IDX + FNSW + params)
//   DEV   device/route byte; always 0x00 in all observed traffic
//   IDX   feature index (resolved through the Root feature)
//   FNSW  (function << 4) | software id. Requests pick a swid of 1..15;
//         responses echo it; unsolicited events use swid 0.
//
// Errors come back as  02 0c 05 | DEV ff IDX FNSW CODE.
// The 0x0c byte is constant in all observed traffic; its meaning is unknown.

export const REPORT_ID = 0x02;
export const CHANNEL = 0x0c;
export const REPORT_SIZE = 64;
export const HEADER_SIZE = 3; // REPORT_ID, CHANNEL, LEN
export const MAX_PARAMS = REPORT_SIZE - HEADER_SIZE - 3;
export const ERROR_INDEX = 0xff;

/** Error codes as observed on firmware 1.2.18 (meanings inferred from the requests that produced them). */
export const ErrorCode = {
  UNKNOWN_FUNCTION: 0x02,
  BAD_LENGTH: 0x03,
  INVALID_ARGUMENT: 0x05,
  OUT_OF_RANGE: 0x0b,
} as const;

export interface Request {
  featureIndex: number;
  fn: number;
  swid: number;
  params?: ArrayLike<number>;
  device?: number;
}

export type Frame =
  | { kind: 'message'; device: number; featureIndex: number; fn: number; swid: number; params: Uint8Array }
  | { kind: 'error'; device: number; featureIndex: number; fn: number; swid: number; code: number };

export function encodeRequest({ featureIndex, fn, swid, params = [], device = 0 }: Request): Uint8Array {
  if (fn < 0 || fn > 0x0f) throw new RangeError(`function ${fn} out of range 0..15`);
  if (swid < 0 || swid > 0x0f) throw new RangeError(`software id ${swid} out of range 0..15`);
  if (params.length > MAX_PARAMS) throw new RangeError(`${params.length} parameter bytes exceed ${MAX_PARAMS}`);
  const report = new Uint8Array(REPORT_SIZE);
  report[0] = REPORT_ID;
  report[1] = CHANNEL;
  report[2] = 3 + params.length;
  report[3] = device;
  report[4] = featureIndex;
  report[5] = (fn << 4) | swid;
  report.set(Array.from(params), 6);
  return report;
}

/** Decode one input report. Returns undefined for reports that are not Centurion frames. */
export function decodeFrame(report: ArrayLike<number>): Frame | undefined {
  if (report.length < 6 || report[0] !== REPORT_ID || report[1] !== CHANNEL) return undefined;
  const len = report[2];
  if (len < 3 || HEADER_SIZE + len > report.length) return undefined;
  const body = Uint8Array.from(Array.from(report).slice(HEADER_SIZE, HEADER_SIZE + len));
  const device = body[0];
  if (body[1] === ERROR_INDEX && len >= 5) {
    return { kind: 'error', device, featureIndex: body[2], fn: body[3] >> 4, swid: body[3] & 0x0f, code: body[4] };
  }
  return { kind: 'message', device, featureIndex: body[1], fn: body[2] >> 4, swid: body[2] & 0x0f, params: body.slice(3) };
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function fromHex(hex: string): Uint8Array {
  const parts = hex.trim().split(/\s+/).filter(Boolean);
  return Uint8Array.from(parts.map((p) => {
    const v = Number.parseInt(p, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xff) throw new Error(`bad hex byte "${p}"`);
    return v;
  }));
}
