// HID++ probe for Logitech Lightspeed receivers (046d:c547 and friends). Opens the 0xFF00
// interface non-exclusively, so G Hub can keep running.
//
//   node tools/re/hidpp.mjs features [devIdx]       ping + dump the HID++ 2.0 feature table
//   node tools/re/hidpp.mjs send <hex>...            send long reports (bytes after the 0x11 id)
//                                                    e.g. "01 00 1b 00 01" = dev 1, root.getFeature(0x0001)
//   node tools/re/hidpp.mjs sniff [seconds]          print every HID++ input report
//
// Requests use software id 0xB so replies to G Hub (which uses other ids) are easy to tell apart.
import HID from 'node-hid';

const NAMES = {
  0x0000: 'Root', 0x0001: 'FeatureSet', 0x0002: 'FeatureInfo', 0x0003: 'DeviceFwVersion',
  0x0004: 'DeviceUnitId', 0x0005: 'DeviceName', 0x0007: 'DeviceFriendlyName', 0x0008: 'KeepAlive',
  0x0011: 'PropertyAccess', 0x0020: 'ConfigChange', 0x0021: 'CryptoId', 0x00c2: 'DfuControlSigned',
  0x00c3: 'DfuControlSigned2', 0x00d0: 'Dfu', 0x1000: 'BatteryStatus', 0x1001: 'BatteryVoltage',
  0x1004: 'UnifiedBattery', 0x1300: 'LedControl', 0x1802: 'DeviceReset', 0x1803: 'GpioAccess',
  0x1806: 'ConfigurableDeviceProperties', 0x1811: 'Oob', 0x1814: 'ChangeHost', 0x1815: 'HostsInfo',
  0x1830: 'PowerModes', 0x1891: 'InternalTestsMode', 0x18a1: 'LedTest', 0x18b1: 'MonitorMode',
  0x1981: 'BacklightLegacy', 0x1982: 'Backlight2', 0x1b04: 'ReprogControlsV4', 0x1d4b: 'WirelessDeviceStatus',
  0x1df3: 'EquadDjDebugInfo', 0x1e00: 'EnableHiddenFeatures', 0x1e02: 'ManageDeactivatableFeatures',
  0x1e22: 'SpiDirectAccess', 0x1eb0: 'TdeAccess', 0x1f1f: 'FirmwareProperties', 0x1f20: 'AdcMeasurement',
  0x2100: 'VerticalScrolling', 0x2110: 'SmartShift', 0x2111: 'SmartShiftEnhanced', 0x2120: 'HiResScrolling',
  0x2121: 'HiResWheel', 0x2130: 'LowResWheel', 0x2150: 'Thumbwheel', 0x2200: 'MousePointer',
  0x2201: 'AdjustableDpi', 0x2202: 'ExtendedAdjustableDpi', 0x2205: 'PointerMotionScaling',
  0x2230: 'AngleSnapping', 0x2240: 'SurfaceTuning', 0x2250: 'XyStats', 0x2251: 'WheelStats',
  0x2400: 'HybridTracking', 0x40a0: 'FnInversion', 0x40a2: 'NewFnInversion', 0x40a3: 'K375sFnInversion',
  0x4100: 'Encryption', 0x4220: 'LockKeyState', 0x4301: 'SolarDashboard', 0x4520: 'KeyboardLayout',
  0x4521: 'DisableKeys', 0x4522: 'DisableKeysByUsage', 0x4530: 'DualPlatform', 0x4531: 'MultiPlatform',
  0x4540: 'KeyboardInternationalLayouts', 0x4600: 'Crown', 0x6010: 'TouchpadFwItems',
  0x6011: 'TouchpadSwItems', 0x6012: 'TouchpadWin8FwItems', 0x6020: 'TapEnable', 0x6021: 'TapEnableExtended',
  0x6030: 'CursorBallistic', 0x6040: 'TouchpadResolution', 0x6100: 'TouchpadRawXy', 0x6110: 'TouchmouseRawPoints',
  0x6120: 'Touchmouse6120', 0x6500: 'Gesture', 0x6501: 'Gestures2', 0x8010: 'GKey', 0x8020: 'MKeys',
  0x8030: 'MR', 0x8040: 'BrightnessControl', 0x8060: 'ReportRate', 0x8061: 'ExtendedReportRate',
  0x8070: 'ColorLedEffects', 0x8071: 'RgbEffects', 0x8080: 'PerKeyLighting', 0x8081: 'PerKeyLightingV2',
  0x8090: 'ModeStatus', 0x8100: 'OnboardProfiles', 0x8110: 'MouseButtonSpy', 0x8111: 'LatencyMonitoring',
  0x8120: 'GamingAttachments', 0x8123: 'ForceFeedback', 0x8300: 'Sidetone', 0x8310: 'Equalizer',
  0x8320: 'HeadsetOut',
};
export const featureName = (id) => NAMES[id] ?? `0x${id.toString(16).padStart(4, '0')}`;

