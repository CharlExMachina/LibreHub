// USB Video Class plumbing for the MX Brio: request codes, the units in its Video Control
// interface, and the controls G Hub drives, by unit and selector. See docs/MXBRIO-PROTOCOL.md.
//
// The camera's units are found by what they are, never by a hardcoded id: the camera terminal and
// the processing unit by their descriptor subtype, Logitech's extension units by GUID. G Hub does
// the same (its UVC library looks each unit up by GUID).

/** UVC 1.5 §A.8: class-specific request codes. */
export const UvcRequest = {
  SET_CUR: 0x01,
  GET_CUR: 0x81,
  GET_MIN: 0x82,
  GET_MAX: 0x83,
  GET_RES: 0x84,
  GET_LEN: 0x85,
  GET_INFO: 0x86,
  GET_DEF: 0x87,
} as const;

export type GetRequest = 'cur' | 'min' | 'max' | 'res' | 'def';
export const GET_CODES: Record<GetRequest, number> = {
  cur: UvcRequest.GET_CUR,
  min: UvcRequest.GET_MIN,
  max: UvcRequest.GET_MAX,
  res: UvcRequest.GET_RES,
  def: UvcRequest.GET_DEF,
};

/** Logitech's extension units, by the names G Hub's agent logs for them. */
export const LOGITECH_XU = {
  /** "Video Pipe Unit": field of view, Show Mode, tint, vibrance and the other image extras. */
  videoPipe: '49e40215-f434-47fe-b158-0e885023e51b',
  /** "Peripheral Unit": the microphone switch, and a copy of pan/tilt. */
  peripheral: 'ffe52d21-8030-4e2c-82d9-f587d00540bd',
  /** "Device Info Unit": firmware version, serial number. */
  deviceInfo: '69678ee4-410f-40db-a850-7420d7d8240e',
} as const;
export type LogitechUnit = keyof typeof LOGITECH_XU;

/** Where a unit lives: the camera terminal, the processing unit, or an extension unit. */
export type UnitRef = 'camera' | 'processing' | LogitechUnit;

export interface VideoControlLayout {
  /** bInterfaceNumber of the Video Control interface (the wIndex low byte of every request). */
  interfaceNumber: number;
  camera: number;
  processing: number;
  /** Extension unit ids by GUID (lower case, dashed, as printed by Windows and G Hub). */
  extensions: Record<string, number>;
}

