import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/camera/cli.js';
import { MxBrio } from '../../src/camera/mxbrio.js';
import { CameraService } from '../../src/camera/service.js';
import { DEFAULTS } from '../../src/camera/settings.js';
import { CameraStore } from '../../src/camera/store.js';
import { RawCameraTransport } from '../../src/camera/transport.js';
import { GHUB_WRITES } from '../fixtures/mx-brio.js';
import { SimulatedMxBrio } from './simulated-mxbrio.js';

// The CLI keeps settings in a file; never touch the real one from tests.
process.env.MXBRIO_CONFIG = join(mkdtempSync(join(tmpdir(), 'mxbrio-cli-')), 'mx-brio.json');
const tempStore = () => new CameraStore(join(mkdtempSync(join(tmpdir(), 'mxbrio-')), 'mx-brio.json'));

async function setup(sim = new SimulatedMxBrio(), store = tempStore()) {
  const camera = new MxBrio(await RawCameraTransport.open(sim));
  return { sim, camera, store, svc: new CameraService(camera, store) };
}

/** Accepted writes since `from`, as "unit:selector=hex". */
const writes = (sim: SimulatedMxBrio, from = 0) => sim.written.slice(from);

describe('reading', () => {
  it('shows the camera, its settings (G Hub’s defaults on this one) and the presets that match', async () => {
    const { svc } = await setup();
    const s = await svc.snapshot();
    expect(s.device).toEqual({ model: 'MX Brio', serial: '123456789012', firmware: '1.1.394' });
    // In auto white balance the temperature control holds whatever the camera last had (4679 K in the capture).
    expect(s.settings).toEqual({ ...DEFAULTS, focus: 0, whiteBalance: 4679 });
    expect(s.microphone).toBe(false);
    expect(s.presets.filter((p) => p.matches).map((p) => `${p.group}/${p.name}`)).toEqual(['crop/Default', 'exposure/Default', 'image/Default', 'focus/Default']);
    expect(s.custom).toEqual([]);
    expect(s.saved).toEqual({});
  });
});

describe('writing what G Hub writes', () => {
  for (const { change, from, controls } of GHUB_WRITES) {
    it(JSON.stringify(change), async () => {
      const { sim, svc } = await setup();
      if (from) await svc.apply({ type: 'set', settings: from as never });
      const n = sim.written.length;
      await svc.apply({ type: 'set', settings: change as never });
      // Every control G Hub changed, with G Hub's bytes; mirrors the camera keeps itself are not ours to write.
      const ours = Object.fromEntries(writes(sim, n).map((w) => w.split('=')));
      expect(ours).toEqual(controls);
    });
  }
});

describe('auto modes', () => {
  it('switches to manual before writing a manual value, which the camera refuses in auto', async () => {
    const { sim, svc } = await setup();
    await svc.apply({ type: 'set', settings: { shutter: 120, autoExposure: false } });
    expect(writes(sim)).toEqual(['1:2=01', '1:4=4e000000']);
  });

  it('only saves a manual value while auto stays on', async () => {
    const { sim, svc } = await setup();
    await svc.apply({ type: 'set', settings: { focus: 30 } });
    expect(writes(sim)).toEqual([]);
    expect((await svc.snapshot()).saved).toEqual({ focus: 30 });
  });

  it('names the setting when the camera refuses a write', async () => {
    const { sim, svc } = await setup();
    sim.poke('3:11', '00');
    sim.controls.get('3:10')!.info = 1; // pretend white balance is read-only
    await expect(svc.apply({ type: 'set', settings: { whiteBalance: 4000, autoWhiteBalance: false } })).rejects.toThrow(/^White balance: the camera refused/);
  });

  it('checks values before writing anything', async () => {
    const { sim, svc } = await setup();
    await expect(svc.apply({ type: 'set', settings: { brightness: 100, zoom: 900 } })).rejects.toThrow(/Zoom must be a whole number from 100 to 400/);
    await expect(svc.apply({ type: 'set', settings: { sparkle: 1 } as never })).rejects.toThrow(/unknown setting "sparkle"/);
    expect(writes(sim)).toEqual([]);
  });
});

