import { EventEmitter } from 'node:events';
import type { HidTransport } from '../device/transport.js';
import {
  AdjustableDpi,
  DeviceName,
  FeatureSet,
  FirmwareInfo,
  HiResWheel,
  MouseButtonSpy,
  OnboardProfiles,
  PerKeyLighting,
  ReportRate,
  RgbEffects,
  Root,
  UnifiedBattery,
} from './codecs.js';
import { Feature, featureName } from './features.js';
import { codeName, decodeConnection, decodeFrame, encodeRequest, Error10, Error20, toHex } from './hidpp.js';
import {
  decodeDirectory,
  decodeProfile,
  DIRECTORY_SECTOR,
  encodeDirectory,
  encodeEffect,
  encodeProfile,
  ROM_DIRECTORY_SECTOR,
  sectorCrcOk,
  withCrc,
  type DirectoryEntry,
  type LedEffect,
  type Profile,
} from './onboard.js';

export interface FeatureEntry {
  id: number;
  index: number;
  type: number;
  version: number;
}

/** A HID++ 2.0 feature call the mouse rejected. */
export class DeviceError extends Error {
  constructor(
    readonly featureId: number,
    readonly fn: number,
    readonly code: number,
  ) {
    super(`${featureName(featureId)} fn${fn} failed with error 0x${code.toString(16).padStart(2, '0')} (${codeName(Error20, code)})`);
  }
}

/** The receiver could not reach the mouse: it is asleep, switched off or out of range. */
export class MouseUnavailableError extends Error {
  constructor(readonly code: number) {
    super(
      code === Error10.UNKNOWN_DEVICE
        ? 'The mouse is asleep or switched off (the receiver answered "unknown device"). Move it to wake it up.'
        : `The receiver rejected the request: 0x${code.toString(16)} (${codeName(Error10, code)})`,
    );
  }
}

export class TimeoutError extends Error {}

export interface MouseOptions {
  /** Receiver slot of the mouse (1..6). Default: the first slot that answers. */
  deviceIndex?: number;
  /** Software id for our requests (1..15). G Hub uses 0xD; we use 0xB so the two never collide. */
  swid?: number;
  timeoutMs?: number;
  /** Keep retrying for this long while the mouse sleeps (0 = fail at once). */
  wakeTimeoutMs?: number;
  log?: (direction: 'out' | 'in', bytes: Uint8Array) => void;
}

interface Pending {
  featureIndex: number;
  fn: number;
  featureId: number;
  resolve: (params: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Which LED slot an effect belongs to, as G Hub assigns them. */
const PRIMARY_EFFECTS = new Set(['fixed', 'cycle', 'breathing']);

/**
 * Client for a Logitech HID++ 2.0 gaming mouse behind a Lightspeed receiver, written against the
 * G502 X PLUS. Requests are serialized and matched by device, feature index, function and software
 * id. Unsolicited reports become events: 'battery', 'connection', 'onboard', 'activity', 'raw'.
 */
export class G502X extends EventEmitter {
  readonly swid: number;
  deviceIndex: number;
  private readonly timeoutMs: number;
  private readonly wakeTimeoutMs: number;
  private readonly log?: MouseOptions['log'];
  private readonly unsubscribe: () => void;
  private chain: Promise<unknown> = Promise.resolve();
  private pending?: Pending;
  private readonly byId = new Map<number, FeatureEntry>();
  private readonly byIndex = new Map<number, FeatureEntry>();
  private descriptionCache?: ReturnType<typeof OnboardProfiles.decodeDescription>;
  private readonly rawWaiters = new Set<(r: Uint8Array) => boolean>();
  /** Replies that timed out may still arrive; drop them instead of matching the next request. */
  private readonly stale: { key: string; until: number }[] = [];

  private constructor(
    private readonly transport: HidTransport,
    opts: MouseOptions,
  ) {
    super();
    this.swid = opts.swid ?? 0x0b;
    if (this.swid < 1 || this.swid > 15) throw new RangeError('swid must be 1..15');
    this.deviceIndex = opts.deviceIndex ?? 1;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.wakeTimeoutMs = opts.wakeTimeoutMs ?? 0;
    this.log = opts.log;
    this.unsubscribe = transport.onReport((r) => this.onReport(r));
  }

  /** Find the mouse behind the receiver and discover its feature table. */
  static async connect(transport: HidTransport, opts: MouseOptions = {}): Promise<G502X> {
    const mouse = new G502X(transport, opts);
    try {
      if (opts.deviceIndex === undefined) await mouse.findDeviceIndex();
      await mouse.discover();
    } catch (err) {
      mouse.close();
      throw err;
    }
    return mouse;
  }

  close(): void {
    this.unsubscribe();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('device closed'));
      this.pending = undefined;
    }
    this.transport.close();
  }

