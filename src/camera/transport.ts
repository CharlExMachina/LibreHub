// How the MX Brio's controls are reached on each system. The camera speaks plain UVC control
// requests; what differs is who may send them:
//
// - macOS: anyone, through the USB device's default pipe, even while another program (G Hub,
//   LogiRightSight, a video call) has the camera. This is what G Hub does. We use libusb (`usb`).
// - Linux: the uvcvideo driver owns the Video Control interface, and usbfs refuses class requests
//   to an interface it doesn't own. So the standard controls go through V4L2 (VIDIOC_S_CTRL) and
//   Logitech's extension units through uvcvideo's UVCIOC_CTRL_QUERY (src/camera/v4l2.ts).
//
// Both give the client the same thing: a number per control, read or written.

import { GET_CODES, UvcRequest, decodeField, encodeField, parseVideoControl, unitId, type ControlDef, type GetRequest, type UnitRef, type VideoControlLayout } from './uvc.js';

export const MXBRIO_VENDOR_ID = 0x046d;
export const MXBRIO_PRODUCT_ID = 0x0944;

/** What the client needs from a camera connection; tests substitute a simulated one. */
export interface CameraTransport {
  readonly layout: VideoControlLayout;
  /** A control's value (GET_CUR, or its GET_MIN/MAX/RES/DEF). */
  read(def: ControlDef, req?: GetRequest): Promise<number>;
  write(def: ControlDef, value: number): Promise<void>;
  /** A whole extension-unit control's bytes (firmware version, serial number). */
  readBytes(unit: UnitRef, selector: number): Promise<Uint8Array>;
  close(): void;
}

/** The raw requests a USB connection can send: what the simulator and libusb both provide. */
export interface RawUvc {
  get(code: number, unit: number, selector: number, length: number): Promise<Uint8Array>;
  set(unit: number, selector: number, data: Uint8Array): Promise<void>;
  /** GET_DESCRIPTOR(CONFIGURATION), whole. */
  configDescriptor(): Promise<Uint8Array>;
  close(): void;
}

/** A camera whose control requests we send ourselves (macOS, and the simulator). */
export class RawCameraTransport implements CameraTransport {
  private constructor(
    private readonly raw: RawUvc,
    readonly layout: VideoControlLayout,
  ) {}

  static async open(raw: RawUvc): Promise<RawCameraTransport> {
    try {
      return new RawCameraTransport(raw, parseVideoControl(await raw.configDescriptor()));
    } catch (err) {
      raw.close();
      throw err;
    }
  }

  private unit(ref: UnitRef): number {
    const id = unitId(this.layout, ref);
    if (id === undefined) throw new Error(`this camera has no ${ref} unit`);
    return id;
  }

  async read(def: ControlDef, req: GetRequest = 'cur'): Promise<number> {
    return decodeField(def, await this.raw.get(GET_CODES[req], this.unit(def.unit), def.selector, def.length));
  }

  async write(def: ControlDef, value: number): Promise<void> {
    // A field of a wider control (tilt in pan/tilt): keep the other fields as they are.
    const current = def.length !== (def.size ?? def.length) ? await this.raw.get(UvcRequest.GET_CUR, this.unit(def.unit), def.selector, def.length) : new Uint8Array(def.length);
    await this.raw.set(this.unit(def.unit), def.selector, encodeField(def, current, value));
  }

  async readBytes(unit: UnitRef, selector: number): Promise<Uint8Array> {
    const id = this.unit(unit);
    const len = await this.raw.get(UvcRequest.GET_LEN, id, selector, 2);
    return this.raw.get(UvcRequest.GET_CUR, id, selector, len[0] | (len[1] << 8));
  }

  close(): void {
    this.raw.close();
  }
}

// ------------------------------------------------------------------ macOS: libusb

/** Type of the bits of `usb` (node-usb 2.x) used here; it is only loaded on macOS. */
interface UsbDevice {
  open(): void;
  close(): void;
  interfaces?: unknown[];
  controlTransfer(type: number, request: number, value: number, index: number, dataOrLength: number | Buffer, cb: (err: Error | undefined, data?: Buffer | number) => void): void;
}