describe('presets and reset', () => {
  it('applies G Hub’s presets', async () => {
    const { sim, svc } = await setup();
    await svc.apply({ type: 'preset', group: 'image', name: 'Black and White' });
    expect(writes(sim)).toEqual(['3:7=0000']);
    await svc.apply({ type: 'preset', group: 'crop', name: 'Zoom 2×' });
    expect(sim.cur('1:11')).toBe('c800');
    const s = await svc.snapshot();
    expect(s.presets.filter((p) => p.matches).map((p) => p.name)).toEqual(['Zoom 2×', 'Default', 'Black and White', 'Default']);
  });

  it('saves yours as the whole camera, which then match, come back in one go and can be deleted', async () => {
    const { svc, store } = await setup();
    await svc.apply({ type: 'set', settings: { fov: 78, zoom: 150, tilt: -7200, autoExposure: false, shutter: 120, iso: 400, brightness: 90, autoFocus: false, focus: 40, antiFlicker: 50 } });
    await svc.apply({ type: 'savePreset', name: ' Desk at night ' });
    const [saved] = (await store.read()).presets;
    expect(saved.name).toBe('Desk at night');
    // Framing, exposure, colour and focus: everything but anti-flicker.
    expect(Object.keys(saved.settings).sort()).toEqual(Object.keys(DEFAULTS).filter((k) => k !== 'antiFlicker').sort());
    expect(saved.settings).toMatchObject({ fov: 78, zoom: 150, tilt: -7200, autoExposure: false, shutter: 120, iso: 400, brightness: 90, autoFocus: false, focus: 40 });
    expect((await svc.snapshot()).custom).toEqual([{ name: 'Desk at night', matches: true }]);

    await svc.apply({ type: 'reset', group: 'all' });
    expect((await svc.snapshot()).custom).toEqual([{ name: 'Desk at night', matches: false }]);
    await svc.apply({ type: 'customPreset', name: 'desk at night' });
    const s = await svc.snapshot();
    expect(s.custom).toEqual([{ name: 'Desk at night', matches: true }]);
    expect(s.settings).toMatchObject({ fov: 78, zoom: 150, shutter: 120, brightness: 90, focus: 40, antiFlicker: 60 });

    // The same name, in any case, replaces it in place.
    await svc.apply({ type: 'set', settings: { brightness: 100 } });
    await svc.apply({ type: 'savePreset', name: 'Daylight' });
    await svc.apply({ type: 'savePreset', name: 'DESK AT NIGHT' });
    expect((await store.read()).presets.map((p) => [p.name, p.settings.brightness])).toEqual([['DESK AT NIGHT', 100], ['Daylight', 100]]);
    expect((await svc.snapshot()).custom.map((p) => p.matches)).toEqual([true, true]);

    await svc.apply({ type: 'deletePreset', name: 'daylight' });
    expect((await store.read()).presets.map((p) => p.name)).toEqual(['DESK AT NIGHT']);
    await expect(svc.apply({ type: 'deletePreset', name: 'Daylight' })).rejects.toThrow(/no preset called "Daylight"/);
    await expect(svc.apply({ type: 'customPreset', name: 'Daylight' })).rejects.toThrow(/no preset called "Daylight"/);
    await expect(svc.apply({ type: 'savePreset', name: '  ' })).rejects.toThrow(/needs a name/);
  });

  it('matches a preset in auto exposure whatever ISO the camera reads', async () => {
    const { svc } = await setup();
    await svc.apply({ type: 'savePreset', name: 'Auto' });
    await svc.apply({ type: 'set', settings: { iso: 800 } });
    expect((await svc.snapshot()).custom).toEqual([{ name: 'Auto', matches: true }]);
  });

  it('keeps presets saved by 1.4, one tab each, merging tabs saved under the same name', async () => {
    const store = tempStore();
    writeFileSync(store.file, JSON.stringify({ version: 1, cameras: {}, presets: [
      { group: 'crop', name: 'Main', settings: { fov: 78, zoom: 100, pan: 0, tilt: 0, showMode: true } },
      { group: 'image', name: 'Warm', settings: { temperatureCompensation: 70 } },
      { group: 'image', name: 'main', settings: { saturation: 90 } },
      { group: 'crop', name: ' ', settings: { fov: 65 } },
    ] }));
    expect((await store.read()).presets).toEqual([
      { name: 'Main', settings: { fov: 78, zoom: 100, pan: 0, tilt: 0, showMode: true, saturation: 90 } },
      { name: 'Warm', settings: { temperatureCompensation: 70 } },
    ]);
    const { sim, svc } = await setup(undefined, store);
    await svc.apply({ type: 'customPreset', name: 'Main' });
    expect(sim.cur('10:5')).toBe('01'); // 78°
    const s = await svc.snapshot();
    expect(s.settings).toMatchObject({ fov: 78, saturation: 90, brightness: 128 });
    expect(s.custom).toEqual([{ name: 'Main', matches: true }, { name: 'Warm', matches: false }]);
  });

  it('resets one tab to G Hub’s defaults, leaving the others', async () => {
    const { sim, svc } = await setup();
    await svc.apply({ type: 'set', settings: { fov: 65, zoom: 200, brightness: 50 } });
    await svc.apply({ type: 'reset', group: 'crop' });
    expect(sim.cur('10:5')).toBe('00');
    expect(sim.cur('1:11')).toBe('6400');
    expect(sim.cur('3:2')).toBe('3200');
  });
});

