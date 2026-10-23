// HID++ framing for Logitech gaming mice behind a Lightspeed receiver (vendor interface,
// usage page 0xFF00). Reports always start with the report id, on macOS and on Linux hidraw.
//
//   short  10 DEV SUB ADDR p0 p1 p2                       (7 bytes)
//   long   11 DEV FIDX FN|SWID p0..p15                    (20 bytes)
//
// DEV is the receiver slot of the mouse (1..6) or 0xFF for the receiver itself.
// HID++ 2.0 replies echo FIDX and FN|SWID; errors are  11 DEV FF FIDX FN|SWID CODE.
// The receiver answers for a sleeping or absent mouse with a HID++ 1.0 error:
//   10 DEV 8F FIDX FN|SWID CODE 00   (CODE 08 = unknown device: the mouse is asleep or off)

export const SHORT_REPORT = 0x10;
export const LONG_REPORT = 0x11;
export const SHORT_LENGTH = 7;
export const LONG_LENGTH = 20;
export const RECEIVER_INDEX = 0xff;
export const PARAMS_PER_LONG = 16;

/** HID++ 2.0 feature error codes (11 DEV FF ... CODE). */
export const Error20 = {
  NO_ERROR: 0x00,
  UNKNOWN: 0x01,
  INVALID_ARGUMENT: 0x02,
  OUT_OF_RANGE: 0x03,
  HARDWARE_ERROR: 0x04,
  LOGITECH_INTERNAL: 0x05,
  INVALID_FEATURE_INDEX: 0x06,
  INVALID_FUNCTION: 0x07,
  BUSY: 0x08,
  UNSUPPORTED: 0x09,
} as const;

/** HID++ 1.0 error codes, sent by the receiver (10 DEV 8F ...). */
export const Error10 = {
  INVALID_SUBID: 0x01,
  INVALID_ADDRESS: 0x02,
  INVALID_VALUE: 0x03,
  CONNECT_FAIL: 0x04,
  TOO_MANY_DEVICES: 0x05,
  ALREADY_EXISTS: 0x06,
  BUSY: 0x07,
  UNKNOWN_DEVICE: 0x08,
  RESOURCE_ERROR: 0x09,
  REQUEST_UNAVAILABLE: 0x0a,
  INVALID_PARAM_VALUE: 0x0b,
  WRONG_PIN_CODE: 0x0c,
} as const;

export const codeName = (table: Record<string, number>, code: number) =>
  Object.entries(table).find(([, v]) => v === code)?.[0] ?? 'UNKNOWN';

export interface Request {
  deviceIndex: number;
  featureIndex: number;
  fn: number;
  swid: number;
  params?: ArrayLike<number>;
}

export function encodeRequest({ deviceIndex, featureIndex, fn, swid, params = [] }: Request): Uint8Array {
  if (fn < 0 || fn > 15) throw new RangeError(`function ${fn} out of range 0..15`);
  if (swid < 0 || swid > 15) throw new RangeError(`software id ${swid} out of range 0..15`);
  if (params.length > PARAMS_PER_LONG) throw new RangeError(`at most ${PARAMS_PER_LONG} parameter bytes, got ${params.length}`);
  const out = new Uint8Array(LONG_LENGTH);
  out[0] = LONG_REPORT;
  out[1] = deviceIndex;
  out[2] = featureIndex;
  out[3] = (fn << 4) | swid;
  for (let i = 0; i < params.length; i++) out[4 + i] = params[i] & 0xff;
  return out;
}

export type Frame =
  /** A HID++ 2.0 reply (swid != 0) or event (swid 0). */
  | { kind: 'message'; deviceIndex: number; featureIndex: number; fn: number; swid: number; params: Uint8Array }
  /** A HID++ 2.0 feature error. */
  | { kind: 'error'; deviceIndex: number; featureIndex: number; fn: number; swid: number; code: number }
  /** A HID++ 1.0 error from the receiver about a request to `deviceIndex`. */
  | { kind: 'receiverError'; deviceIndex: number; featureIndex: number; fn: number; swid: number; code: number }
  /** A HID++ 1.0 notification (0x40 disconnect, 0x41 connect, receiver register traffic, ...). */
  | { kind: 'notification'; deviceIndex: number; subId: number; params: Uint8Array };

export function decodeFrame(report: Uint8Array): Frame | undefined {
  const id = report[0];
  if (id === SHORT_REPORT && report.length < SHORT_LENGTH) return undefined;
  if (id === LONG_REPORT && report.length < LONG_LENGTH) return undefined;
  if (id !== SHORT_REPORT && id !== LONG_REPORT) return undefined;
  const deviceIndex = report[1];
  const sub = report[2];
  if (sub === 0x8f) {
    return { kind: 'receiverError', deviceIndex, featureIndex: report[3], fn: report[4] >> 4, swid: report[4] & 0x0f, code: report[5] };
  }
  if (sub === 0xff) {
    return { kind: 'error', deviceIndex, featureIndex: report[3], fn: report[4] >> 4, swid: report[4] & 0x0f, code: report[5] };
  }
  // Feature indexes are small (32 features on the G502 X PLUS); HID++ 1.0 notifications and
  // receiver register replies use 0x40 and up. A mouse on its cable talks as device 0xFF.
  if (sub >= 0x40) {
    return { kind: 'notification', deviceIndex, subId: sub, params: report.slice(3) };
  }
  return { kind: 'message', deviceIndex, featureIndex: sub, fn: report[3] >> 4, swid: report[3] & 0x0f, params: report.slice(4) };
}

/** 0x41 "device connection" notification from the receiver: link state and wireless PID. */
export function decodeConnection(params: Uint8Array) {
  // params: [protocol, flags, wpid lo, wpid hi]; flags bit 6 set = link NOT established.
  return { protocol: params[0], linkEstablished: (params[1] & 0x40) === 0, deviceType: params[1] & 0x0f, wirelessPid: params[2] | (params[3] << 8) };
}

export const toHex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

export const fromHex = (hex: string) =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16)),
  );
