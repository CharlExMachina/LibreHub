// Linux: the MX Brio's controls through the uvcvideo driver. The standard ones (exposure, white
// balance, zoom, …) are V4L2 controls; Logitech's extension units are reached with uvcvideo's
// UVCIOC_CTRL_QUERY, which sends any request to an extension unit and returns its bytes.
//
// Node has no ioctl(), so it is called through koffi (a prebuilt FFI library). Everything that
// talks to the kernel goes through `Kernel`, so tests can stand in for it.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { MXBRIO_PRODUCT_ID, MXBRIO_VENDOR_ID, type CameraTransport } from './transport.js';
import { AE_MODE, GET_CODES, UvcRequest, decodeField, encodeField, parseVideoControl, unitId, type ControlDef, type GetRequest, type UnitRef, type VideoControlLayout } from './uvc.js';

// ------------------------------------------------------------------ ioctl numbers

const IOC_WRITE = 1;
const IOC_READ = 2;
const ioc = (dir: number, type: string, nr: number, size: number) => ((dir << 30) | (size << 16) | (type.charCodeAt(0) << 8) | nr) >>> 0;

/** struct v4l2_control { __u32 id; __s32 value; } */
export const VIDIOC_G_CTRL = ioc(IOC_READ | IOC_WRITE, 'V', 27, 8);
export const VIDIOC_S_CTRL = ioc(IOC_READ | IOC_WRITE, 'V', 28, 8);
/** struct v4l2_queryctrl: id, type, name[32], minimum, maximum, step, default_value, flags, reserved[2]. */
export const VIDIOC_QUERYCTRL = ioc(IOC_READ | IOC_WRITE, 'V', 36, 68);
/**
 * struct uvc_xu_control_query { __u8 unit; __u8 selector; __u8 query; __u16 size; __u8 *data; }:
 * 16 bytes with 8-byte pointers, 12 with 4-byte ones.
 */
export const xuQuerySize = (pointerBytes: number) => (pointerBytes === 8 ? 16 : 12);
export const uvcIocCtrlQuery = (pointerBytes: number) => ioc(IOC_READ | IOC_WRITE, 'u', 0x21, xuQuerySize(pointerBytes));

/** Pack a struct uvc_xu_control_query around a data buffer's address. */
export function packXuQuery(unit: number, selector: number, query: number, size: number, dataAddress: bigint, pointerBytes = 8): Buffer {
  const b = Buffer.alloc(xuQuerySize(pointerBytes));
  b.writeUInt8(unit, 0);
  b.writeUInt8(selector, 1);
  b.writeUInt8(query, 2);
  b.writeUInt16LE(size, 4);
  if (pointerBytes === 8) b.writeBigUInt64LE(dataAddress, 8);
  else b.writeUInt32LE(Number(dataAddress), 8);
  return b;
}

// ------------------------------------------------------------------ V4L2 control ids

const CID_BASE = 0x00980900;
const CID_CAMERA = 0x009a0900;
/** V4L2 control ids for the camera terminal and processing unit controls, by `unit:selector[:offset]`. */
export const V4L2_CIDS: Record<string, number> = {
  'camera:2': CID_CAMERA + 1, // exposure_auto (a menu)
  'camera:3': CID_CAMERA + 3, // exposure_auto_priority
  'camera:4': CID_CAMERA + 2, // exposure_time_absolute
  'camera:6': CID_CAMERA + 10, // focus_absolute
  'camera:8': CID_CAMERA + 12, // focus_automatic_continuous
  'camera:11': CID_CAMERA + 13, // zoom_absolute
  'camera:13:0': CID_CAMERA + 8, // pan_absolute
  'camera:13:4': CID_CAMERA + 9, // tilt_absolute
  'processing:1': CID_BASE + 28, // backlight_compensation
  'processing:2': CID_BASE + 0, // brightness
  'processing:3': CID_BASE + 1, // contrast
  'processing:4': CID_BASE + 19, // gain
  'processing:5': CID_BASE + 24, // power_line_frequency (a menu; its index is the UVC value)
  'processing:7': CID_BASE + 2, // saturation
  'processing:8': CID_BASE + 27, // sharpness
  'processing:10': CID_BASE + 26, // white_balance_temperature
  'processing:11': CID_BASE + 12, // white_balance_automatic
};
const cidKey = (def: ControlDef) => (def.length > (def.size ?? def.length) ? `${def.unit}:${def.selector}:${def.offset ?? 0}` : `${def.unit}:${def.selector}`);
const EXPOSURE_AUTO = CID_CAMERA + 1;
/** uvcvideo's exposure_auto menu, index → UVC CT_AE_MODE bit (auto, manual, shutter, aperture priority). */
export const EXPOSURE_MENU = [AE_MODE.auto, AE_MODE.manual, AE_MODE.shutterPriority, AE_MODE.aperturePriority];

