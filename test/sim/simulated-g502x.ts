// A fake Lightspeed receiver with a G502 X PLUS behind it, built from the layouts captured from the
// real mouse (test/fixtures). It behaves like the firmware in the ways that matter to the client:
// receiver pairing register, HID++ 1.0 "unknown device" while asleep, the 32-entry feature table,
// onboard memory that erases on write start and rejects a bad CRC at write end, read-only factory
// sectors, and profile/DPI state that follows the active onboard profile. It also reports button
// presses while MouseButtonSpy runs, takes per-LED frames, and can switch profile or wake up the
// way the real mouse announces it.

import type { HidTransport } from '../../src/device/transport.js';
import { fromHex } from '../../src/mouse/hidpp.js';
import { crc16, decodeDirectory, decodeProfile } from '../../src/mouse/onboard.js';
import { SECTORS } from '../fixtures/g502x-sectors.js';

/** The feature table the real mouse reports (index = position). */
export const FEATURE_TABLE = [
  0x0000, 0x0001, 0x0003, 0x0005, 0x1d4b, 0x0020, 0x1004, 0x2201, 0x2121, 0x8071, 0x8081, 0x8100, 0x8110, 0x8060, 0x1500, 0x00d0,
  0x1802, 0x1803, 0x1806, 0x1811, 0x1805, 0x1830, 0x1875, 0x1861, 0x1890, 0x18a1, 0x1801, 0x1e00, 0x1e22, 0x1eb0, 0x18b1, 0x18c0,
];
const VERSIONS: Record<number, number> = { 0x0001: 2, 0x0003: 4, 0x1004: 3, 0x2201: 2, 0x8071: 2, 0x8081: 2, 0x00d0: 3 };
const idx = (id: number) => FEATURE_TABLE.indexOf(id);

const SECTOR_SIZE = 255;
const SECTOR_COUNT = 16;

export class SimulatedG502X implements HidTransport {
  private listeners = new Set<(r: Uint8Array) => void>();
  readonly written: Uint8Array[] = [];
  /** Replies the receiver sends as "unknown device" before the mouse answers again. */
  asleepFor = 0;
  /** Called for every request to the mouse before it is answered (tests use it to inject faults). */
  onRequest?: (featureId: number, fn: number) => void;
  /** Delay the next reply by this many ms; later replies queue behind it (the receiver is FIFO). */
  delayNextReplyMs = 0;
  private outbox: Promise<void> = Promise.resolve();
  readonly flash = new Map<number, Uint8Array>();
  mode = 2; // host
  activeProfile = 0;
  dpiIndex = 1;
  dpi = 1600;
  reportRateMs = 1;
  startupEffect = 2; // off
  wheelMode = 0;
  swControl = [0, 0];
  readonly effects: number[][] = [];
  spying = false;
  /** Per-LED frames received (LED number → [r, g, b]), one per frame end. */
  readonly ledFrames: Record<number, number[]>[] = [];
  private ledPending: Record<number, number[]> = {};
  private pendingWrite?: { sector: number; length: number; data: number[] };

  constructor() {
    this.flash.set(0, fromHex(SECTORS.directory));
    for (let k = 1; k <= 5; k++) this.flash.set(k, fromHex(SECTORS[`profile${k}` as 'profile1']));
    for (let s = 6; s < SECTOR_COUNT; s++) this.flash.set(s, new Uint8Array(SECTOR_SIZE).fill(0xff));
    this.flash.set(0x0100, Uint8Array.from([0x01, 0x01, 0x01, 0xff, 0x01, 0x02, 0x01, 0xff, ...new Array(SECTOR_SIZE - 8).fill(0xff)]));
    this.flash.set(0x0101, fromHex(SECTORS.romProfile1));
    this.flash.set(0x0102, fromHex(SECTORS.romProfile2));
  }

  onReport(listener: (r: Uint8Array) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.listeners.clear();
  }

  /** Hold down exactly these controls (bit k = control k in onboard order). Reported only while spying. */
  buttons(mask: number): void {
    if (this.spying) this.send([0x11, 0x01, idx(0x8110), 0x00, mask >> 8, mask & 0xff]);
  }

  /** Press and release controls. */
  press(mask: number): void {
    this.buttons(mask);
    this.buttons(0);
  }

  /** The profile button: next enabled profile, announced like the mouse does (0x8100 event 0). */
  cycleProfile(): void {
    const dir = decodeDirectory(this.flash.get(0)!);
    let n = this.activeProfile;
    do n = (n % dir.length) + 1;
    while (!dir[n - 1].enabled);
    this.activate(n);
    this.send([0x11, 0x01, idx(0x8100), 0x00, 0x00, n]);
  }

  /** The mouse went to sleep and woke up again: the spy stops and the LEDs return to the profile. */
  sleepAndWake(): void {
    this.spying = false;
    this.swControl = [0, 0];
    this.send([0x10, 0x01, 0x41, 0x11, 0x72, 0x99, 0x40]);
    this.send([0x10, 0x01, 0x41, 0x11, 0x32, 0x99, 0x40]);
  }