  get features(): FeatureEntry[] {
    return [...this.byIndex.values()].sort((a, b) => a.index - b.index);
  }

  has(featureId: number): boolean {
    return this.byId.has(featureId);
  }

  // ------------------------------------------------------------ transport plumbing

  private onReport(report: Uint8Array): void {
    this.log?.('in', report);
    for (const w of this.rawWaiters) if (w(report)) return;
    const frame = decodeFrame(report);
    if (!frame) return;
    const p = this.pending;
    if (frame.kind === 'notification') {
      if (frame.subId === 0x41 && frame.deviceIndex === this.deviceIndex) this.emit('connection', decodeConnection(frame.params));
      return;
    }
    if (frame.deviceIndex !== this.deviceIndex) return;
    if (frame.swid === this.swid && this.dropStale(`${frame.featureIndex}:${frame.fn}`)) return;
    if (p && frame.swid === this.swid && frame.featureIndex === p.featureIndex && frame.fn === p.fn) {
      clearTimeout(p.timer);
      this.pending = undefined;
      if (frame.kind === 'error') p.reject(new DeviceError(p.featureId, p.fn, frame.code));
      else if (frame.kind === 'receiverError') p.reject(new MouseUnavailableError(frame.code));
      else p.resolve(frame.params);
      return;
    }
    if (frame.kind === 'message' && frame.swid === 0) this.onEvent(frame.featureIndex, frame.fn, frame.params);
  }

  private dropStale(key: string): boolean {
    const now = Date.now();
    while (this.stale.length && this.stale[0].until < now) this.stale.shift();
    const i = this.stale.findIndex((s) => s.key === key);
    if (i < 0) return false;
    this.stale.splice(i, 1);
    return true;
  }

  private onEvent(featureIndex: number, fn: number, params: Uint8Array): void {
    const id = this.byIndex.get(featureIndex)?.id ?? -1;
    this.emit('raw', { featureId: id, featureIndex, fn, params });
    if (id === Feature.UNIFIED_BATTERY) this.emit('battery', UnifiedBattery.decodeStatus(params));
    else if (id === Feature.ONBOARD_PROFILES) this.emit('onboard', { fn, params: toHex(params.slice(0, 4)) });
    else if (id === Feature.RGB_EFFECTS && fn === 0) this.emit('activity', { params: toHex(params.slice(0, 4)) });
  }

