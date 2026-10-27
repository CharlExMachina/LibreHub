// A fake MX Brio at the level of UVC control requests, built from the controls dumped from the real
// camera (test/fixtures/mx-brio.ts). It behaves like the firmware in the ways that matter to the
// client: units found through the configuration descriptor; GET_LEN/INFO/CUR/MIN/MAX/RES/DEF;
// SET_CUR refused (a STALL) for read-only controls, wrong lengths, values out of range, and the
// manual values of exposure, focus and white balance while their auto mode is on; zoom and pan/tilt
// mirrored into Logitech's units as the camera does; and a restart when the microphone switch
// changes, which drops the connection and forgets framing and exposure mode.

import type { RawUvc } from '../../src/camera/transport.js';
import { fromHex, toHex, UvcRequest } from '../../src/camera/uvc.js';
import { CONFIG_DESCRIPTOR, CONTROL_DUMP } from '../fixtures/mx-brio.js';

interface Control {
  len: number;
  info: number;
  cur: Uint8Array;
  min: Uint8Array;
  max: Uint8Array;
  res: Uint8Array;
  def: Uint8Array;
}

/** Controls the camera forgets when it restarts (docs/evidence/mx-brio/uvc/persistence-reboot.txt). */
const VOLATILE = ['1:2', '1:3', '1:11', '1:13', '10:5', '10:6', '11:12'];
/** What the camera comes back with where it has no GET_DEF: auto exposure (aperture priority), exposure priority. */
const AFTER_RESTART: Record<string, string> = { '1:2': '08', '1:3': '01' };
/** Copies the camera keeps of camera-terminal controls in Logitech's units. */
const MIRRORS: Record<string, string> = { '1:11': '10:6', '1:13': '11:12' };
/** A manual value, and the switch that makes the camera refuse it: [control, switch, value meaning "auto"]. */
const GATED: [string, string, number][] = [
  ['1:4', '1:2', -1], // exposure time: refused unless AE mode is manual (1)
  ['1:6', '1:8', 1],
  ['3:10', '3:11', 1],
];

export class StallError extends Error {
  constructor(what: string) {
    super(`the camera refused the request (${what})`);
  }
}

export class SimulatedMxBrio implements RawUvc {
  readonly controls = new Map<string, Control>();
  /** Every SET_CUR that was accepted, as "unit:selector=hex". */
  readonly written: string[] = [];
  /** Every request, accepted or not. */
  readonly requests: string[] = [];
  /** The camera restarted (microphone switch) and this connection is gone. */
  gone = false;
  restarts = 0;
  closed = false;

  constructor() {
    for (const [key, c] of Object.entries(CONTROL_DUMP)) {
      this.controls.set(key, { len: c.len, info: c.info, cur: fromHex(c.cur), min: fromHex(c.min), max: fromHex(c.max), res: fromHex(c.res), def: fromHex(c.def) });
    }
  }

  /** The current bytes of a control, as hex. */
  cur(key: string): string {
    return toHex(this.controls.get(key)!.cur);
  }

  /** Set a control behind the client's back (another program, or the camera itself). */
  poke(key: string, hex: string): void {
    this.controls.get(key)!.cur = fromHex(hex);
  }

  private check(what: string) {
    if (this.closed) throw new Error('closed');
    if (this.gone) throw new Error('the camera was disconnected');
    this.requests.push(what);
  }

  async configDescriptor(): Promise<Uint8Array> {
    this.check('GET_DESCRIPTOR');
    return fromHex(CONFIG_DESCRIPTOR);
  }

  async get(code: number, unit: number, selector: number, length: number): Promise<Uint8Array> {
    const key = `${unit}:${selector}`;
    this.check(`GET ${code.toString(16)} ${key}`);
    const c = this.controls.get(key);
    if (!c) throw new StallError(`no control ${key}`);
    const reply = (b: Uint8Array) => {
      if (length < b.length) throw new StallError(`${key}: asked for ${length} bytes of ${b.length}`);
      return b.slice();
    };
    switch (code) {
      case UvcRequest.GET_LEN:
        return Uint8Array.from([c.len & 0xff, c.len >> 8]);
      case UvcRequest.GET_INFO:
        return Uint8Array.from([c.info]);
      case UvcRequest.GET_CUR:
        return reply(c.cur);
      case UvcRequest.GET_MIN:
        return reply(c.min);
      case UvcRequest.GET_MAX:
        return reply(c.max);
      case UvcRequest.GET_RES:
        return reply(c.res);
      case UvcRequest.GET_DEF:
        return reply(c.def);
      default:
        throw new StallError(`request ${code.toString(16)}`);
    }
  }

  async set(unit: number, selector: number, data: Uint8Array): Promise<void> {
    const key = `${unit}:${selector}`;
    this.check(`SET ${key} ${toHex(data)}`);
    const c = this.controls.get(key);
    if (!c) throw new StallError(`no control ${key}`);
    if (!(c.info & 0x02)) throw new StallError(`${key} is read-only`);
    if (data.length !== c.len) throw new StallError(`${key} takes ${c.len} bytes, got ${data.length}`);
    for (const [gated, sw, autoValue] of GATED) {
      if (key !== gated) continue;
      const s = this.controls.get(sw)!.cur[0];
      if (autoValue === -1 ? s !== 0x01 : s === autoValue) throw new StallError(`${key} while ${sw} is auto`);
    }
    if (!inRange(c, data)) throw new StallError(`${key}=${toHex(data)} out of range`);
    const changed = toHex(c.cur) !== toHex(data);
    c.cur = data.slice();
    this.written.push(`${key}=${toHex(data)}`);
    if (MIRRORS[key]) this.controls.get(MIRRORS[key])!.cur = data.slice();
    if (key === '11:16' && changed) this.restart();
  }

  /** The camera restarts: framing and exposure mode go back to their defaults, the link drops. */
  restart(): void {
    for (const key of VOLATILE) {
      const c = this.controls.get(key);
      if (c) c.cur = AFTER_RESTART[key] ? fromHex(AFTER_RESTART[key]) : c.def.slice();
    }
    this.restarts++;
    this.gone = true;
  }

  /** Plugged back in (or done restarting): a new connection may be opened. */
  reconnect(): this {
    this.gone = false;
    this.closed = false;
    return this;
  }

  close(): void {
    this.closed = true;
  }
}

/** Range check for 1-, 2- and 4-byte controls, and each 4-byte half of pan/tilt (signed). */
function inRange(c: Control, data: Uint8Array): boolean {
  if (!c.min.length || !c.max.length) return true;
  const fields = c.len === 8 ? [0, 4] : [0];
  const size = c.len === 8 ? 4 : c.len;
  if (size > 4) return true;
  const signed = c.len === 8;
  const read = (b: Uint8Array, at: number) => {
    const v = new DataView(b.buffer, b.byteOffset + at, size);
    if (size === 1) return v.getUint8(0);
    if (size === 2) return v.getUint16(0, true);
    return signed ? v.getInt32(0, true) : v.getUint32(0, true);
  };
  return fields.every((at) => read(data, at) >= read(c.min, at) && read(data, at) <= read(c.max, at));
}
