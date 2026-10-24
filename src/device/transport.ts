import HID from 'node-hid';

export const LOGITECH_VENDOR_ID = 0x046d;
export const A50X_BASE_STATION_PRODUCT_ID = 0x0b0b;
export const A50X_USAGE_PAGE = 0xff32;

/** The minimal byte pipe the A50X client needs; tests substitute a simulated device. */
export interface HidTransport {
  write(report: Uint8Array): void;
  onReport(listener: (report: Uint8Array) => void): () => void;
  close(): void;
}

export interface FoundDevice {
  path: string;
  product?: string;
  usagePage?: number;
}

/**
 * Find the base station's vendor HID interface. Linux (hidraw) and macOS both report the usage
 * page; if a platform does not, fall back to the only interface with the right VID/PID.
 */
export function findA50X(devices: HID.Device[] = HID.devices()): FoundDevice | undefined {
  const ours = devices.filter((d) => d.vendorId === LOGITECH_VENDOR_ID && d.productId === A50X_BASE_STATION_PRODUCT_ID && d.path);
  const vendor = ours.find((d) => d.usagePage === A50X_USAGE_PAGE) ?? (ours.length === 1 ? ours[0] : undefined);
  return vendor ? { path: vendor.path!, product: vendor.product, usagePage: vendor.usagePage } : undefined;
}

export class NodeHidTransport implements HidTransport {
  private readonly listeners = new Set<(report: Uint8Array) => void>();
  private readonly errorListeners = new Set<(err: Error) => void>();
  private readonly device: HID.HID;

  constructor(path: string) {
    // nonExclusive keeps other readers (e.g. G Hub on macOS) working; it is ignored on Linux.
    this.device = new HID.HID(path, { nonExclusive: true });
    this.device.on('data', (data: Buffer) => {
      const report = new Uint8Array(data);
      for (const l of this.listeners) l(report);
    });
    this.device.on('error', (err: Error) => {
      for (const l of this.errorListeners) l(err);
    });
  }

  onError(listener: (err: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  write(report: Uint8Array): void {
    this.device.write(Array.from(report));
  }

  onReport(listener: (report: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.errorListeners.clear();
    this.device.close();
  }
}

export function openA50X(path?: string): NodeHidTransport {
  const found = path ?? findA50X()?.path;
  if (!found) {
    throw new Error(
      'A50 X base station not found (USB 046d:0b0b, usage page 0xFF32). Is it plugged in over USB? On Linux, allow access in the app or install linux/70-libre-hub.rules.',
    );
  }
  return new NodeHidTransport(found);
}