describe('keeping settings', () => {
  it('saves what you change, per camera', async () => {
    const { svc, store } = await setup();
    await svc.apply({ type: 'set', settings: { fov: 78, zoom: 150 } });
    await svc.apply({ type: 'set', settings: { zoom: 120 } });
    expect((await store.read()).cameras).toEqual({ '123456789012': { fov: 78, zoom: 120 } });
  });

  it('puts back what the camera forgot when it restarted, and nothing else', async () => {
    const sim = new SimulatedMxBrio();
    const store = tempStore();
    const first = await setup(sim, store);
    await first.svc.apply({ type: 'set', settings: { fov: 78, zoom: 150, pan: 7200, brightness: 90, autoExposure: false, shutter: 120 } });
    // Turning the microphones on restarts the camera: the connection drops.
    await first.svc.apply({ type: 'microphone', enabled: true });
    expect(sim.restarts).toBe(1);
    await expect(first.svc.snapshot()).rejects.toThrow(/disconnected/);
    expect(sim.cur('1:11')).toBe('6400');

    const again = await setup(sim.reconnect(), store);
    const n = sim.written.length;
    expect(await again.svc.restore()).toEqual({ fov: 78, zoom: 150, pan: 7200, autoExposure: false });
    expect(writes(sim, n)).toEqual(['1:2=01', '10:5=01', '1:11=9600', '1:13=201c000000000000']);
    expect(await again.svc.restore()).toEqual({});
    expect((await again.svc.snapshot()).microphone).toBe(true);
  });

  it('writes nothing for a camera with nothing kept, and stops after "forget"', async () => {
    const { sim, svc } = await setup();
    expect(await svc.restore()).toEqual({});
    await svc.apply({ type: 'set', settings: { zoom: 200 } });
    await svc.apply({ type: 'forget' });
    sim.poke('1:11', '6400');
    expect(await svc.restore()).toEqual({});
    expect(sim.cur('1:11')).toBe('6400');
  });

  it('ignores settings a hand-edited file got wrong', async () => {
    const store = tempStore();
    await store.update((c) => {
      c.cameras['123456789012'] = { zoom: 9000, fov: 78 } as never;
    });
    const { svc } = await setup(undefined, store);
    expect(await svc.restore()).toEqual({ fov: 78 });
  });
});

describe('librehub camera', () => {
  const run = async (sim: SimulatedMxBrio, ...args: string[]) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runCli(args, () => RawCameraTransport.open(sim.reconnect()));
      return log.mock.calls.map((c) => c.join(' ')).join('\n');
    } finally {
      log.mockRestore();
    }
  };

  it('sets several settings at once, in people’s units', async () => {
    const sim = new SimulatedMxBrio();
    await run(sim, 'set', 'auto-exposure', 'off', 'shutter', '1/120', 'iso', '400', 'tilt', '-2', 'zoom', '150');
    expect(sim.written).toEqual(['1:2=01', '1:4=4e000000', '3:4=3000', '1:13=00000000e0e3ffff', '1:11=9600']);
    expect(JSON.parse(readFileSync(process.env.MXBRIO_CONFIG!, 'utf8')).cameras['123456789012']).toEqual({ autoExposure: false, shutter: 120, iso: 400, tilt: -7200, zoom: 150 });
  });

  it('prints status, presets and what is kept', async () => {
    const sim = new SimulatedMxBrio();
    await run(sim, 'preset', 'image', 'Warmer');
    const out = await run(sim, 'status');
    expect(out).toMatch(/MX Brio {2}serial 123456789012 {2}firmware 1\.1\.394/);
    expect(out).toMatch(/Image {2}\(preset: Warmer\)/);
    expect(out).toMatch(/temperature-compensation\s+60/);
    expect(out).toMatch(/shutter\s+1\/60 s {2}\(auto\)/);
  });

  it('saves, lists, applies and deletes your presets', async () => {
    const sim = new SimulatedMxBrio();
    await run(sim, 'set', 'fov', '65', 'saturation', '0');
    await run(sim, 'preset', 'save', 'Desk', 'at', 'night');
    expect(await run(sim, 'status')).toMatch(/Your presets: Desk at night \(in use\)/);
    await run(sim, 'reset');
    expect(sim.cur('10:5')).toBe('00');
    await run(sim, 'preset', 'Desk at night');
    expect(sim.cur('10:5')).toBe('02');
    expect(sim.cur('3:7')).toBe('0000');
    // How 1.4 saved one tab: say how it works now rather than save "crop Desk".
    await expect(run(sim, 'preset', 'save', 'crop', 'Desk')).rejects.toThrow(/whole camera now: librehub camera preset save "Desk"/);
    await run(sim, 'preset', 'delete', 'desk at night');
    expect(await run(sim, 'status')).toMatch(/Your presets: none yet/);
  });

  it('turns the microphones on and off', async () => {
    const sim = new SimulatedMxBrio();
    expect(await run(sim, 'microphone', 'on')).toMatch(/restarts with its microphones on/);
    expect(sim.cur('11:16')).toBe('01');
  });

  it('rejects what it doesn’t know', async () => {
    const sim = new SimulatedMxBrio();
    await expect(run(sim, 'set', 'zoom')).rejects.toThrow(/pairs/);
    await expect(run(sim, 'set', 'glow', '1')).rejects.toThrow(/unknown setting "glow"/);
    await expect(run(sim, 'preset', 'sound', 'x')).rejects.toThrow(/no preset called "sound x"/);
    await expect(run(sim, 'preset', 'image', 'Sepia')).rejects.toThrow(/G Hub has no image preset called "Sepia"/);
  });
});
