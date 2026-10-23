import HID from 'node-hid';
import { LOGITECH_VENDOR_ID, NodeHidTransport, type FoundDevice } from '../device/transport.js';

/** Lightspeed receivers. The G502 X PLUS ships with 046d:c547. */
export const LIGHTSPEED_RECEIVERS = [0xc539, 0xc53a, 0xc53f, 0xc541, 0xc545, 0xc547, 0xc54d];
export const HIDPP_USAGE_PAGE = 0xff00;
/** The G502 X PLUS's own USB product id when it is plugged in with its cable. */
export const G502X_WIRED_PRODUCT_ID = 0xc095;
export const G502X_WIRELESS_PID = 0x4099;

/**
 * Find the receiver's HID++ interface (usage page 0xFF00; usage 1 = short, 2 = long reports).
 * Both usages live on one interface, so either path works; prefer the long one. hidraw on Linux
 * may not report usages, so fall back to interface 2, where Logitech receivers put HID++.
 */
export function findReceiver(devices: HID.Device[] = HID.devices()): FoundDevice | undefined {
  const ours = devices.filter(
    (d) => d.vendorId === LOGITECH_VENDOR_ID && (LIGHTSPEED_RECEIVERS.includes(d.productId) || d.productId === G502X_WIRED_PRODUCT_ID) && d.path,
  );
  const hidpp =
    ours.find((d) => d.usagePage === HIDPP_USAGE_PAGE && d.usage === 2) ??
    ours.find((d) => d.usagePage === HIDPP_USAGE_PAGE) ??
    ours.find((d) => d.interface === 2);
  return hidpp ? { path: hidpp.path!, product: hidpp.product, usagePage: hidpp.usagePage } : undefined;
}

export function openReceiver(path?: string): NodeHidTransport {
  const found = path ?? findReceiver()?.path;
  if (!found) {
    throw new Error(
      'No Logitech Lightspeed receiver found (USB 046d:c547, HID++ interface on usage page 0xFF00). Is the receiver plugged in? On Linux, install linux/70-logitech-g502x.rules.',
    );
  }
  return new NodeHidTransport(found);
}
