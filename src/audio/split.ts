// Linux only: split the base station's audio into "A50 X Game" and "A50 X Voice" outputs.
//
// The base station has separate Game and Voice playback interfaces that the headset's Game/Voice
// balance mixes. PipeWire's default profile only exposes the Voice one, so all desktop audio lands
// in the chat channel. Setup installs a WirePlumber rule (linux/wireplumber/) that switches the card
// to its Pro Audio profile, names the devices, makes Game the default output and routes voice-chat
// apps to Voice. Everything is per-user (no root) and undo removes it again.

import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONF_FILE = '51-logitech-a50x.conf';
export const SCRIPT_FILE = 'logitech-a50x-chat.lua';
/** The chat script's own memory of apps it has routed once. */
export const STATE_FILE = 'logitech-a50x-chat';
const CARD_PREFIX = 'alsa_card.usb-Logitech_A50_X';
const PRO_PROFILE = 'pro-audio';

export type Installed = 'none' | 'partial' | 'outdated' | 'current';

export interface AudioSplitStatus {
  /** PipeWire with WirePlumber 0.5+ is running. */
  supported: boolean;
  /** Why not, when unsupported. */
  reason?: string;
  installed: Installed;
  /** PipeWire sees the base station's audio card. */
  cardFound: boolean;
  /** The card is split: Pro Audio profile and the Game output exists. */
  active: boolean;
  defaultOutputIsGame: boolean;
  /** PipeWire node names, when present. */
  nodes: { game?: string; voice?: string; mic?: string; streamOut?: string };
}