  private requestOnce(featureIndex: number, fn: number, params: ArrayLike<number>, featureId: number): Promise<Uint8Array> {
    const run = () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = undefined;
          this.stale.push({ key: `${featureIndex}:${fn}`, until: Date.now() + 4 * this.timeoutMs });
          reject(new TimeoutError(`${featureName(featureId)} fn${fn}: no response within ${this.timeoutMs} ms`));
        }, this.timeoutMs);
        this.pending = { featureIndex, fn, featureId, resolve, reject, timer };
        const report = encodeRequest({ deviceIndex: this.deviceIndex, featureIndex, fn, swid: this.swid, params });
        this.log?.('out', report);
        try {
          this.transport.write(report);
        } catch (err) {
          clearTimeout(timer);
          this.pending = undefined;
          reject(err as Error);
        }
      });
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** Send one request; while the mouse sleeps, retry for up to wakeTimeoutMs. */
  async request(featureIndex: number, fn: number, params: ArrayLike<number> = [], featureId = this.byIndex.get(featureIndex)?.id ?? -1): Promise<Uint8Array> {
    const deadline = Date.now() + this.wakeTimeoutMs;
    for (;;) {
      try {
        return await this.requestOnce(featureIndex, fn, params, featureId);
      } catch (err) {
        const asleep = err instanceof MouseUnavailableError && err.code === Error10.UNKNOWN_DEVICE;
        if (!asleep || Date.now() >= deadline) throw err;
        this.emit('waiting', err.message);
        await sleep(500);
      }
    }
  }

  call(featureId: number, fn: number, params: ArrayLike<number> = []): Promise<Uint8Array> {
    const entry = this.byId.get(featureId);
    if (!entry) return Promise.reject(new Error(`feature ${featureName(featureId)} is not present on this device`));
    return this.request(entry.index, fn, params, featureId);
  }

  /** Like call(), but fails at once if the mouse is asleep (for steps that must not be repeated). */
  private callOnce(featureId: number, fn: number, params: ArrayLike<number> = []): Promise<Uint8Array> {
    const entry = this.byId.get(featureId);
    if (!entry) return Promise.reject(new Error(`feature ${featureName(featureId)} is not present on this device`));
    return this.requestOnce(entry.index, fn, params, featureId);
  }

  /** Wait (up to wakeTimeoutMs) until the mouse answers again. */
  private async waitAwake(): Promise<void> {
    await this.request(0, Root.PING, [0, 0, 0x5a], Feature.ROOT);
  }

  /**
   * Read a HID++ 1.0 register of the receiver (10 FF 81/83 REG SUB 00 00). The receiver answers
   * even while the mouse sleeps. Resolves with the bytes after REG, or null on an error reply.
   */
  readReceiverRegister(register: number, sub: number, long = true): Promise<Uint8Array | null> {
    const subId = long ? 0x83 : 0x81;
    return new Promise((resolve, reject) => {
      const waiter = (r: Uint8Array) => {
        if (r[1] !== 0xff) return false;
        if (r[2] === subId && r[3] === register && r[4] === sub) done(r.slice(4));
        else if (r[2] === 0x8f && r[3] === subId && r[4] === register) done(null);
        else return false;
        return true;
      };
      const done = (v: Uint8Array | null) => {
        clearTimeout(timer);
        this.rawWaiters.delete(waiter);
        resolve(v);
      };
      const timer = setTimeout(() => {
        this.rawWaiters.delete(waiter);
        reject(new TimeoutError(`receiver register 0x${register.toString(16)}: no response`));
      }, this.timeoutMs);
      this.rawWaiters.add(waiter);
      const out = new Uint8Array(7);
      out.set([0x10, 0xff, subId, register, sub]);
      this.log?.('out', out);
      this.transport.write(out);
    });
  }

  /** Paired devices from the receiver's pairing register (0xB5, 0x20 + slot - 1). */
  async getPairedDevices(): Promise<{ slot: number; wirelessPid: number }[]> {
    const out = [];
    for (let slot = 1; slot <= 6; slot++) {
      const r = await this.readReceiverRegister(0xb5, 0x20 + slot - 1);
      if (r) out.push({ slot, wirelessPid: (r[3] << 8) | r[4] });
    }
    return out;
  }

  private async findDeviceIndex(): Promise<void> {
    // Behind a receiver, use its pairing table; this works while the mouse sleeps.
    const paired = await this.getPairedDevices().catch(() => []);
    if (paired.length > 0) {
      this.deviceIndex = (paired.find((d) => d.wirelessPid === 0x4099) ?? paired[0]).slot;
      return;
    }
    // A mouse on its USB cable answers as device 0xFF.
    let lastError: unknown;
    for (const index of [0xff, 1, 2, 3, 4, 5, 6]) {
      this.deviceIndex = index;
      try {
        const { index: fs } = Root.decodeGetFeature(await this.request(0, Root.GET_FEATURE, Root.encodeGetFeature(Feature.ONBOARD_PROFILES), Feature.ROOT));
        if (fs !== 0) return;
      } catch (err) {
        lastError = err;
      }
    }
    this.deviceIndex = 1;
    throw lastError instanceof Error ? lastError : new Error('no HID++ 2.0 mouse with onboard profiles found behind the receiver');
  }

  private async discover(): Promise<void> {
    this.addFeature({ id: Feature.ROOT, index: 0, type: 0, version: 0 });
    const fs = Root.decodeGetFeature(await this.request(0, Root.GET_FEATURE, Root.encodeGetFeature(Feature.FEATURE_SET), Feature.ROOT));
    this.addFeature({ id: Feature.FEATURE_SET, index: fs.index, type: fs.type, version: fs.version });
    const count = FeatureSet.decodeCount(await this.call(Feature.FEATURE_SET, FeatureSet.GET_COUNT));
    for (let i = 1; i <= count; i++) {
      const f = FeatureSet.decodeFeatureId(await this.call(Feature.FEATURE_SET, FeatureSet.GET_FEATURE_ID, [i]));
      this.addFeature({ ...f, index: i });
    }
  }

  private addFeature(f: FeatureEntry): void {
    this.byId.set(f.id, f);
    this.byIndex.set(f.index, f);
  }

  // ------------------------------------------------------------ information

  async getInfo() {
    const info = FirmwareInfo.decodeInfo(await this.call(Feature.FIRMWARE_INFO, FirmwareInfo.GET_INFO));
    const firmware = [];
    for (let e = 0; e < Math.min(info.entityCount, 2); e++) {
      firmware.push(FirmwareInfo.decodeEntity(await this.call(Feature.FIRMWARE_INFO, FirmwareInfo.GET_ENTITY, [e])));
    }
    const length = DeviceName.decodeLength(await this.call(Feature.DEVICE_NAME, DeviceName.GET_LENGTH));
    let name = '';
    while (name.length < length) {
      const chunk = DeviceName.decodeChunk(await this.call(Feature.DEVICE_NAME, DeviceName.GET_CHUNK, [name.length]));
      if (!chunk) break;
      name += chunk;
    }
    const ping = Root.decodePing(await this.request(0, Root.PING, [0, 0, 0x5a], Feature.ROOT));
    return { name: name.slice(0, length), serial: info.serial, unitId: info.unitId, modelIds: info.modelIds, firmware, protocol: ping.protocol };
  }

  async getBattery() {
    return UnifiedBattery.decodeStatus(await this.call(Feature.UNIFIED_BATTERY, UnifiedBattery.GET_STATUS));
  }

  // ------------------------------------------------------------ onboard memory (persistent settings)

  async getOnboardDescription() {
    this.descriptionCache ??= OnboardProfiles.decodeDescription(await this.call(Feature.ONBOARD_PROFILES, OnboardProfiles.GET_DESCRIPTION));
    return this.descriptionCache;
  }

  /** 'onboard': the mouse runs from its saved profiles. 'host': software (G Hub) drives it live. */
  async getMode(): Promise<string> {
    return OnboardProfiles.decodeMode(await this.call(Feature.ONBOARD_PROFILES, OnboardProfiles.GET_MODE));
  }

  async setMode(mode: 'onboard' | 'host'): Promise<void> {
    await this.call(Feature.ONBOARD_PROFILES, OnboardProfiles.SET_MODE, [OnboardProfiles.MODE[mode]]);
  }

  /** Active onboard profile, 1-based; 0 in host mode. */
  async getActiveProfile(): Promise<number> {
    return OnboardProfiles.decodeCurrentProfile(await this.call(Feature.ONBOARD_PROFILES, OnboardProfiles.GET_CURRENT_PROFILE));
  }

  /** Switch to an enabled profile (1-based). Re-selecting the active one reloads it from memory. */
  async setActiveProfile(profile: number): Promise<void> {
    const dir = await this.readDirectory();
    const entry = dir[profile - 1];
    if (!entry) throw new RangeError(`profile ${profile} does not exist (1..${dir.length})`);
    if (!entry.enabled) throw new RangeError(`profile ${profile} is disabled; enable it first`);
    await this.call(Feature.ONBOARD_PROFILES, OnboardProfiles.SET_CURRENT_PROFILE, OnboardProfiles.encodeSetCurrentProfile(profile));
  }

  /** Index into the active profile's DPI table (0-based). */
  async getDpiIndex(): Promise<number> {
    return (await this.call(Feature.ONBOARD_PROFILES, OnboardProfiles.GET_CURRENT_DPI_INDEX))[0];
  }

  async setDpiIndex(index: number): Promise<void> {
    let levels = 5;
    if ((await this.getMode()) === 'onboard') levels = (await this.readProfile(await this.getActiveProfile())).dpiLevels.length;
    if (!Number.isInteger(index) || index < 0 || index >= levels) throw new RangeError(`DPI level must be 0..${levels - 1}`);
    await this.call(Feature.ONBOARD_PROFILES, OnboardProfiles.SET_CURRENT_DPI_INDEX, [index]);
  }

  /** Read a whole sector, 16 bytes at a time; the last read is aligned to the sector end. */
  async readSector(sector: number): Promise<Uint8Array> {
    const { sectorSize } = await this.getOnboardDescription();
    const out = new Uint8Array(sectorSize);
    for (let off = 0; off < sectorSize; off += 16) {
      const o = Math.min(off, sectorSize - 16);
      const chunk = await this.call(Feature.ONBOARD_PROFILES, OnboardProfiles.MEMORY_READ, OnboardProfiles.encodeRead(sector, o));
      out.set(chunk.slice(0, 16), o);
    }
    return out;
  }

  /** One write session: start (erases the sector), 16-byte chunks, end (checks the CRC). */
  private async writeSession(sector: number, data: Uint8Array): Promise<void> {
    const size = data.length;
    // No per-request wake retry inside a session: a repeated chunk would shift the data.
    await this.callOnce(Feature.ONBOARD_PROFILES, OnboardProfiles.MEMORY_WRITE_START, OnboardProfiles.encodeWriteStart(sector, 0, size));
    for (let off = 0; off < size; off += 16) {
      const chunk = Array.from(data.slice(off, off + 16));
      while (chunk.length < 16) chunk.push(0);
      await this.callOnce(Feature.ONBOARD_PROFILES, OnboardProfiles.MEMORY_WRITE, chunk);
    }
    await this.callOnce(Feature.ONBOARD_PROFILES, OnboardProfiles.MEMORY_WRITE_END);
  }

  /**
   * Write a whole user sector the way G Hub does (start, 16-byte chunks, end), then read it back.
   * The CRC is recomputed: the firmware checks it when the write ends and answers
   * HARDWARE_ERROR if it is wrong. If the mouse falls asleep part-way, the whole session is
   * repeated once it wakes. Factory sectors (0x0100+) are read-only.
   */
  async writeSector(sector: number, bytes: Uint8Array): Promise<void> {
    const { sectorSize, sectorCount } = await this.getOnboardDescription();
    if (!Number.isInteger(sector) || sector < 0 || sector >= sectorCount) throw new RangeError(`sector ${sector} is not writable (user sectors are 0..${sectorCount - 1})`);
    if (bytes.length !== sectorSize) throw new RangeError(`a sector is ${sectorSize} bytes, got ${bytes.length}`);
    const data = withCrc(bytes);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.writeSession(sector, data);
        break;
      } catch (err) {
        const asleep = err instanceof MouseUnavailableError && err.code === Error10.UNKNOWN_DEVICE;
        if (!asleep || attempt >= 3) {
          throw new Error(`writing sector ${sector} failed (${(err as Error).message}); the sector may now be erased. Run the command again, or restore a backup.`);
        }
        this.emit('waiting', err.message);
        await this.waitAwake();
      }
    }
    const back = await this.readSector(sector);
    if (toHex(back) !== toHex(data)) throw new Error(`sector ${sector} did not read back as written`);
  }

  /**
   * Return a user sector to the erased state (all FF, no checksum). Starting a write erases the
   * sector; the firmware then rejects the all-FF data at write end (bad CRC), which leaves it
   * erased. An erased sector 0 makes the mouse use its factory directory.
   */
  async eraseSector(sector: number): Promise<void> {
    const { sectorSize, sectorCount } = await this.getOnboardDescription();
    if (!Number.isInteger(sector) || sector < 0 || sector >= sectorCount) throw new RangeError(`sector ${sector} cannot be erased (0..${sectorCount - 1})`);
    try {
      await this.writeSession(sector, new Uint8Array(sectorSize).fill(0xff));
    } catch (err) {
      if (!(err instanceof DeviceError && err.code === Error20.HARDWARE_ERROR)) throw err;
    }
    const back = await this.readSector(sector);
    if (!back.every((b) => b === 0xff)) throw new Error(`sector ${sector} did not erase`);
  }

  /**
   * The profile directory. If sector 0 is blank or damaged the mouse runs from its factory
   * directory; the user slots are still sectors 1..5, so return those (enabled like the factory
   * profiles) and mark the directory as not stored, so the next change writes sector 0 first.
   */
  private async directoryState(): Promise<{ entries: DirectoryEntry[]; stored: boolean }> {
    const dir = await this.readSector(DIRECTORY_SECTOR);
    if (sectorCrcOk(dir)) return { entries: decodeDirectory(dir), stored: true };
    const factory = await this.readFactoryDirectory();
    const { profileCount } = await this.getOnboardDescription();
    return { entries: [...Array(profileCount).keys()].map((k) => ({ sector: k + 1, enabled: factory[k]?.enabled ?? false })), stored: false };
  }

  async readDirectory(): Promise<DirectoryEntry[]> {
    return (await this.directoryState()).entries;
  }

  /** The factory directory (sector 0x0100); the mouse falls back to it if sector 0 is blank. */
  async readFactoryDirectory(): Promise<DirectoryEntry[]> {
    return decodeDirectory(await this.readSector(ROM_DIRECTORY_SECTOR));
  }

  async setProfileEnabled(profile: number, enabled: boolean): Promise<void> {
    const dir = await this.readDirectory();
    if (!dir[profile - 1]) throw new RangeError(`profile ${profile} does not exist`);
    if (!enabled && dir.filter((e) => e.enabled).length === 1 && dir[profile - 1].enabled) throw new RangeError('at least one profile must stay enabled');
    if (!enabled && (await this.getMode()) === 'onboard' && (await this.getActiveProfile()) === profile) {
      throw new RangeError(`profile ${profile} is active; switch to another profile before disabling it`);
    }
    dir[profile - 1].enabled = enabled;
    await this.writeSector(DIRECTORY_SECTOR, encodeDirectory(dir));
  }

  /**
   * Read and decode a profile. An erased slot reads as its factory profile (that is what the
   * mouse runs); a slot that fails its checksum is reported, never silently replaced.
   */
  async readProfile(profile: number): Promise<Profile & { sector: number; enabled: boolean }> {
    const dir = await this.readDirectory();
    const entry = dir[profile - 1];
    if (!entry) throw new RangeError(`profile ${profile} does not exist (1..${dir.length})`);
    let bytes = await this.readSector(entry.sector);
    if (!sectorCrcOk(bytes)) {
      if (!bytes.every((b) => b === 0xff)) {
        throw new Error(`profile ${profile} (sector ${entry.sector}) fails its checksum; restore it from a backup or with "profile ${profile} restore"`);
      }
      bytes = await this.readSector(this.factorySectorFor(profile));
    }
    return { ...decodeProfile(bytes), sector: entry.sector, enabled: entry.enabled };
  }

  async readProfiles() {
    const dir = await this.readDirectory();
    const out = [];
    for (let k = 1; k <= dir.length; k++) out.push(await this.readProfile(k));
    return out;
  }

  /**
   * Save a profile to its slot. If it is the active profile in onboard mode, re-select it so the
   * mouse applies the new settings immediately (that is what G Hub does after writing).
   */
  async writeProfile(profile: number, p: Profile): Promise<void> {
    const { entries, stored } = await this.directoryState();
    const entry = entries[profile - 1];
    if (!entry) throw new RangeError(`profile ${profile} does not exist`);
    const { dpiLevels, reportRateMs } = p;
    const dpi = await this.getDpiCapabilities();
    for (const d of dpiLevels) if (!AdjustableDpi.isValid(d, dpi)) throw new RangeError(`${d} DPI is not supported (${this.describeDpi(dpi)})`);
    const rates = await this.getReportRates();
    if (!rates.includes(reportRateMs)) throw new RangeError(`report interval ${reportRateMs} ms is not supported (${rates.join(', ')} ms)`);
    const bytes = encodeProfile(p); // validates every field before anything is erased
    if (!stored) await this.writeSector(DIRECTORY_SECTOR, encodeDirectory(entries));
    await this.writeSector(entry.sector, bytes);
    if ((await this.getMode()) === 'onboard' && (await this.getActiveProfile()) === profile) {
      await this.call(Feature.ONBOARD_PROFILES, OnboardProfiles.SET_CURRENT_PROFILE, OnboardProfiles.encodeSetCurrentProfile(profile));
    }
  }

  /** Factory sector a slot is restored from: 0x0101 for slot 1, 0x0102 for slot 2, else 0x0101. */
  factorySectorFor(profile: number): number {
    const factory = this.descriptionCache?.factoryProfileCount ?? 2;
    return ROM_DIRECTORY_SECTOR + (profile <= factory ? profile : 1);
  }

  /** G Hub's "Restore default profile": copy the factory profile back into the slot. */
  async restoreFactoryProfile(profile: number): Promise<void> {
    await this.getOnboardDescription();
    const rom = await this.readSector(this.factorySectorFor(profile));
    await this.writeProfile(profile, decodeProfile(rom));
  }

  // ------------------------------------------------------------ live settings (what G Hub does in software mode)

  async getDpiCapabilities() {
    return AdjustableDpi.decodeDpiList(await this.call(Feature.ADJUSTABLE_DPI, AdjustableDpi.GET_DPI_LIST, [0]));
  }

  private describeDpi(list: ReturnType<typeof AdjustableDpi.decodeDpiList>): string {
    return [...list.ranges.map((r) => `${r.min}..${r.max} in steps of ${r.step}`), ...list.values.map(String)].join(', ');
  }

  async getDpi() {
    return AdjustableDpi.decodeDpi(await this.call(Feature.ADJUSTABLE_DPI, AdjustableDpi.GET_DPI, [0]));
  }

  /** Set the sensor DPI now (not saved). `level` (1-based) drives the DPI indicator, as G Hub sends it. */
  async setDpi(dpi: number, level = 0): Promise<void> {
    const list = await this.getDpiCapabilities();
    if (!AdjustableDpi.isValid(dpi, list)) throw new RangeError(`${dpi} DPI is not supported (${this.describeDpi(list)})`);
    await this.call(Feature.ADJUSTABLE_DPI, AdjustableDpi.SET_DPI, AdjustableDpi.encodeSetDpi(dpi, level));
  }

  /** Supported report intervals in ms. */
  async getReportRates(): Promise<number[]> {
    return ReportRate.decodeList(await this.call(Feature.REPORT_RATE, ReportRate.GET_LIST));
  }

  async getReportRate(): Promise<number> {
    return ReportRate.decode(await this.call(Feature.REPORT_RATE, ReportRate.GET));
  }

  async setReportRate(ms: number): Promise<void> {
    const rates = await this.getReportRates();
    if (!rates.includes(ms)) throw new RangeError(`report interval ${ms} ms is not supported (${rates.join(', ')} ms)`);
    await this.call(Feature.REPORT_RATE, ReportRate.SET, ReportRate.encodeSet(ms));
  }

  async getWheel() {
    const capability = HiResWheel.decodeCapability(await this.call(Feature.HIRES_WHEEL, HiResWheel.GET_CAPABILITY));
    const mode = HiResWheel.decodeMode(await this.call(Feature.HIRES_WHEEL, HiResWheel.GET_MODE));
    const ratchet = HiResWheel.decodeRatchet(await this.call(Feature.HIRES_WHEEL, HiResWheel.GET_RATCHET));
    return { ...capability, ...mode, ratchet };
  }

  /** G Hub keeps this at 0 (native, low-resolution, not inverted). */
  async setWheelMode(mode: { highResolution?: boolean; inverted?: boolean }): Promise<void> {
    await this.call(Feature.HIRES_WHEEL, HiResWheel.SET_MODE, HiResWheel.encodeMode({ ...mode, diverted: false }));
  }

  async getButtonCount(): Promise<number> {
    return MouseButtonSpy.decodeButtonCount(await this.call(Feature.MOUSE_BUTTON_SPY, MouseButtonSpy.GET_BUTTON_COUNT));
  }

  /**
   * Lighting clusters and the effect ids each supports, from the mouse itself. Cluster 0 is the
   * primary zone; 0xFF ("all clusters") has its own effect list, enumerated until the mouse
   * answers INVALID_ARGUMENT (it has no cluster-info record of its own).
   */
  async getLightingInfo() {
    const clusters: { cluster: number; location: number; effects: number[] }[] = [];
    const { clusterCount } = RgbEffects.decodeDeviceInfo(await this.call(Feature.RGB_EFFECTS, RgbEffects.GET_INFO, [0xff, 0xff, 0x00]));
    const effectAt = async (cluster: number, e: number) =>
      RgbEffects.decodeEffectInfo(await this.call(Feature.RGB_EFFECTS, RgbEffects.GET_INFO, [cluster, e, 0x00])).effectId;
    for (let cluster = 0; cluster < clusterCount; cluster++) {
      const info = RgbEffects.decodeClusterInfo(await this.call(Feature.RGB_EFFECTS, RgbEffects.GET_INFO, [cluster, 0xff, 0x00]));
      const effects = [];
      for (let e = 0; e < info.effectCount; e++) effects.push(await effectAt(cluster, e));
      clusters.push({ cluster, location: info.location, effects });
    }
    const all = [];
    for (let e = 0; e < 16; e++) {
      try {
        all.push(await effectAt(RgbEffects.ALL_CLUSTERS, e));
      } catch (err) {
        if (err instanceof DeviceError && err.code === Error20.INVALID_ARGUMENT) break;
        throw err;
      }
    }
    clusters.push({ cluster: RgbEffects.ALL_CLUSTERS, location: 0, effects: all });
    return clusters;
  }

  /**
   * Show an effect now without saving it (G Hub's software-mode lighting). Takes software control
   * of the LEDs first, like G Hub; returnLightingToDevice() hands them back.
   */
  async setLiveEffect(effect: LedEffect): Promise<void> {
    const clusters = await this.getLightingInfo();
    const bytes = encodeEffect(effect);
    // Off, fixed, cycle and breathing belong to the real cluster(s); the rest to "all clusters" (0xFF).
    const onPrimary = effect.type === 'off' || PRIMARY_EFFECTS.has(effect.type);
    const targets = clusters.filter((c) => (onPrimary ? c.cluster !== RgbEffects.ALL_CLUSTERS : c.cluster === RgbEffects.ALL_CLUSTERS));
    if (targets.length === 0) throw new RangeError(`no lighting cluster supports ${effect.type}`);
    await this.call(Feature.RGB_EFFECTS, RgbEffects.SW_CONTROL, RgbEffects.encodeSwControl(3, 5));
    for (const c of targets) {
      const index = c.effects.indexOf(bytes[0]);
      if (index < 0) throw new RangeError(`cluster ${c.cluster} does not support effect 0x${bytes[0].toString(16)}`);
      await this.call(Feature.RGB_EFFECTS, RgbEffects.SET_EFFECT, RgbEffects.encodeSetEffect(c.cluster, index, bytes.slice(1)));
    }
  }

  /** Release software control of the LEDs so the onboard profile's lighting shows again. */
  async returnLightingToDevice(): Promise<void> {
    await this.call(Feature.RGB_EFFECTS, RgbEffects.SW_CONTROL, RgbEffects.encodeSwControl(0, 0));
  }

  /** Per-LED colours (G Hub's Freestyle tab). LED ids 1..8, see docs for where each one is. */
  async setLedColors(colors: { led: number; color: [number, number, number] }[]): Promise<void> {
    await this.call(Feature.RGB_EFFECTS, RgbEffects.SW_CONTROL, RgbEffects.encodeSwControl(3, 5));
    for (let i = 0; i < colors.length; i += 4) {
      await this.call(Feature.PER_KEY_LIGHTING, PerKeyLighting.SET_INDIVIDUAL, PerKeyLighting.encodeSetIndividual(colors.slice(i, i + 4).map((c) => ({ zone: c.led, color: c.color }))));
    }
    await this.call(Feature.PER_KEY_LIGHTING, PerKeyLighting.FRAME_END, PerKeyLighting.encodeFrameEnd());
  }

  /** Software-mode inactivity timers (seconds). Onboard profiles carry their own. */
  async getLightingPowerConfig() {
    return RgbEffects.decodePowerConfig(await this.call(Feature.RGB_EFFECTS, RgbEffects.POWER_CONFIG, [0]));
  }

  async setLightingPowerConfig(idleSeconds: number, sleepSeconds: number): Promise<void> {
    await this.call(Feature.RGB_EFFECTS, RgbEffects.POWER_CONFIG, RgbEffects.encodeSetPowerConfig(idleSeconds, sleepSeconds));
  }

  /** "Device startup effect": the animation the mouse plays when it powers on (persistent). */
  async getStartupEffect(): Promise<boolean> {
    return RgbEffects.decodeStartupEffect(await this.call(Feature.RGB_EFFECTS, RgbEffects.NV_CONFIG, RgbEffects.encodeGetNv(RgbEffects.STARTUP_EFFECT)));
  }

  async setStartupEffect(enabled: boolean): Promise<void> {
    const current = await this.call(Feature.RGB_EFFECTS, RgbEffects.NV_CONFIG, RgbEffects.encodeGetNv(RgbEffects.STARTUP_EFFECT));
    const data = Array.from(current.slice(3, 10));
    data[0] = enabled ? 1 : 2;
    await this.call(Feature.RGB_EFFECTS, RgbEffects.NV_CONFIG, RgbEffects.encodeSetNv(RgbEffects.STARTUP_EFFECT, data));
  }
}