  private send(bytes: number[]) {
    const out = new Uint8Array(bytes[0] === 0x10 ? 7 : 20);
    out.set(bytes.slice(0, out.length));
    const deliver = () => {
      for (const l of this.listeners) l(out);
    };
    // Strictly in order, like the receiver: a delayed reply holds back everything after it.
    // (Separate timers that come due in the same millisecond may fire in either order.)
    const at = Date.now() + this.delayNextReplyMs;
    this.delayNextReplyMs = 0;
    this.outbox = this.outbox
      .then(() => {
        const wait = at - Date.now();
        return wait > 0 ? new Promise<void>((r) => setTimeout(r, wait)) : undefined;
      })
      .then(deliver);
  }

  write(report: Uint8Array): void {
    const r = Array.from(report);
    this.written.push(report);
    const [id, dev, sub, addr] = r;
    if (dev === 0xff && id === 0x10 && sub === 0x83) {
      // receiver register read; 0xB5 0x20 = pairing information for slot 1
      if (addr === 0xb5 && r[4] === 0x20) return this.send([0x11, 0xff, 0x83, 0xb5, 0x20, 0x07, 0x08, 0x40, 0x99, 0x11, 0x00, 0x02, 0xb1]);
      return this.send([0x10, 0xff, 0x8f, 0x83, addr, 0x09, 0x00]);
    }
    if (id !== 0x11) return;
    if (dev !== 1) return this.send([0x10, dev, 0x8f, sub, addr, 0x08, 0x00]);
    this.onRequest?.(FEATURE_TABLE[sub], addr >> 4);
    if (this.asleepFor > 0) {
      this.asleepFor--;
      return this.send([0x10, dev, 0x8f, sub, addr, 0x08, 0x00]);
    }
    const fn = addr >> 4;
    const p = r.slice(4);
    const ok = (params: number[] = []) => this.send([0x11, dev, sub, addr, ...params]);
    const err = (code: number) => this.send([0x11, dev, 0xff, sub, addr, code]);
    const id16 = FEATURE_TABLE[sub];
    if (id16 === undefined) return err(0x06);
    try {
      const reply = this.handle(id16, fn, p);
      if (typeof reply === 'number') err(reply);
      else ok(reply);
    } catch {
      err(0x05);
    }
  }

  private profileOf(n: number) {
    return decodeProfile(this.flash.get(decodeDirectory(this.flash.get(0)!)[n - 1].sector)!);
  }

  private activate(n: number) {
    this.activeProfile = n;
    const p = this.profileOf(n);
    this.dpiIndex = p.defaultDpiIndex;
    this.dpi = p.dpiLevels[p.defaultDpiIndex];
    this.reportRateMs = p.reportRateMs;
  }

  /** Returns reply params, or an error code. */
  private handle(feature: number, fn: number, p: number[]): number[] | number {
    switch (feature) {
      case 0x0000:
        if (fn === 0) {
          const i = idx((p[0] << 8) | p[1]);
          return i < 0 ? [0, 0, 0] : [i, 0, VERSIONS[FEATURE_TABLE[i]] ?? 0];
        }
        if (fn === 1) return [4, 2, p[2]];
        return 0x07;
      case 0x0001:
        if (fn === 0) return [FEATURE_TABLE.length - 1];
        if (fn === 1) {
          const f = FEATURE_TABLE[p[0]];
          return f === undefined ? 0x02 : [f >> 8, f & 0xff, p[0] >= 16 ? 0x70 : 0, VERSIONS[f] ?? 0];
        }
        return 0x07;
      case 0x0003:
        if (fn === 0) return Array.from(fromHex('0c 49 96 02 d2 00 0c 40 99 c0 95 00 00 00 01'));
        if (fn === 1) return p[0] === 0 ? Array.from(fromHex('01 42 4c 31 42 00 00 16 00 ab 0b fb b1 3a 33')) : Array.from(fromHex('00 4d 50 4d 27 00 00 16 01 40 99 fb b1 3a 33'));
        return 0x07;
      case 0x0005: {
        const name = 'G502 X PLUS';
        if (fn === 0) return [name.length];
        if (fn === 1) return [...name.slice(p[0], p[0] + 16)].map((c) => c.charCodeAt(0));
        return 0x07;
      }
      case 0x1004:
        if (fn === 0) return [0x0f, 0x0f, 0x01];
        if (fn === 1) return [36, 4, 0, 0];
        return 0x07;
      case 0x2201:
        if (fn === 0) return [1];
        if (fn === 1) return [0, 0x00, 0x64, 0xe0, 0x32, 0x64, 0x00];
        if (fn === 2) return [0, this.dpi >> 8, this.dpi & 0xff, 0x06, 0x40];
        if (fn === 3) {
          const dpi = (p[1] << 8) | p[2];
          if (dpi < 100 || dpi > 25600 || dpi % 50) return 0x02;
          this.dpi = dpi;
          return [0, p[1], p[2], p[3]];
        }
        return 0x07;
      case 0x8060:
        if (fn === 0) return [0x8b];
        if (fn === 1) return [this.reportRateMs];
        if (fn === 2) {
          if (![1, 2, 4, 8].includes(p[0])) return 0x02;
          this.reportRateMs = p[0];
          return [];
        }
        return 0x07;
      case 0x2121:
        if (fn === 0) return [0x08, 0x0c];
        if (fn === 1) return [this.wheelMode];
        if (fn === 2) {
          this.wheelMode = p[0];
          return [p[0]];
        }
        if (fn === 3) return [0x01];
        return 0x07;
      case 0x8110:
        if (fn === 0) return [0x0b];
        if (fn === 1) this.spying = true;
        if (fn === 2) this.spying = false;
        if (fn === 3) return [1, 2, 3, 4, 0, 5];
        return [];
      case 0x8071:
        return this.rgb(fn, p);
      case 0x8081:
        if (fn === 1) {
          for (let i = 0; i + 3 < 16 && p[i + 1] !== undefined; i += 4) if (p[i] || p[i + 1] || p[i + 2] || p[i + 3]) this.ledPending[p[i]] = p.slice(i + 1, i + 4);
        }
        if (fn === 7) {
          this.ledFrames.push(this.ledPending);
          this.ledPending = {};
        }
        return [];
      case 0x8100:
        return this.onboard(fn, p);
      default:
        return 0x07;
    }
  }