export interface AudioSplitDeps {
  run: (cmd: string, args: string[]) => Promise<string>;
  /** Folder holding 51-logitech-a50x.conf and logitech-a50x-chat.lua (the repo's linux/wireplumber). */
  assetsDir: string;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

export const runCommand = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args.join(' ')}: ${stderr?.toString().trim() || err.message}`)) : resolve(stdout.toString()));
  });

// ------------------------------------------------------------------ pw-dump parsing

interface PwObject {
  id: number;
  type: string;
  info?: { props?: Record<string, unknown>; params?: Record<string, Record<string, unknown>[]> };
  props?: Record<string, unknown>;
  metadata?: { subject: number; key: string; value: unknown }[];
}

export interface CardState {
  deviceId: number;
  /** The card's playback nodes (split or not), for carrying the volume across a profile change. */
  sinks: { id: number; name: string }[];
  profile: string | null;
  profiles: { index: number; name: string; priority: number; available: string }[];
  nodes: AudioSplitStatus['nodes'];
}

/** Find the A50 X card, its profiles and its split nodes in `pw-dump` output. */
export function parsePwDump(json: string): { card: CardState | null; defaultSink: string | null } {
  const objects = JSON.parse(json) as PwObject[];
  const meta = objects.find((o) => o.type.endsWith('Metadata') && o.props?.['metadata.name'] === 'default');
  const sinkEntry = meta?.metadata?.find((m) => m.subject === 0 && m.key === 'default.audio.sink');
  const sinkValue = sinkEntry?.value as { name?: string } | string | undefined;
  const defaultSink = typeof sinkValue === 'string' ? (JSON.parse(sinkValue).name ?? null) : (sinkValue?.name ?? null);

  const device = objects.find((o) => o.type.endsWith('Device') && String(o.info?.props?.['device.name'] ?? '').startsWith(CARD_PREFIX));
  if (!device) return { card: null, defaultSink };
  const params = device.info?.params ?? {};
  const nodes: AudioSplitStatus['nodes'] = {};
  const sinks: CardState['sinks'] = [];
  for (const o of objects) {
    if (!o.type.endsWith('Node') || Number(o.info?.props?.['device.id']) !== device.id) continue;
    const name = String(o.info?.props?.['node.name'] ?? '');
    if (o.info?.props?.['media.class'] === 'Audio/Sink') sinks.push({ id: o.id, name });
    if (name.endsWith('.pro-output-1')) nodes.game = name;
    else if (name.endsWith('.pro-output-0')) nodes.voice = name;
    else if (name.endsWith('.pro-input-0')) nodes.mic = name;
    else if (name.endsWith('.pro-input-1')) nodes.streamOut = name;
  }
  return {
    defaultSink,
    card: {
      deviceId: device.id,
      profile: (params.Profile?.[0]?.name as string | undefined) ?? null,
      profiles: (params.EnumProfile ?? []).map((p) => ({
        index: Number(p.index),
        name: String(p.name),
        priority: Number(p.priority ?? 0),
        available: String(p.available ?? 'unknown'),
      })),
      nodes,
      sinks,
    },
  };
}

/** The profile PipeWire would normally pick: the highest-priority available one that isn't Off or Pro Audio. */
export function defaultProfile(card: CardState): { index: number; name: string } | undefined {
  return card.profiles
    .filter((p) => p.name !== 'off' && p.name !== PRO_PROFILE && p.available !== 'no')
    .sort((a, b) => b.priority - a.priority)[0];
}

export function parseWirePlumberVersion(text: string): [number, number, number] | null {
  const all = [...text.matchAll(/(\d+)\.(\d+)\.(\d+)/g)];
  const last = all.at(-1);
  return last ? [Number(last[1]), Number(last[2]), Number(last[3])] : null;
}

// ------------------------------------------------------------------ setup / undo

export class AudioSplit {
  private readonly run: AudioSplitDeps['run'];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly deps: AudioSplitDeps) {
    this.run = deps.run;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.env = deps.env ?? process.env;
  }

  get paths() {
    const home = this.env.HOME || homedir();
    return {
      conf: join(this.env.XDG_CONFIG_HOME || join(home, '.config'), 'wireplumber', 'wireplumber.conf.d', CONF_FILE),
      script: join(this.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'wireplumber', 'scripts', SCRIPT_FILE),
      state: join(this.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'wireplumber', STATE_FILE),
    };
  }

  async status(): Promise<AudioSplitStatus> {
    const installed = await this.installed();
    const base: AudioSplitStatus = { supported: false, installed, cardFound: false, active: false, defaultOutputIsGame: false, nodes: {} };
    const version = await this.run('wireplumber', ['--version']).then(parseWirePlumberVersion, () => null);
    if (!version) return { ...base, reason: 'WirePlumber (PipeWire’s session manager) wasn’t found.' };
    if (version[0] === 0 && version[1] < 5) return { ...base, reason: `WirePlumber ${version.join('.')} is too old; 0.5 or newer is needed.` };
    let dump: ReturnType<typeof parsePwDump>;
    try {
      dump = parsePwDump(await this.run('pw-dump', []));
    } catch {
      return { ...base, reason: 'PipeWire isn’t running.' };
    }
    const card = dump.card;
    return {
      ...base,
      supported: true,
      cardFound: !!card,
      active: !!card && card.profile === PRO_PROFILE && !!card.nodes.game,
      defaultOutputIsGame: !!card?.nodes.game && dump.defaultSink === card.nodes.game,
      nodes: card?.nodes ?? {},
    };
  }

  /** Install the rule and script, restart WirePlumber and make sure the card ends up split. */
  async setup(): Promise<AudioSplitStatus> {
    const before = await this.status();
    if (!before.supported) throw new Error(before.reason ?? 'Audio splitting isn’t supported here.');
    // The new outputs start at 100%; keep what the user was listening at instead.
    const volume = await this.cardVolume((name) => !name.includes('.pro-output-'));
    const { conf, script } = this.paths;
    // The script goes in first: the config makes WirePlumber require it.
    await writeAtomic(script, await readFile(join(this.deps.assetsDir, SCRIPT_FILE), 'utf8'));
    await writeAtomic(conf, await readFile(join(this.deps.assetsDir, CONF_FILE), 'utf8'));
    await this.restart();
    // A profile the user picked earlier (saved by WirePlumber) wins over the rule, so set it explicitly.
    const card = await this.waitForCard();
    if (card && card.profile !== PRO_PROFILE) {
      const pro = card.profiles.find((p) => p.name === PRO_PROFILE);
      if (pro) await this.run('wpctl', ['set-profile', String(card.deviceId), String(pro.index)]);
    }
    await this.waitFor((s) => !s.cardFound || s.active);
    if (volume !== null) await this.setCardVolume(volume, (name) => name.includes('.pro-output-'));
    return this.status();
  }

  /** Remove everything setup added and put the card back on its normal profile. */
  async undo(): Promise<AudioSplitStatus> {
    const { conf, script, state } = this.paths;
    const volume = await this.cardVolume((name) => name.endsWith('.pro-output-1'));
    // The config goes first, so WirePlumber never requires a script that's already gone.
    await rm(conf, { force: true });
    await rm(script, { force: true });
    await rm(state, { force: true });
    await this.restart();
    const card = await this.waitForCard();
    if (card && card.profile === PRO_PROFILE) {
      const normal = defaultProfile(card);
      if (normal) await this.run('wpctl', ['set-profile', String(card.deviceId), String(normal.index)]);
    }
    await this.waitFor((s) => !s.active);
    if (volume !== null) await this.setCardVolume(volume, (name) => !name.includes('.pro-output-'));
    return this.status();
  }

  /** Volume (0..1+) of the first of the card's outputs that matches, or null. */
  private async cardVolume(match: (nodeName: string) => boolean): Promise<number | null> {
    const card = await this.run('pw-dump', []).then((j) => parsePwDump(j).card, () => null);
    const sink = card?.sinks.find((s) => match(s.name));
    if (!sink) return null;
    const out = await this.run('wpctl', ['get-volume', String(sink.id)]).catch(() => '');
    const m = /Volume:\s*([\d.]+)/.exec(out);
    return m ? Number(m[1]) : null;
  }

  private async setCardVolume(volume: number, match: (nodeName: string) => boolean): Promise<void> {
    const card = await this.run('pw-dump', []).then((j) => parsePwDump(j).card, () => null);
    for (const sink of card?.sinks.filter((s) => match(s.name)) ?? []) {
      await this.run('wpctl', ['set-volume', String(sink.id), volume.toFixed(2)]).catch(() => undefined);
    }
  }

  private async installed(): Promise<Installed> {
    const { conf, script } = this.paths;
    const [c, s] = await Promise.all([readFile(conf, 'utf8').catch(() => null), readFile(script, 'utf8').catch(() => null)]);
    if (c === null && s === null) return 'none';
    if (c === null || s === null) return 'partial';
    const [wantC, wantS] = await Promise.all([
      readFile(join(this.deps.assetsDir, CONF_FILE), 'utf8').catch(() => c),
      readFile(join(this.deps.assetsDir, SCRIPT_FILE), 'utf8').catch(() => s),
    ]);
    return c === wantC && s === wantS ? 'current' : 'outdated';
  }

  private async restart(): Promise<void> {
    await this.run('systemctl', ['--user', 'restart', 'wireplumber']);
  }

  private async waitForCard(): Promise<CardState | null> {
    for (let i = 0; i < 20; i++) {
      const card = await this.run('pw-dump', []).then((j) => parsePwDump(j).card, () => null);
      if (card?.profile) return card;
      await this.sleep(300);
    }
    return null;
  }

  private async waitFor(done: (s: AudioSplitStatus) => boolean): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if (done(await this.status())) return;
      await this.sleep(300);
    }
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
