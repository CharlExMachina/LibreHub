import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AudioSplit, CONF_FILE, SCRIPT_FILE, defaultProfile, parsePwDump, parseWirePlumberVersion } from '../../src/audio/split.js';

const ASSETS = join(import.meta.dirname, '..', '..', 'linux', 'wireplumber');
const SPLIT = await readFile(join(import.meta.dirname, '..', 'fixtures', 'pw-dump-split.json'), 'utf8');

/** The same system with the card on its normal analog profile (what PipeWire picks by default). */
function analogDump(): string {
  const objects = JSON.parse(SPLIT);
  const out = [];
  for (const o of objects) {
    if (o.type.endsWith('Device')) o.info.params.Profile = [{ index: 1, name: 'output:analog-stereo+input:mono-fallback' }];
    if (o.type.endsWith('Node') && String(o.info.props['node.name']).includes('A50_X')) {
      const n = o.info.props['node.name'] as string;
      if (n.endsWith('pro-output-0')) o.info.props['node.name'] = n.replace('pro-output-0', 'analog-stereo');
      else if (n.endsWith('pro-input-0')) o.info.props['node.name'] = n.replace('pro-input-0', 'mono-fallback');
      else continue;
    }
    if (o.type.endsWith('Metadata')) o.metadata = [{ subject: 0, key: 'default.audio.sink', type: 'Spa:String:JSON', value: { name: 'alsa_output.usb-Logitech_A50_X-00.analog-stereo' } }];
    out.push(o);
  }
  return JSON.stringify(out);
}

/** A fake PipeWire/WirePlumber that reacts to the installed files and to wpctl, like the real one. */
async function fakeSystem({ savedProfile = null as string | null, version = '0.5.18' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'a50x-audio-'));
  const env = { HOME: home };
  const calls: string[] = [];
  let profile = 'output:analog-stereo+input:mono-fallback';
  // node id -> volume; the analog output (id 50 in the analog dump) starts at 40%
  const volumes = new Map<number, number>([[50, 0.4]]);
  const exists = (p: string) => stat(p).then(() => true, () => false);
  const split = new AudioSplit({
    assetsDir: ASSETS,
    env,
    sleep: async () => {},
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'wireplumber') return `wireplumber\nCompiled with libwireplumber ${version}\nLinked with libwireplumber ${version}\n`;
      if (cmd === 'pw-dump') return profile === 'pro-audio' ? SPLIT : analogDump();
      if (cmd === 'systemctl') {
        // On restart WirePlumber applies the rule, unless the user saved a different profile earlier.
        const ruleInstalled = await exists(split.paths.conf);
        profile = savedProfile ?? (ruleInstalled ? 'pro-audio' : 'output:analog-stereo+input:mono-fallback');
        return '';
      }
      if (cmd === 'wpctl' && args[0] === 'get-volume') return `Volume: ${volumes.get(Number(args[1])) ?? 1}\n`;
      if (cmd === 'wpctl' && args[0] === 'set-volume') {
        volumes.set(Number(args[1]), Number(args[2]));
        return '';
      }
      if (cmd === 'wpctl' && args[0] === 'set-profile') {
        profile = Number(args[2]) === 7 ? 'pro-audio' : 'output:analog-stereo+input:mono-fallback';
        savedProfile = profile;
        return '';
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  });
  return { split, calls, home, volumes };
}

describe('pw-dump parsing', () => {
  it('finds the split card, its nodes and the default output', () => {
    const { card, defaultSink } = parsePwDump(SPLIT);
    expect(card?.profile).toBe('pro-audio');
    expect(card?.nodes).toEqual({
      game: 'alsa_output.usb-Logitech_A50_X-00.pro-output-1',
      voice: 'alsa_output.usb-Logitech_A50_X-00.pro-output-0',
      mic: 'alsa_input.usb-Logitech_A50_X-00.pro-input-0',
      streamOut: 'alsa_input.usb-Logitech_A50_X-00.pro-input-1',
    });
    expect(defaultSink).toBe(card?.nodes.game);
  });

  it('picks the normal profile to go back to', () => {
    const { card } = parsePwDump(SPLIT);
    expect(defaultProfile(card!)).toEqual(expect.objectContaining({ index: 1, name: 'output:analog-stereo+input:mono-fallback' }));
  });

  it('reads the WirePlumber version', () => {
    expect(parseWirePlumberVersion('wireplumber\nCompiled with libwireplumber 0.5.18\nLinked with libwireplumber 0.5.18')).toEqual([0, 5, 18]);
    expect(parseWirePlumberVersion('nothing here')).toBeNull();
  });
});