// ------------------------------------------------------------------ the kernel

export class ErrnoError extends Error {
  constructor(
    readonly errno: number,
    what: string,
  ) {
    super(`${what} failed: ${ERRNO_TEXT[errno] ?? `errno ${errno}`}`);
  }
}
const ERRNO_TEXT: Record<number, string> = {
  1: 'not permitted',
  2: 'no such device',
  5: 'the camera refused the request',
  13: 'permission denied',
  16: 'busy',
  19: 'the camera was disconnected',
  22: 'invalid argument',
  25: 'not a video device',
  32: 'the camera refused the request',
  34: 'value out of range',
  61: 'no data',
  71: 'the camera refused the request',
  110: 'the camera did not answer',
};

/** The two kinds of calls made on the video node. Throws ErrnoError. */
export interface Kernel {
  ioctl(fd: number, request: number, arg: Buffer): void;
  /** UVCIOC_CTRL_QUERY: `data` is sent (SET_CUR) or filled in (GET_*). */
  xuQuery(fd: number, unit: number, selector: number, query: number, data: Uint8Array): void;
}

/** The real kernel, through libc's ioctl() via koffi. */
export function libcKernel(): Kernel {
  const require = createRequire(import.meta.url);
  const koffi = require('koffi');
  const libc = koffi.load('libc.so.6');
  const ioctl = libc.func('int ioctl(int fd, unsigned long request, ...)');
  const pointerBytes = koffi.sizeof('void *');
  const call = (fd: number, request: number, arg: Buffer, what: string) => {
    if (ioctl(fd, request, 'void *', arg) < 0) throw new ErrnoError(koffi.errno(), what);
  };
  return {
    ioctl: (fd, request, arg) => call(fd, request, arg, 'ioctl'),
    xuQuery(fd, unit, selector, query, data) {
      // The kernel reads the data pointer out of the struct, so it must point at memory that
      // doesn't move: koffi.alloc'd, copied in and out.
      const size = data.length;
      const mem = koffi.alloc('uint8_t', Math.max(size, 1));
      try {
        if (query === UvcRequest.SET_CUR) koffi.encode(mem, 'uint8_t', Array.from(data), size);
        call(fd, uvcIocCtrlQuery(pointerBytes), packXuQuery(unit, selector, query, size, koffi.address(mem), pointerBytes), `UVC request ${query.toString(16)} to unit ${unit} selector ${selector}`);
        if (query !== UvcRequest.SET_CUR) data.set(koffi.decode(mem, 'uint8_t', size));
      } finally {
        koffi.free(mem);
      }
    },
  };
}

// ------------------------------------------------------------------ finding the camera

export interface VideoNode {
  path: string;
  /** The USB device's sysfs directory (idVendor, serial, descriptors). */
  usbDir: string;
}

