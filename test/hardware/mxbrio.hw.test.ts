// Real-hardware verification for the MX Brio. Run with:  npm run test:hardware:camera
// Every control is read first; each test changes settings, checks them with an independent raw
// read of the control, and the end puts everything back and compares control by control.
// Quit G Hub first (and Logi Options+ / Logi Tune if they manage the camera): they write their own
// settings when they see the camera. The restart test toggles the microphones twice, so the camera
// leaves USB for a few seconds each time; set MXBRIO_HARDWARE_RESTART=0 to skip it.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MxBrio } from '../../src/camera/mxbrio.js';
import { CameraService } from '../../src/camera/service.js';
import { SETTINGS, SETTING_KEYS, toRaw, type CameraSettings, type SettingKey } from '../../src/camera/settings.js';
import { CameraStore } from '../../src/camera/store.js';
import { findCamera, openCamera, type CameraTransport } from '../../src/camera/transport.js';
import { CONTROLS, type ControlName } from '../../src/camera/uvc.js';

const enabled = process.env.MXBRIO_HARDWARE === '1';
const restartTest = process.env.MXBRIO_HARDWARE_RESTART !== '0';
let transport: CameraTransport;
let camera: MxBrio;
let svc: CameraService;
let before: CameraSettings;
let beforeMic = false;
const rawBefore = new Map<ControlName, number>();
const store = new CameraStore(join(mkdtempSync(join(tmpdir(), 'mxbrio-hw-')), 'mx-brio.json'));

const raw = (name: ControlName) => transport.read(CONTROLS[name]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  transport = await openCamera();
  camera = new MxBrio(transport);
  svc = new CameraService(camera, store);
}

/** Wait for the camera to leave USB and come back (after the microphone switch), then reopen it. */
async function reconnectAfterRestart() {
  camera.close();
  // It takes a moment to go: wait until it is gone, so we don't reopen it just before it restarts.
  const gone = Date.now() + 10000;
  while (Date.now() < gone && (await findCamera().catch(() => undefined))) await sleep(200);
  // macOS can drop it from the device list a moment before it really restarts; it is back about a
  // second after it really left.
  await sleep(1500);
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (await findCamera().catch(() => undefined)) {
      try {
        await connect();
        await camera.readSettings();
        return;
      } catch {
        // not ready yet
      }
    }
    await sleep(500);
  }
  throw new Error('the camera did not come back within 30 s');
}

/** A value other than the current one, inside G Hub's range. */
function another(key: SettingKey, value: CameraSettings[SettingKey]): CameraSettings[SettingKey] {
  const spec = SETTINGS[key];
  if (spec.kind === 'boolean') return !value;
  if (spec.kind === 'choice') return spec.choices!.find((c) => c !== value) as never;
  const step = spec.step!;
  return ((value as number) + step <= spec.max! ? (value as number) + step * (key === 'whiteBalance' ? 500 : key === 'zoom' ? 50 : 1) : (value as number) - step) as never;
}

describe.skipIf(!enabled)('MX Brio hardware', { timeout: 60000 }, () => {
  beforeAll(async () => {
    await connect();
    before = await camera.readSettings();
    beforeMic = await camera.microphone();
    for (const name of Object.keys(CONTROLS) as ControlName[]) rawBefore.set(name, await raw(name));
  });

  afterAll(async () => {
    if (!camera) return;
    if ((await camera.microphone().catch(() => beforeMic)) !== beforeMic) {
      await camera.setMicrophone(beforeMic);
      await reconnectAfterRestart();
    }
    await svc.apply({ type: 'set', settings: before });
    // Manual values the camera holds while in auto (G Hub puts them back when it switches to manual).
    const after = new Map<ControlName, number>();
    for (const name of Object.keys(CONTROLS) as ControlName[]) after.set(name, await raw(name));
    const gated = new Set(SETTING_KEYS.filter((k) => SETTINGS[k].auto && before[SETTINGS[k].auto!] === true).map((k) => SETTINGS[k].control));
    const differ = [...rawBefore].filter(([name, v]) => !gated.has(name) && after.get(name) !== v);
    camera.close();
    expect(differ).toEqual([]);
  }, 90000);

  it('reads the firmware version and serial number', async () => {
    const info = await camera.info();
    expect(info.firmware).toMatch(/^\d+\.\d+\.\d+$/);
    expect(info.serial).toMatch(/^[0-9A-Z]{8,}$/);
  });

  it('writes every setting with the bytes G Hub writes, and reads it back', async () => {
    // Manual modes first, so the manual values take; framing needs zoom for pan and tilt to matter.
    await svc.apply({ type: 'set', settings: { autoExposure: false, autoWhiteBalance: false, autoFocus: false, zoom: 200 } });
    const now = await camera.readSettings();
    for (const key of SETTING_KEYS.filter((k) => !SETTINGS[k].auto && !['autoExposure', 'autoWhiteBalance', 'autoFocus', 'zoom'].includes(k)).concat(['shutter', 'whiteBalance', 'focus'])) {
      const value = another(key, now[key]);
      await svc.apply({ type: 'set', settings: { [key]: value } });
      expect(await raw(SETTINGS[key].control), key).toBe(toRaw(key, value as never));
      expect((await camera.readSettings())[key], key).toBe(value);
    }
  });

  it('refuses a manual shutter speed in auto exposure (so the app writes the mode first)', async () => {
    await svc.apply({ type: 'set', settings: { autoExposure: true } });
    await expect(transport.write(CONTROLS.exposureTime, 312)).rejects.toThrow(/refused/);
    await svc.apply({ type: 'set', settings: { autoExposure: false, shutter: 30 } });
    expect(await raw('exposureTime')).toBe(312);
  });

  it('applies G Hub’s presets', async () => {
    await svc.apply({ type: 'preset', group: 'crop', name: 'FOV 65°' });
    await svc.apply({ type: 'preset', group: 'image', name: 'Cooler' });
    expect(await raw('fov')).toBe(2);
    expect(await raw('temperatureCompensation')).toBe(40);
    const s = await svc.snapshot();
    expect(s.presets.filter((p) => p.matches && (p.group === 'crop' || p.group === 'image')).map((p) => p.name)).toEqual(['FOV 65°', 'Cooler']);
  });

  it.skipIf(!restartTest)('puts back the framing the camera forgets when it restarts', async () => {
    await svc.apply({ type: 'set', settings: { fov: 78, zoom: 150, pan: 7200, tilt: -3600, autoExposure: false, shutter: 120 } });
    await camera.setMicrophone(!beforeMic);
    await reconnectAfterRestart();
    expect(await camera.microphone()).toBe(!beforeMic);
    expect(await raw('zoom')).toBe(100);
    const put = await svc.restore();
    expect(put).toMatchObject({ fov: 78, zoom: 150, pan: 7200, tilt: -3600 });
    expect(await raw('zoom')).toBe(150);
    expect(await raw('fov')).toBe(1);
    expect(await svc.restore()).toEqual({});
    await camera.setMicrophone(beforeMic);
    await reconnectAfterRestart();
    expect(await camera.microphone()).toBe(beforeMic);
  }, 120000);
});
