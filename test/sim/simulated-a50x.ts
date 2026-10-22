// A simulated A50 X base station speaking the same bytes the real one did in our captures.
// It exists so the client, service and IPC layers can be tested without hardware; every
// response layout and error code here mirrors a captured frame in test/fixtures/captures.ts.

import type { HidTransport } from '../../src/device/transport.js';
import { fromHex } from '../../src/protocol/packet.js';
import { CAPTURED, FEATURE_TABLE } from '../fixtures/captures.js';

export function frame(hex: string): Uint8Array {
  const r = new Uint8Array(64);
  r.set(fromHex(hex));
  return r;
}

const payloadOf = (hex: string) => {
  const b = fromHex(hex);
  return Array.from(b.slice(6, 3 + b[2]));
};

export class SimulatedA50X implements HidTransport {
  readonly written: Uint8Array[] = [];
  private listeners = new Set<(r: Uint8Array) => void>();
  /** When set, requests to these feature indexes get no answer (for timeout tests). */
  silentIndexes = new Set<number>();
  closed = false;
  /** Called after a request is received and before it is answered (one-shot). */
  beforeReply?: () => void;

  state = {
    sidetone: 6,
    volume: 21,
    muted: false,
    balance: 6,
    sleep: [0x3c, 30],
    brightness: 100,
    tones: 1,
    gate: 0,
    routing: { gain: 0x1a, muted: false, inputs: [[0, 0x10, 1], [1, 0x10, 0], [2, 0x10, 1], [3, 0x10, 0]] as number[][] },
    eqLive: [payloadOf(CAPTURED.eqMicLive).slice(1), payloadOf(CAPTURED.eqHeadphonesPreset0)],
    activeSlot: [3, 3],
  };

  private readonly presets: number[][][] = [
    [CAPTURED.eqMicPreset0, CAPTURED.eqMicPreset1, CAPTURED.eqMicPreset2].map((h) => payloadOf(h)),
    [CAPTURED.eqHeadphonesPreset0, CAPTURED.eqHeadphonesPreset1, CAPTURED.eqHeadphonesPreset2].map((h) => payloadOf(h)),
  ];