/** The MX Brio's capture node: its /sys/class/video4linux entry with index 0 (1 is its metadata node). */
export function findVideoNode(sys = '/sys/class/video4linux'): VideoNode | undefined {
  let names: string[];
  try {
    names = readdirSync(sys).filter((n) => /^video\d+$/.test(n)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const usbDir = dirname(realpathSync(join(sys, name, 'device')));
      const vid = parseInt(readFileSync(join(usbDir, 'idVendor'), 'utf8'), 16);
      const pid = parseInt(readFileSync(join(usbDir, 'idProduct'), 'utf8'), 16);
      if (vid !== MXBRIO_VENDOR_ID || pid !== MXBRIO_PRODUCT_ID) continue;
      const index = existsSync(join(sys, name, 'index')) ? readFileSync(join(sys, name, 'index'), 'utf8').trim() : '0';
      if (index === '0') return { path: `/dev/${name}`, usbDir };
    } catch {
      // not a USB device, or gone
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ the transport

export class V4l2Camera implements CameraTransport {
  constructor(
    private readonly fd: number,
    readonly layout: VideoControlLayout,
    private readonly kernel: Kernel,
  ) {}

  static open(path: string, kernel: Kernel = libcKernel(), usbDir?: string): V4l2Camera {
    const dir = usbDir ?? findVideoNode()?.usbDir;
    if (!dir) throw new Error('the MX Brio’s USB device is not in sysfs');
    const layout = parseVideoControl(new Uint8Array(readFileSync(join(dir, 'descriptors'))));
    let fd: number;
    try {
      fd = openSync(path, 'r+');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw new Error(`permission denied opening ${path}: add your user to the "video" group, or log in at the computer`);
      throw err;
    }
    return new V4l2Camera(fd, layout, kernel);
  }

  private unit(ref: UnitRef): number {
    const id = unitId(this.layout, ref);
    if (id === undefined) throw new Error(`this camera has no ${ref} unit`);
    return id;
  }

  private xu(code: number, def: ControlDef | { unit: UnitRef; selector: number }, length: number, data: Uint8Array = new Uint8Array(length)): Uint8Array {
    this.kernel.xuQuery(this.fd, this.unit(def.unit), def.selector, code, data);
    return data;
  }

  private cid(def: ControlDef): number {
    const cid = V4L2_CIDS[cidKey(def)];
    if (cid === undefined) throw new Error(`no V4L2 control for ${cidKey(def)}`);
    return cid;
  }

  async read(def: ControlDef, req: GetRequest = 'cur'): Promise<number> {
    if (def.unit !== 'camera' && def.unit !== 'processing') return decodeField(def, this.xu(GET_CODES[req], def, def.length));
    const cid = this.cid(def);
    if (req === 'cur') {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(cid, 0);
      this.kernel.ioctl(this.fd, VIDIOC_G_CTRL, b);
      const v = b.readInt32LE(4);
      return cid === EXPOSURE_AUTO ? menuToAeMode(v) : v;
    }
    const q = Buffer.alloc(68);
    q.writeUInt32LE(cid, 0);
    this.kernel.ioctl(this.fd, VIDIOC_QUERYCTRL, q);
    const field = { min: 40, max: 44, res: 48, def: 52 }[req];
    const v = q.readInt32LE(field);
    if (cid !== EXPOSURE_AUTO) return v;
    if (req === 'def') return menuToAeMode(v);
    throw new Error('exposure_auto has no range');
  }

  async write(def: ControlDef, value: number): Promise<void> {
    if (def.unit !== 'camera' && def.unit !== 'processing') {
      const current = def.length !== (def.size ?? def.length) ? this.xu(UvcRequest.GET_CUR, def, def.length) : new Uint8Array(def.length);
      this.xu(UvcRequest.SET_CUR, def, def.length, encodeField(def, current, value));
      return;
    }
    const cid = this.cid(def);
    const b = Buffer.alloc(8);
    b.writeUInt32LE(cid, 0);
    b.writeInt32LE(cid === EXPOSURE_AUTO ? aeModeToMenu(value) : value, 4);
    this.kernel.ioctl(this.fd, VIDIOC_S_CTRL, b);
  }

  async readBytes(unit: UnitRef, selector: number): Promise<Uint8Array> {
    const len = this.xu(UvcRequest.GET_LEN, { unit, selector }, 2);
    return this.xu(UvcRequest.GET_CUR, { unit, selector }, len[0] | (len[1] << 8));
  }

  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
  }
}

export function menuToAeMode(index: number): number {
  const mode = EXPOSURE_MENU[index];
  if (mode === undefined) throw new Error(`unknown exposure_auto menu entry ${index}`);
  return mode;
}

export function aeModeToMenu(mode: number): number {
  const index = EXPOSURE_MENU.indexOf(mode as (typeof EXPOSURE_MENU)[number]);
  if (index < 0) throw new Error(`unknown auto-exposure mode ${mode}`);
  return index;
}