  private rgb(fn: number, p: number[]): number[] | number {
    const clusters: Record<number, number[]> = { 0: [0x00, 0x01, 0x0a, 0x03], 0xff: [0x04, 0x0c, 0x0f, 0x10, 0x13] };
    if (fn === 0) {
      if (p[0] === 0xff && p[1] === 0xff) return Array.from(fromHex('ff 00 01 00 33 00 04 05'));
      const list = clusters[p[0]];
      if (!list) return 0x02;
      if (p[1] === 0xff && p[0] !== 0xff) return [p[0], 0, 0x00, 0x01, list.length, 0x01];
      if (p[1] >= list.length) return 0x02;
      return [p[0], p[1], 0, list[p[1]], 0, 0, 0, 0];
    }
    if (fn === 1) {
      this.effects.push(p.slice(0, 13));
      return [];
    }
    if (fn === 3) {
      if (p[0] === 0) return [0, p[1], p[2], this.startupEffect, 0, 0, 0, 0, 0, 0];
      this.startupEffect = p[3];
      return [1, p[1], p[2]];
    }
    if (fn === 5) {
      if (p[0] === 1) this.swControl = [p[1], p[2]];
      return [p[0], ...this.swControl];
    }
    if (fn === 7) return p[0] === 0 ? [0, 0, 0, 0x00, 0x3c, 0x01, 0x2c] : [1];
    return [];
  }

  private onboard(fn: number, p: number[]): number[] | number {
    const u16 = (i: number) => (p[i] << 8) | p[i + 1];
    switch (fn) {
      case 0:
        return [0x01, 0x05, 0x01, 0x05, 0x02, 0x0b, SECTOR_COUNT, 0x00, SECTOR_SIZE, 0x0a, 0x04];
      case 1:
        if (p[0] !== 1 && p[0] !== 2) return 0x02;
        this.mode = p[0];
        if (this.mode === 1 && !this.activeProfile) this.activate(1);
        if (this.mode === 2) this.activeProfile = 0;
        return [];
      case 2:
        return [this.mode];
      case 3: {
        const n = u16(0);
        const dir = decodeDirectory(this.flash.get(0)!);
        if (!dir[n - 1]?.enabled) return 0x02;
        if (this.mode === 1) this.activate(n);
        return [];
      }
      case 4:
        return [0, this.mode === 1 ? this.activeProfile : 0];
      case 5: {
        const sector = this.flash.get(u16(0));
        const off = u16(2);
        if (!sector || off + 16 > SECTOR_SIZE) return 0x02;
        return Array.from(sector.slice(off, off + 16));
      }
      case 6: {
        const s = u16(0);
        if (s >= SECTOR_COUNT) return 0x02;
        this.flash.set(s, new Uint8Array(SECTOR_SIZE).fill(0xff)); // erase
        this.pendingWrite = { sector: s, length: u16(4), data: [] };
        return [];
      }
      case 7:
        if (!this.pendingWrite) return 0x05;
        this.pendingWrite.data.push(...p.slice(0, 16));
        return [0, Math.ceil(this.pendingWrite.data.length / 16)];
      case 8: {
        if (!this.pendingWrite) return 0x05;
        const data = Uint8Array.from(this.pendingWrite.data.slice(0, this.pendingWrite.length));
        const { sector } = this.pendingWrite;
        this.pendingWrite = undefined;
        const n = data.length;
        if (crc16(data, n - 2) !== ((data[n - 2] << 8) | data[n - 1])) return 0x04;
        this.flash.set(sector, data);
        return [];
      }
      case 11:
        return [this.dpiIndex];
      case 12: {
        const p0 = this.profileOf(this.activeProfile || 1);
        if (p[0] >= p0.dpiLevels.length) return 0x02;
        this.dpiIndex = p[0];
        this.dpi = p0.dpiLevels[p[0]];
        return [];
      }
      default:
        return 0x07;
    }
  }
}