const info = HID.devices().find((d) => d.vendorId === 0x046d && d.usagePage === 0xff00 && d.usage === 0x02);
if (!info) throw new Error('no Logitech HID++ receiver interface (usage page 0xFF00) found');
const dev = new HID.HID(info.path, { nonExclusive: true });
const hex = (a) => [...a].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waiters = [];
dev.on('data', (b) => {
  const r = [...b];
  if (process.env.VERBOSE || mode === 'sniff' || mode === 'send') console.log(`${new Date().toISOString().slice(11, 23)}  IN  ${hex(r)}`);
  for (const w of [...waiters]) if (w.match(r)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(r); }
});

/** Like request1, but waits out the receiver's "unknown device" error (08) while the mouse sleeps. */
export async function request(devIdx, feat, fn, params = [], swid = 0x0b, timeout = 1500) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request1(devIdx, feat, fn, params, swid, timeout);
    } catch (e) {
      if (!/ 8f .. .. 08/.test(e.message) || attempt > 60) throw e;
      if (attempt === 0) console.error('mouse is asleep; move it to wake it up');
      await sleep(1000);
    }
  }
}

/** Send one long HID++ 2.0 request and wait for the matching reply (or a HID++ error). */
async function request1(devIdx, feat, fn, params = [], swid = 0x0b, timeout = 1500) {
  const pkt = [0x11, devIdx, feat, (fn << 4) | swid, ...params];
  while (pkt.length < 20) pkt.push(0);
  const p = new Promise((resolve, reject) => {
    const w = {
      match: (r) => r[1] === devIdx && ((r[2] === feat && r[3] === pkt[3]) || (r[2] === 0xff && r[3] === feat && r[4] === pkt[3]) || (r[0] === 0x10 && r[2] === 0x8f && r[3] === feat)),
      resolve: (r) => { clearTimeout(t); (r[2] === 0xff || r[2] === 0x8f) ? reject(new Error(`HID++ error ${hex(r.slice(0, 7))}`)) : resolve(r.slice(4)); },
    };
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timeout: ${hex(pkt.slice(0, 8))}`)); }, timeout);
    waiters.push(w);
  });
  dev.write(pkt);
  return p;
}

const [mode = 'features', ...args] = process.argv.slice(2);
try {
  if (mode === 'features') {
    const d = parseInt(args[0] ?? '1', 16);
    const ping = await request(d, 0x00, 1, [0, 0, 0x5a]);
    console.log(`device ${d}: HID++ ${ping[0]}.${ping[1]}`);
    const fsIdx = (await request(d, 0x00, 0, [0x00, 0x01]))[0];
    const count = (await request(d, fsIdx, 0, []))[0];
    console.log(`FeatureSet at index ${fsIdx}, ${count + 1} features (incl. root)`);
    console.log('idx  id      flags ver  name');
    console.log(`  0  0x0000  00    -    Root`);
    for (let i = 1; i <= count; i++) {
      const r = await request(d, fsIdx, 1, [i]);
      const id = (r[0] << 8) | r[1];
      console.log(`${String(i).padStart(3)}  0x${id.toString(16).padStart(4, '0')}  ${r[2].toString(16).padStart(2, '0')}    ${String(r[3]).padEnd(3)}  ${featureName(id)}`);
    }
  } else if (mode === 'send') {
    for (const s of args) {
      const b = s.trim().split(/\s+/).map((x) => parseInt(x, 16));
      const pkt = [0x11, ...b];
      while (pkt.length < 20) pkt.push(0);
      console.log(`${new Date().toISOString().slice(11, 23)}  OUT ${hex(pkt)}`);
      dev.write(pkt);
      await sleep(300);
    }
    await sleep(300);
  } else if (mode === 'dump') {
    // dump <featIdx of 0x8100> <sector>... : read whole onboard-memory sectors (read-only)
    const [fi, ...sectors] = args.map((x) => parseInt(x, 16));
    const desc = await request(1, fi, 0);
    const size = (desc[7] << 8) | desc[8];
    for (const s of sectors) {
      const bytes = [];
      try {
        for (let off = 0; off < size; off += 16) {
          const o = Math.min(off, size - 16);
          const r = await request(1, fi, 5, [s >> 8, s & 0xff, o >> 8, o & 0xff]);
          bytes.splice(o, 16, ...r.slice(0, 16));
        }
        console.log(`sector ${s.toString(16).padStart(4, '0')}:`);
        for (let i = 0; i < size; i += 16) console.log(`  ${i.toString(16).padStart(3, '0')}  ${hex(bytes.slice(i, i + 16))}`);
      } catch (e) {
        console.log(`sector ${s.toString(16).padStart(4, '0')}: ${e.message}`);
      }
    }
  } else if (mode === 'sniff') {
    await sleep(Number(args[0] ?? 30) * 1000);
  }
} finally {
  dev.close();
}
