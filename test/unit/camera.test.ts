import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSetting, matchesPreset, parseSetting, SETTINGS, CURATED_PRESETS, DEFAULTS, toRaw, writePlan, type CameraSettings, type SettingKey } from '../../src/camera/settings.js';
import { cleanSettings } from '../../src/camera/store.js';
import { drift } from '../../src/camera/service.js';
import { CONTROLS, decodeField, encodeField, fromHex, guidFromBytes, LOGITECH_XU, parseVideoControl, toHex, unitId } from '../../src/camera/uvc.js';
import { aeModeToMenu, findVideoNode, menuToAeMode, packXuQuery, uvcIocCtrlQuery, V4l2Camera, V4L2_CIDS, VIDIOC_G_CTRL, VIDIOC_QUERYCTRL, VIDIOC_S_CTRL, type Kernel } from '../../src/camera/v4l2.js';
import { CONFIG_DESCRIPTOR, GHUB_WRITES } from '../fixtures/mx-brio.js';

const layout = parseVideoControl(fromHex(CONFIG_DESCRIPTOR));
/** Unit ids on this camera, for turning "unit:selector" keys from the captures into controls. */
const UNIT_IDS: Record<string, number> = { camera: 1, processing: 3, videoPipe: 10, peripheral: 11, deviceInfo: 8 };

describe('UVC descriptor', () => {
  it('finds the Video Control interface, the camera terminal, the processing unit and Logitech’s units', () => {
    expect(layout.interfaceNumber).toBe(0);
    expect(layout.camera).toBe(1);
    expect(layout.processing).toBe(3);
    expect(unitId(layout, 'videoPipe')).toBe(10);
    expect(unitId(layout, 'peripheral')).toBe(11);
    expect(unitId(layout, 'deviceInfo')).toBe(8);
    expect(Object.keys(layout.extensions)).toHaveLength(8);
  });

  it('reads Linux’s sysfs descriptors file, which has the device descriptor first', () => {
    const device = fromHex('12010002ef020140' + '6d044409' + '2100' + '000102' + '01');
    const both = new Uint8Array([...device, ...fromHex(CONFIG_DESCRIPTOR)]);
    expect(parseVideoControl(both)).toEqual(layout);
  });

  it('prints GUIDs the way Windows and G Hub do (first three fields little-endian)', () => {
    const bytes = fromHex('1502e44934f4fe47b1580e885023e51b');
    expect(guidFromBytes(bytes)).toBe(LOGITECH_XU.videoPipe);
  });

  it('refuses a descriptor without a video function', () => {
    expect(() => parseVideoControl(fromHex('09020900010100a0fa'))).toThrow(/no USB Video Control/);
  });
});

describe('control fields', () => {
  it('reads and writes pan and tilt as signed halves of one control, keeping the other half', () => {
    const both = fromHex('100e0000e0e3ffff');
    expect(decodeField(CONTROLS.pan, both)).toBe(3600);
    expect(decodeField(CONTROLS.tilt, both)).toBe(-7200);
    expect(toHex(encodeField(CONTROLS.tilt, both, 72000))).toBe('100e000040190100');
    expect(toHex(encodeField(CONTROLS.pan, both, -72000))).toBe('c0e6feffe0e3ffff');
  });

  it('refuses fractions and short replies', () => {
    expect(() => encodeField(CONTROLS.zoom, new Uint8Array(2), 1.5)).toThrow(/whole number/);
    expect(() => decodeField(CONTROLS.exposureTime, new Uint8Array(2))).toThrow(/short reply/);
  });
});

describe('settings → bytes, as G Hub writes them', () => {
  for (const { change, controls } of GHUB_WRITES) {
    it(JSON.stringify(change), () => {
      for (const [k, v] of Object.entries(change)) {
        const spec = SETTINGS[k as SettingKey];
        const def = CONTROLS[spec.control];
        const key = `${UNIT_IDS[def.unit]}:${def.selector}`;
        const want = controls[key];
        expect(want, `G Hub changed ${key} for ${k}`).toBeDefined();
        const raw = toRaw(k as SettingKey, v as never);
        // Pan and tilt share a control: compare this setting's half.
        const start = (def.offset ?? 0) * 2;
        const got = toHex(encodeField(def, fromHex(want), raw)).slice(start, start + (def.size ?? def.length) * 2);
        expect(got).toBe(want.slice(start, start + (def.size ?? def.length) * 2));
        // And back.
        expect(spec.fromRaw(decodeField(def, fromHex(want)))).toBe(v);
      }
    });
  }

  it('shows a shutter speed or ISO another program set as the nearest of G Hub’s steps', () => {
    expect(SETTINGS.shutter.fromRaw(150)).toBe(60);
    expect(SETTINGS.iso.fromRaw(70)).toBe(500);
  });

  it('checks values against G Hub’s ranges and steps', () => {
    expect(() => toRaw('zoom', 99)).toThrow(/100 to 400/);
    expect(() => toRaw('pan', 1000)).toThrow(/steps of 3600/);
    expect(() => toRaw('fov', 80 as never)).toThrow(/65/);
    expect(() => toRaw('shutter', 100)).toThrow(/1\/2000/);
    expect(() => toRaw('hdr', 1 as never)).toThrow(/on or off/);
  });
});