export class LibusbUvc implements RawUvc {
  private interfaceNumber = 0;
  constructor(private readonly device: UsbDevice) {}

  private transfer(type: number, request: number, value: number, index: number, data: number | Buffer): Promise<Buffer | number | undefined> {
    return new Promise((resolve, reject) =>
      this.device.controlTransfer(type, request, value, index, data, (err, out) => (err ? reject(usbError(err)) : resolve(out))),
    );
  }

  async get(code: number, unit: number, selector: number, length: number): Promise<Uint8Array> {
    const out = await this.transfer(0xa1, code, selector << 8, (unit << 8) | this.interfaceNumber, length);
    return new Uint8Array(out as Buffer);
  }

  async set(unit: number, selector: number, data: Uint8Array): Promise<void> {
    await this.transfer(0x21, UvcRequest.SET_CUR, selector << 8, (unit << 8) | this.interfaceNumber, Buffer.from(data));
  }

  async configDescriptor(): Promise<Uint8Array> {
    // The 9-byte header says how long the whole thing is.
    const head = (await this.transfer(0x80, 0x06, 0x0200, 0, 9)) as Buffer;
    const total = head.readUInt16LE(2);
    const desc = new Uint8Array((await this.transfer(0x80, 0x06, 0x0200, 0, total)) as Buffer);
    this.interfaceNumber = parseVideoControl(desc).interfaceNumber;
    return desc;
  }

  close(): void {
    try {
      this.device.close();
    } catch {
      // already gone
    }
  }
}

/** libusb's "pipe error" is the camera rejecting a request (a STALL), which UVC uses for "no". */
function usbError(err: Error): Error {
  const msg = err.message || String(err);
  if (/STALL|PIPE/i.test(msg)) return new Error('the camera refused the request');
  if (/NO_DEVICE|disconnect/i.test(msg)) return new Error('the camera was disconnected');
  return err;
}

async function loadUsb(): Promise<{ findByIds(vid: number, pid: number): UsbDevice | undefined }> {
  // A CommonJS package with a native part: loaded on first use, and only where it is needed.
  const mod = (await import('usb')) as unknown as { default?: unknown; findByIds?: unknown };
  return (mod.findByIds ? mod : mod.default) as { findByIds(vid: number, pid: number): UsbDevice | undefined };
}

// ------------------------------------------------------------------ finding and opening

/** Where the camera is, before it is opened: a USB device on macOS, a /dev/video node on Linux. */
export interface FoundCamera {
  kind: 'usb' | 'v4l2';
  /** The video node on Linux. */
  path?: string;
}

export async function findCamera(): Promise<FoundCamera | undefined> {
  if (process.platform === 'linux') {
    const { findVideoNode } = await import('./v4l2.js');
    const node = findVideoNode();
    return node ? { kind: 'v4l2', path: node.path } : undefined;
  }
  const usb = await loadUsb();
  return usb.findByIds(MXBRIO_VENDOR_ID, MXBRIO_PRODUCT_ID) ? { kind: 'usb' } : undefined;
}

export async function openCamera(found?: FoundCamera): Promise<CameraTransport> {
  const where = found ?? (await findCamera());
  if (!where) throw new Error('No MX Brio found (USB 046d:0944). Is it plugged in?');
  if (where.kind === 'v4l2') {
    const { V4l2Camera } = await import('./v4l2.js');
    return V4l2Camera.open(where.path!);
  }
  const usb = await loadUsb();
  const device = usb.findByIds(MXBRIO_VENDOR_ID, MXBRIO_PRODUCT_ID);
  if (!device) throw new Error('The MX Brio went away.');
  // On macOS libusb can't take the device from the system's camera driver, and doesn't need to:
  // control requests go through the default pipe either way.
  try {
    device.open();
  } catch {
    // opened without exclusive access; control requests still work
  }
  return RawCameraTransport.open(new LibusbUvc(device));
}