/** A GUID as it sits in a USB descriptor (the first three fields little-endian), as text. */
export function guidFromBytes(b: Uint8Array): string {
  const h = (i: number, n: number, rev: boolean) => {
    const bytes = Array.from(b.subarray(i, i + n));
    return (rev ? bytes.reverse() : bytes).map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  return `${h(0, 4, true)}-${h(4, 2, true)}-${h(6, 2, true)}-${h(8, 2, false)}-${h(10, 6, false)}`;
}

/**
 * Find the Video Control interface and its units in a configuration descriptor (the bytes of
 * GET_DESCRIPTOR(CONFIGURATION), or Linux's sysfs `descriptors`, which starts with the 18-byte
 * device descriptor: pass that too, it is skipped).
 */
export function parseVideoControl(desc: Uint8Array): VideoControlLayout {
  let i = 0;
  let inVideoControl = false;
  let found: VideoControlLayout | undefined;
  while (i + 2 <= desc.length) {
    const len = desc[i];
    const type = desc[i + 1];
    if (len < 2 || i + len > desc.length) break;
    const d = desc.subarray(i, i + len);
    if (type === 0x04) {
      // Interface: class 14 (video), subclass 1 (control).
      inVideoControl = d[5] === 0x0e && d[6] === 0x01;
      if (inVideoControl && !found) found = { interfaceNumber: d[2], camera: 0, processing: 0, extensions: {} };
      else if (inVideoControl) inVideoControl = false; // only the first video function
    } else if (type === 0x24 && inVideoControl && found) {
      const subtype = d[2];
      if (subtype === 0x02 && (d[4] | (d[5] << 8)) === 0x0201) found.camera = d[3];
      else if (subtype === 0x05) found.processing = d[3];
      else if (subtype === 0x06 && len >= 20) found.extensions[guidFromBytes(d.subarray(4, 20))] = d[3];
    }
    i += len;
  }
  if (!found) throw new Error('no USB Video Control interface in the descriptor');
  if (!found.camera || !found.processing) throw new Error('the camera has no camera terminal or processing unit');
  return found;
}

/** Unit id for a reference, or undefined when this camera has no such unit. */
export function unitId(layout: VideoControlLayout, unit: UnitRef): number | undefined {
  if (unit === 'camera') return layout.camera;
  if (unit === 'processing') return layout.processing;
  return layout.extensions[LOGITECH_XU[unit]];
}

/**
 * A control G Hub sets on the MX Brio. `offset`/`size` pick a field out of a wider control:
 * pan and tilt share one 8-byte control (UVC CT_PANTILT_ABSOLUTE).
 */
export interface ControlDef {
  unit: UnitRef;
  selector: number;
  /** The whole control's length in bytes. */
  length: number;
  offset?: number;
  size?: number;
  signed?: boolean;
}

/** Every control the MX Brio's settings map to, by our name. Evidence: docs/evidence/mx-brio/uvc/ghub-set-diffs.txt. */
export const CONTROLS = {
  // Camera terminal (UVC 1.5 §4.2.2.1)
  aeMode: { unit: 'camera', selector: 0x02, length: 1 },
  aePriority: { unit: 'camera', selector: 0x03, length: 1 },
  exposureTime: { unit: 'camera', selector: 0x04, length: 4 },
  focus: { unit: 'camera', selector: 0x06, length: 2 },
  focusAuto: { unit: 'camera', selector: 0x08, length: 1 },
  zoom: { unit: 'camera', selector: 0x0b, length: 2 },
  pan: { unit: 'camera', selector: 0x0d, length: 8, offset: 0, size: 4, signed: true },
  tilt: { unit: 'camera', selector: 0x0d, length: 8, offset: 4, size: 4, signed: true },
  // Processing unit (UVC 1.5 §4.2.2.3)
  backlightCompensation: { unit: 'processing', selector: 0x01, length: 2 },
  brightness: { unit: 'processing', selector: 0x02, length: 2, signed: true },
  contrast: { unit: 'processing', selector: 0x03, length: 2 },
  gain: { unit: 'processing', selector: 0x04, length: 2 },
  powerLineFrequency: { unit: 'processing', selector: 0x05, length: 1 },
  saturation: { unit: 'processing', selector: 0x07, length: 2 },
  sharpness: { unit: 'processing', selector: 0x08, length: 2 },
  whiteBalance: { unit: 'processing', selector: 0x0a, length: 2 },
  whiteBalanceAuto: { unit: 'processing', selector: 0x0b, length: 1 },
  // Logitech video pipe extension unit
  fov: { unit: 'videoPipe', selector: 5, length: 1 },
  showMode: { unit: 'videoPipe', selector: 13, length: 1 },
  tint: { unit: 'videoPipe', selector: 18, length: 1 },
  exposureCompensation: { unit: 'videoPipe', selector: 19, length: 1 },
  vibrance: { unit: 'videoPipe', selector: 20, length: 1 },
  temperatureCompensation: { unit: 'videoPipe', selector: 21, length: 1 },
  // Logitech peripheral extension unit
  microphone: { unit: 'peripheral', selector: 16, length: 1 },
} as const satisfies Record<string, ControlDef>;

export type ControlName = keyof typeof CONTROLS;

/** Read a control's field out of its bytes. */
export function decodeField(def: ControlDef, bytes: Uint8Array): number {
  const offset = def.offset ?? 0;
  const size = def.size ?? def.length;
  if (bytes.length < offset + size) throw new Error(`short reply: ${bytes.length} bytes, needed ${offset + size}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, size);
  switch (size) {
    case 1:
      return def.signed ? view.getInt8(0) : view.getUint8(0);
    case 2:
      return def.signed ? view.getInt16(0, true) : view.getUint16(0, true);
    case 4:
      return def.signed ? view.getInt32(0, true) : view.getUint32(0, true);
    default:
      throw new Error(`no ${size}-byte integer field`);
  }
}

/** Write a field into a control's bytes (a copy; the others fields are kept). */
export function encodeField(def: ControlDef, bytes: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(def.length);
  out.set(bytes.subarray(0, def.length));
  const offset = def.offset ?? 0;
  const size = def.size ?? def.length;
  const view = new DataView(out.buffer, offset, size);
  if (!Number.isInteger(value)) throw new Error(`not a whole number: ${value}`);
  switch (size) {
    case 1:
      if (def.signed) view.setInt8(0, value);
      else view.setUint8(0, value);
      break;
    case 2:
      if (def.signed) view.setInt16(0, value, true);
      else view.setUint16(0, value, true);
      break;
    case 4:
      if (def.signed) view.setInt32(0, value, true);
      else view.setUint32(0, value, true);
      break;
    default:
      throw new Error(`no ${size}-byte integer field`);
  }
  return out;
}

/** UVC CT_AE_MODE values (a bitmap in GET_RES): manual, and the camera's own auto exposure. */
export const AE_MODE = { manual: 0x01, auto: 0x02, shutterPriority: 0x04, aperturePriority: 0x08 } as const;

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (s: string) => Uint8Array.from((s.replace(/\s+/g, '').match(/../g) ?? []).map((h) => parseInt(h, 16)));