  onReport(listener: (r: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  write(report: Uint8Array): void {
    this.written.push(report);
    const [rid, channel, len, dev, idx, fnsw] = report;
    if (rid !== 0x02 || channel !== 0x0c) return;
    const params = Array.from(report.slice(6, 3 + len));
    const fn = fnsw >> 4;
    const swid = fnsw & 0x0f;
    if (this.silentIndexes.has(idx)) return;
    const hook = this.beforeReply;
    this.beforeReply = undefined;
    hook?.();
    queueMicrotask(() => this.handle(dev, idx, fn, swid, params));
  }

  /** Push an unsolicited event, as the headset does when changed from its own buttons. */
  emitEvent(idx: number, params: number[]): void {
    this.send([0x00, idx, 0x00, ...params]);
  }

  /** Inject a raw frame body (DEV IDX FNSW params...), e.g. a reply meant for another client. */
  inject(body: number[]): void {
    this.send(body);
  }

  private send(body: number[]): void {
    const r = new Uint8Array(64);
    r.set([0x02, 0x0c, body.length, ...body]);
    for (const l of this.listeners) l(r);
  }

  private reply(idx: number, fn: number, swid: number, params: number[] = []): void {
    this.send([0x00, idx, (fn << 4) | swid, ...params]);
  }

  private error(idx: number, fn: number, swid: number, code: number): void {
    this.send([0x00, 0xff, idx, (fn << 4) | swid, code]);
  }

  private handle(_dev: number, idx: number, fn: number, swid: number, p: number[]): void {
    const s = this.state;
    const ok = (params: number[] = []) => this.reply(idx, fn, swid, params);
    const err = (code: number) => this.error(idx, fn, swid, code);
    const event = (params: number[], eventFn = 0) => this.send([0x00, idx, eventFn << 4, ...params]);
    const id = FEATURE_TABLE.find(([i]) => i === idx)?.[1];

    switch (id) {
      case 0x0000: {
        if (fn !== 0) return err(0x02);
        const want = (p[0] << 8) | p[1];
        const hit = FEATURE_TABLE.find(([, fid]) => fid === want);
        return hit ? ok([hit[0], 0, hit[2]]) : err(0x05);
      }
      case 0x0001: {
        if (fn === 0) return ok([FEATURE_TABLE.length, 0]);
        if (fn !== 1) return err(0x02);
        const start = p[0];
        if (start >= FEATURE_TABLE.length) return err(0x05);
        const batch = FEATURE_TABLE.slice(start, start + 14);
        return ok([batch.length, ...batch.flatMap(([, fid, ver]) => [fid >> 8, fid & 0xff, 0, ver])]);
      }
      case 0x0100:
        if (fn === 0) return ok(payloadOf(CAPTURED.deviceInfoHardware));
        if (fn === 1) return ok(payloadOf(CAPTURED.deviceInfoFirmware));
        if (fn === 2) return ok(payloadOf(CAPTURED.deviceInfoSerial));
        return err(0x02);
      case 0x0101:
        if (fn === 0) return ok(payloadOf(CAPTURED.deviceName));
        if (fn === 2) return ok(payloadOf(CAPTURED.deviceModelName));
        return err(0x02);
      case 0x0104:
        return fn === 0 ? ok([0x5f, 0x5f]) : err(0x02);
      case 0x0305:
        if (fn === 0) return ok([1, 0]);
        if (fn === 1) return ok(payloadOf(CAPTURED.btHostAddress));
        if (fn === 2) return ok(payloadOf(CAPTURED.btHostName));
        return err(0x02);
      case 0x0604: // sidetone
        if (fn === 0) return ok([1, 1, 0xff, s.sidetone]);
        if (fn === 2) return ok([0xee, 0x00, 0x07]);
        if (fn === 1) {
          if (p.length < 3) return err(0x03);
          if (p[2] > 6) return err(0x0b);
          s.sidetone = p[2];
          ok();
          return event([1, 1, 0xff, s.sidetone]);
        }
        return err(0x02);
      case 0x0200: { // volume
        const scaled = () => Math.round((s.volume / 21) * 31);
        if (fn === 0) return ok([scaled(), s.muted ? 1 : 0, s.volume]);
        if (fn === 3) return ok([0x16, 0]);
        if (fn === 1) {
          if (p.length < 2) return err(0x03);
          if (p[0] !== 0xff || p[1] > 21) return err(0x05);
          s.volume = p[1];
          ok();
          return event([scaled(), s.muted ? 1 : 0, s.volume]);
        }
        if (fn === 2) {
          if (p[0] > 1) return err(0x05);
          s.muted = p[0] === 1;
          ok();
          return event([scaled(), s.muted ? 1 : 0, s.volume]);
        }
        return err(0x02);
      }
      case 0x0609: // balance
        if (fn === 0) return ok([s.balance, 0]);
        if (fn === 2) return ok([0x0c, 0x05, 0x04]);
        if (fn === 1) {
          s.balance = Math.min(p[0], 12); // the real firmware clamps (99 became 12)
          ok();
          return event([s.balance]);
        }
        return err(0x02);
      case 0x0108: // auto sleep: like the real device, a short write leaves the second byte 0
        if (fn === 0) return ok(s.sleep);
        if (fn === 1) {
          s.sleep = [p[0], p[1] ?? 0];
          ok();
          return event(s.sleep);
        }
        return err(0x02);
      case 0x0110: // brightness: no event of its own, only the settings checksum changes
        if (fn === 0) return ok([s.brightness, 0]);
        if (fn === 1) {
          if (p[0] > 100) return err(0x05);
          s.brightness = p[0];
          ok();
          return this.send([0x00, 18, 0x00, 0x00, 0x00, s.brightness, 0x72, 0x0e, 0xad]);
        }
        return err(0x02);
      case 0x060b: // tones
        if (fn === 0) return ok([s.tones, 0]);
        if (fn === 1) {
          if (p[0] > 2) return err(0x05);
          s.tones = p[0];
          ok();
          return event([s.tones]);
        }
        return err(0x02);
      case 0x0801: // noise gate
        if (fn === 0) return ok([0x40, 0]);
        if (fn === 1) return ok([s.gate, 0]);
        if (fn === 3) return ok([4, 0, 1, 2, 4]);
        if (fn === 2) {
          if (![0, 1, 2, 4].includes(p[0])) return err(0x05);
          s.gate = p[0];
          ok();
          return event([s.gate]);
        }
        return err(0x02);
      case 0x0800: { // routing
        const body = () => [s.routing.gain, s.routing.muted ? 1 : 0, s.routing.inputs.length, ...s.routing.inputs.flat()];
        if (fn === 0) return ok(payloadOf(CAPTURED.routingInputs));
        if (fn === 1) return ok(payloadOf(CAPTURED.routingOutputs));
        if (fn === 4) return ok(payloadOf(CAPTURED.routingInfo));
        if (fn === 5) return p[0] === 0 ? ok(body()) : err(0x05);
        if (fn === 6) {
          const [out, gain, muted, count] = p;
          if (out !== 0 || gain > 32) return err(0x05);
          const inputs = Array.from({ length: count }, (_, k) => p.slice(4 + k * 3, 7 + k * 3));
          if (inputs.some(([i, g]) => i > 3 || g > 32)) return err(0x05);
          s.routing = { gain, muted: muted === 1, inputs };
          ok();
          return event([0, ...body()], 2);
        }
        return err(0x02);
      }
      case 0x020d: { // EQ
        if (fn === 0) return ok(payloadOf(CAPTURED.eqInfo));
        if (fn === 3) return p[0] <= 1 ? ok([s.activeSlot[p[0]], 0]) : err(0x05);
        if (fn === 5) return p[0] <= 1 && p[1] <= 2 ? ok(this.presets[p[0]][p[1]]) : err(0x0b);
        if (fn === 1) {
          if (p.length < 2) return err(0x03);
          return p[0] <= 1 && p[1] === 3 ? ok([0, ...s.eqLive[p[0]]]) : err(0x0b);
        }
        if (fn === 2) {
          const [inst, slot] = p;
          if (inst > 1 || slot !== 3 || p.length !== 3 + 50) return err(0x05);
          s.eqLive[inst] = p.slice(3);
          s.activeSlot[inst] = 3;
          ok();
          return event([inst, slot, 0, ...s.eqLive[inst]]);
        }
        return err(0x02);
      }
      default:
        return err(0x02);
    }
  }
}