describe('write order', () => {
  const current: CameraSettings = { ...DEFAULTS };

  it('switches auto exposure off before writing the shutter speed (the camera refuses it otherwise)', () => {
    expect(writePlan({ shutter: 120, autoExposure: false }, current).map((p) => p.key)).toEqual(['autoExposure', 'shutter']);
  });

  it('leaves out manual values while their auto mode stays on', () => {
    expect(writePlan({ shutter: 120, whiteBalance: 4000, focus: 30 }, current)).toEqual([]);
  });

  it('writes ISO in auto exposure too, as G Hub does', () => {
    expect(writePlan({ autoExposure: true, iso: 100 }, { ...current, autoExposure: false, iso: 300 })).toEqual([
      { key: 'autoExposure', raw: 8 },
      { key: 'iso', raw: 0 },
    ]);
  });

  it('only counts differences that matter as drift', () => {
    expect(drift({ zoom: 150, shutter: 120, brightness: 128 }, current)).toEqual({ zoom: 150 });
    expect(drift({ autoExposure: false, shutter: 120 }, current)).toEqual({ autoExposure: false, shutter: 120 });
  });
});

describe('presets', () => {
  it('has G Hub’s presets for this camera', () => {
    expect(CURATED_PRESETS.map((p) => `${p.group}/${p.name}`)).toEqual([
      'crop/Default', 'crop/FOV 78°', 'crop/FOV 65°', 'crop/Zoom 1.5×', 'crop/Zoom 2×',
      'exposure/Default', 'exposure/Streaming',
      'image/Default', 'image/Black and White', 'image/Warmer', 'image/Cooler',
      'focus/Default',
    ]);
  });

  it('matches regardless of values that don’t apply in auto mode', () => {
    const focus = CURATED_PRESETS.find((p) => p.group === 'focus')!;
    expect(matchesPreset({ ...DEFAULTS, focus: 0 }, focus)).toBe(true);
    expect(matchesPreset({ ...DEFAULTS, autoFocus: false }, focus)).toBe(false);
  });
});

describe('command-line values', () => {
  it.each([
    ['shutter', '1/120', 120],
    ['fov', '78°', 78],
    ['pan', '2', 7200],
    ['pan', '-7200', -7200],
    ['hdr', 'off', false],
    ['autoExposure', 'manual', false],
    ['priority', 'fps', 'frame-rate'],
    ['whiteBalance', '4000K', 4000],
    ['antiFlicker', '50hz', 50],
  ] as const)('%s %s', (key, text, value) => {
    expect(parseSetting(key, text)).toBe(value);
  });

  it('says what is wrong', () => {
    expect(() => parseSetting('zoom', 'big')).toThrow(/not a number/);
    expect(() => parseSetting('zoom', '500')).toThrow(/100 to 400/);
  });

  it('formats for people', () => {
    expect(formatSetting('shutter', 60)).toBe('1/60 s');
    expect(formatSetting('tilt', -7200)).toBe('-2°');
    expect(formatSetting('showMode', true)).toBe('on');
  });
});

describe('the settings file', () => {
  it('keeps known settings with valid values only', () => {
    expect(cleanSettings({ zoom: 150, fov: 80, brightness: 'x', bogus: 1, hdr: false })).toEqual({ zoom: 150, hdr: false });
    expect(cleanSettings(null)).toEqual({});
  });
});

// ------------------------------------------------------------------ Linux