describe('AudioSplit', () => {
  it('reports an unsplit card before setup', async () => {
    const { split } = await fakeSystem();
    expect(await split.status()).toEqual(expect.objectContaining({ supported: true, installed: 'none', cardFound: true, active: false, defaultOutputIsGame: false }));
  });

  it('sets up: installs both files, restarts WirePlumber and ends up split with Game as default', async () => {
    const { split, calls } = await fakeSystem();
    const status = await split.setup();
    expect(status).toEqual(expect.objectContaining({ installed: 'current', active: true, defaultOutputIsGame: true }));
    expect(await readFile(split.paths.conf, 'utf8')).toBe(await readFile(join(ASSETS, CONF_FILE), 'utf8'));
    expect(await readFile(split.paths.script, 'utf8')).toBe(await readFile(join(ASSETS, SCRIPT_FILE), 'utf8'));
    expect(calls).toContain('systemctl --user restart wireplumber');
    expect(calls.some((c) => c.startsWith('wpctl set-profile'))).toBe(false);
  });

  it('keeps the listening volume: the new outputs take the old output’s level, and undo hands it back', async () => {
    const { split, volumes } = await fakeSystem();
    await split.setup();
    expect(volumes.get(106)).toBe(0.4); // Game
    expect(volumes.get(50)).toBe(0.4); // Voice (same node id as the old analog output in the fixtures)
    volumes.set(106, 0.55);
    await split.undo();
    expect(volumes.get(50)).toBe(0.55);
  });

  it('switches the profile itself when a saved profile overrides the rule', async () => {
    const { split, calls } = await fakeSystem({ savedProfile: 'output:analog-stereo+input:mono-fallback' });
    const status = await split.setup();
    expect(calls).toContain('wpctl set-profile 33 7');
    expect(status.active).toBe(true);
  });

  it('undoes: removes the files and the chat memory, and the card returns to its normal profile', async () => {
    const { split, calls } = await fakeSystem();
    await split.setup();
    await mkdir(join(split.paths.state, '..'), { recursive: true });
    await writeFile(split.paths.state, '[logitech-a50x-chat]\n');
    const status = await split.undo();
    expect(status).toEqual(expect.objectContaining({ installed: 'none', active: false }));
    for (const p of Object.values(split.paths)) await expect(stat(p)).rejects.toThrow();
    expect(calls.some((c) => c.startsWith('wpctl set-profile'))).toBe(false);
  });

  it('undo resets the profile itself when Pro Audio was saved as the user’s choice', async () => {
    const { split, calls } = await fakeSystem({ savedProfile: 'output:analog-stereo+input:mono-fallback' });
    await split.setup(); // had to force Pro Audio with wpctl, which WirePlumber saves
    const status = await split.undo();
    expect(calls).toContain('wpctl set-profile 33 1');
    expect(status.active).toBe(false);
  });

  it('notices a half-installed or outdated setup', async () => {
    const { split } = await fakeSystem();
    await split.setup();
    await writeFile(split.paths.script, '-- old version\n');
    expect((await split.status()).installed).toBe('outdated');
    const { rm } = await import('node:fs/promises');
    await rm(split.paths.script);
    expect((await split.status()).installed).toBe('partial');
  });

  it('refuses on WirePlumber older than 0.5', async () => {
    const { split } = await fakeSystem({ version: '0.4.17' });
    const status = await split.status();
    expect(status.supported).toBe(false);
    expect(status.reason).toMatch('0.5');
    await expect(split.setup()).rejects.toThrow('0.5');
  });
});