/** A stand-in for uvcvideo: V4L2 controls by id, extension unit controls by unit:selector. */
function fakeKernel() {
  const ctrls = new Map<number, number>(Object.values(V4L2_CIDS).map((cid) => [cid, 0]));
  const xu = new Map<string, Uint8Array>([['10:5', Uint8Array.from([1])], ['8:7', new TextEncoder().encode('123456789012')]]);
  const calls: string[] = [];
  const kernel: Kernel = {
    ioctl(fd, request, arg) {
      const id = arg.readUInt32LE(0);
      calls.push(`${request.toString(16)} ${id.toString(16)}`);
      if (!ctrls.has(id)) throw Object.assign(new Error('EINVAL'), { errno: 22 });
      if (request === VIDIOC_G_CTRL) arg.writeInt32LE(ctrls.get(id)!, 4);
      else if (request === VIDIOC_S_CTRL) ctrls.set(id, arg.readInt32LE(4));
      else if (request === VIDIOC_QUERYCTRL) {
        arg.writeInt32LE(-72000, 40);
        arg.writeInt32LE(72000, 44);
        arg.writeInt32LE(3600, 48);
        arg.writeInt32LE(0, 52);
      }
    },
    xuQuery(fd, unit, selector, query, data) {
      const key = `${unit}:${selector}`;
      calls.push(`xu ${query.toString(16)} ${key} ${toHex(data)}`);
      const v = xu.get(key) ?? new Uint8Array(data.length);
      if (query === 0x01) xu.set(key, data.slice());
      else if (query === 0x85) data.set([v.length, 0]);
      else data.set(v.subarray(0, data.length));
    },
  };
  return { kernel, ctrls, xu, calls };
}

describe('Linux (V4L2 and uvcvideo)', () => {
  it('computes the ioctl numbers the kernel headers define', () => {
    expect(VIDIOC_G_CTRL).toBe(0xc008561b);
    expect(VIDIOC_S_CTRL).toBe(0xc008561c);
    expect(VIDIOC_QUERYCTRL).toBe(0xc0445624);
    expect(uvcIocCtrlQuery(8)).toBe(0xc0107521);
    expect(uvcIocCtrlQuery(4)).toBe(0xc00c7521);
  });

  it('packs struct uvc_xu_control_query with its padding', () => {
    expect(toHex(packXuQuery(10, 5, 0x81, 1, 0x1122334455667788n))).toBe('0a058100010000008877665544332211');
    expect(toHex(packXuQuery(10, 5, 0x81, 1, 0x11223344n, 4))).toBe('0a0581000100000044332211');
  });

  it('maps auto exposure between uvcvideo’s menu and UVC’s mode bits', () => {
    expect(menuToAeMode(3)).toBe(8);
    expect(aeModeToMenu(1)).toBe(1);
    expect(() => aeModeToMenu(3)).toThrow();
  });

  it('reads and writes standard controls as V4L2 controls, and Logitech’s through UVCIOC_CTRL_QUERY', async () => {
    const k = fakeKernel();
    const cam = new V4l2Camera(3, layout, k.kernel);
    k.ctrls.set(V4L2_CIDS['processing:2'], 100);
    k.ctrls.set(V4L2_CIDS['camera:2'], 3);
    expect(await cam.read(CONTROLS.brightness)).toBe(100);
    expect(await cam.read(CONTROLS.aeMode)).toBe(8);
    await cam.write(CONTROLS.aeMode, 1);
    expect(k.ctrls.get(V4L2_CIDS['camera:2'])).toBe(1);
    await cam.write(CONTROLS.tilt, -7200);
    expect(k.ctrls.get(V4L2_CIDS['camera:13:4'])).toBe(-7200);
    expect(await cam.read(CONTROLS.pan, 'max')).toBe(72000);
    expect(await cam.read(CONTROLS.fov)).toBe(1);
    await cam.write(CONTROLS.fov, 2);
    expect(k.calls).toContain('xu 1 10:5 02');
    expect(new TextDecoder().decode(await cam.readBytes('deviceInfo', 7))).toBe('123456789012');
  });

  it('finds the camera’s capture node in sysfs, not its metadata node', () => {
    const root = mkdtempSync(join(tmpdir(), 'v4l-'));
    const usb = join(root, 'devices', '1-2');
    for (const [n, intf] of [['video0', '1-2:1.0'], ['video1', '1-2:1.0']]) {
      mkdirSync(join(usb, intf), { recursive: true });
      mkdirSync(join(root, 'class', n), { recursive: true });
      symlinkSync(join(usb, intf), join(root, 'class', n, 'device'));
      writeFileSync(join(root, 'class', n, 'index'), n === 'video0' ? '1\n' : '0\n');
    }
    writeFileSync(join(usb, 'idVendor'), '046d\n');
    writeFileSync(join(usb, 'idProduct'), '0944\n');
    expect(findVideoNode(join(root, 'class'))).toEqual({ path: '/dev/video1', usbDir: realpathSync(usb) });
    writeFileSync(join(usb, 'idProduct'), '085e\n');
    expect(findVideoNode(join(root, 'class'))).toBeUndefined();
  });
});
