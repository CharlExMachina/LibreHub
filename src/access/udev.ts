// Linux only: let the person logged in at this computer open the devices Libre Hub manages.
//
// Linux lets an ordinary user open a hidraw device only when a udev rule says so. Ours
// (linux/70-libre-hub.rules) tags the devices "uaccess", which systemd turns into an access
// control entry for whoever is logged in at the seat. Installing it needs root once, so the app
// writes a small helper next to its other files and runs it through pkexec: the desktop's
// polkit agent (KDE, GNOME, ...) asks for the password. The helper writes the rule and has udev
// re-apply its rules to the devices already plugged in, so nothing needs to be replugged.
// Without a polkit agent the app shows the equivalent commands instead.

import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RULE_FILE = '70-libre-hub.rules';
/** Rules the README told people to copy before there was one file for everything. */
export const LEGACY_RULE_FILES = ['70-logitech-a50x.rules', '70-logitech-g502x.rules'];
const HELPER = 'allow-device-access';

/**
 * - current: our rule is installed as this version ships it
 * - outdated: our rule is installed but older (a device was added since)
 * - covered: every device is allowed by other rules (the old per-device files, a distro package)
 * - partial: some devices are allowed, some aren't
 * - none: nothing allows them
 */
export type RuleState = 'current' | 'outdated' | 'covered' | 'partial' | 'none';

export interface AccessStatus {
  supported: boolean;
  rule: RuleState;
  /** USB product ids (Logitech, 046d) the shipped rule allows and no installed rule does. */
  missing: string[];
  /** For doing it by hand: the shipped rule, copied where it outlives the AppImage's mount. */
  commands: string;
}

export type AllowResult =
  | { outcome: 'done'; status: AccessStatus }
  /** The password dialog was closed. Nothing changed. */
  | { outcome: 'cancelled'; status: AccessStatus }
  /** No polkit agent (or no pkexec) to ask for the password: the commands have to be run by hand. */
  | { outcome: 'no-agent'; status: AccessStatus }
  | { outcome: 'failed'; error: string; status: AccessStatus };

export interface RunResult {
  code: number | null;
  stderr: string;
  /** The program wasn't found. */
  missing?: boolean;
}

export interface DeviceAccessDeps {
  /** The rule file this version ships (repo or AppImage: linux/70-libre-hub.rules). */
  shippedRule: string;
  /** Where udev reads rules, admin's first. */
  rulesDirs?: string[];
  /** Where the helper and a copy of the rule go (~/.local/share/libre-hub). */
  dataDir?: string;
  platform?: NodeJS.Platform;
  /** Runs a program and waits for it, however long the password dialog stays open. */
  run?: (cmd: string, args: string[]) => Promise<RunResult>;
}

const run = (cmd: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(cmd, args, (err, _stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      if (e?.code === 'ENOENT') return resolve({ code: null, stderr: '', missing: true });
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stderr: stderr.toString().trim() });
    });
  });

/** Logitech product ids a rules file grants access to (lines that tag "uaccess" or open the mode). */
export function allowedProducts(rules: string): Set<string> {
  const out = new Set<string>();
  for (const line of rules.split('\n')) {
    if (/^\s*#/.test(line) || !/ATTRS?\{idVendor\}=="046d"/i.test(line)) continue;
    if (!/TAG\+="uaccess"|MODE="0?66[0-6]"/.test(line)) continue;
    const id = line.match(/ATTRS?\{idProduct\}=="([0-9a-f]{4})"/i)?.[1];
    if (id) out.add(id.toLowerCase());
  }
  return out;
}

/** The root helper: installs (or with "remove", deletes) the rule and re-applies udev's rules. */
export function helperScript(rule: string): string {
  if (rule.includes('LIBRE_HUB_RULE')) throw new Error('the rule file contains the heredoc marker');
  return `#!/bin/sh
# Written by Libre Hub and run as root through pkexec, after you type your password. It lets the
# person logged in at this computer open the Logitech devices Libre Hub manages, or with
# "remove" takes that back. See /etc/udev/rules.d/${RULE_FILE}.
set -e
dir=/etc/udev/rules.d
if [ "$1" = remove ]; then
  rm -f "$dir/${RULE_FILE}" ${LEGACY_RULE_FILES.map((f) => `"$dir/${f}"`).join(' ')}
else
  mkdir -p "$dir"
  cat > "$dir/${RULE_FILE}.tmp" <<'LIBRE_HUB_RULE'
${rule.trimEnd()}
LIBRE_HUB_RULE
  chmod 644 "$dir/${RULE_FILE}.tmp"
  mv "$dir/${RULE_FILE}.tmp" "$dir/${RULE_FILE}"
  # This file replaces the per-device ones earlier versions asked you to copy.
  rm -f ${LEGACY_RULE_FILES.map((f) => `"$dir/${f}"`).join(' ')}
fi
udevadm control --reload-rules
# Re-apply the rules to what is plugged in now, so it doesn't have to be replugged.
udevadm trigger --subsystem-match=hidraw --action=change
udevadm settle --timeout=10 || true
`;
}

export class DeviceAccess {
  private readonly rulesDirs: string[];
  private readonly dataDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly runner: (cmd: string, args: string[]) => Promise<RunResult>;

  constructor(private readonly deps: DeviceAccessDeps) {
    this.rulesDirs = deps.rulesDirs ?? ['/etc/udev/rules.d', '/run/udev/rules.d', '/usr/lib/udev/rules.d', '/lib/udev/rules.d'];
    this.dataDir = deps.dataDir ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'libre-hub');
    this.platform = deps.platform ?? process.platform;
    this.runner = deps.run ?? run;
  }

  get helperPath(): string {
    return join(this.dataDir, HELPER);
  }

  private async read(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  }

  async status(): Promise<AccessStatus> {
    const shipped = (await this.read(this.deps.shippedRule)) ?? '';
    const wanted = [...allowedProducts(shipped)];
    const copy = join(this.dataDir, RULE_FILE);
    const commands = `sudo cp ${copy.replace(homedir(), '~')} /etc/udev/rules.d/\nsudo udevadm control --reload-rules\nsudo udevadm trigger`;
    if (this.platform !== 'linux') return { supported: false, rule: 'none', missing: [], commands };
    const allowed = new Set<string>();
    let ours: string | null = null;
    for (const dir of this.rulesDirs) {
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.rules'));
      } catch {
        continue;
      }
      for (const f of files) {
        const text = await this.read(join(dir, f));
        if (text === null) continue;
        if (f === RULE_FILE && dir === this.rulesDirs[0]) ours = text;
        for (const id of allowedProducts(text)) allowed.add(id);
      }
    }
    const missing = wanted.filter((id) => !allowed.has(id));
    const rule: RuleState = ours !== null
      ? ours.trim() === shipped.trim() ? 'current' : missing.length ? 'outdated' : 'current'
      : !missing.length ? 'covered' : missing.length < wanted.length ? 'partial' : 'none';
    return { supported: true, rule, missing, commands };
  }

  /** The commands that do the same by hand (with the rule copied where they can find it). */
  async manual(): Promise<string> {
    await this.prepare();
    return (await this.status()).commands;
  }

  /** Write the helper and a copy of the rule next to the app's other files. */
  private async prepare(): Promise<string> {
    const rule = await readFile(this.deps.shippedRule, 'utf8');
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(join(this.dataDir, RULE_FILE), rule);
    await writeFile(this.helperPath, helperScript(rule));
    await chmod(this.helperPath, 0o755);
    return this.helperPath;
  }

  /** Install the rule, asking for the password through the desktop's polkit agent. */
  allow(): Promise<AllowResult> {
    return this.elevate([]);
  }

  /** Remove it again (also the old per-device files). Takes effect for a device when it is replugged. */
  remove(): Promise<AllowResult> {
    return this.elevate(['remove']);
  }

  private async elevate(args: string[]): Promise<AllowResult> {
    if (this.platform !== 'linux') return { outcome: 'failed', error: 'only needed on Linux', status: await this.status() };
    let helper: string;
    try {
      helper = await this.prepare();
    } catch (err) {
      return { outcome: 'failed', error: (err as Error).message, status: await this.status() };
    }
    const r = await this.runner('pkexec', [helper, ...args]);
    const status = await this.status();
    // pkexec: 126 = the dialog was dismissed; 127 = not authorized, or no agent to ask.
    if (r.missing || (r.code === 127 && /no authentication agent|cannot open display|no session for cookie/i.test(r.stderr))) return { outcome: 'no-agent', status };
    if (r.code === 126) return { outcome: 'cancelled', status };
    if (r.code === 0) return { outcome: 'done', status };
    if (r.code === 127) return { outcome: 'failed', error: 'Your password wasn’t accepted, or your account isn’t allowed to make this change.', status };
    return { outcome: 'failed', error: r.stderr || `the helper stopped with code ${r.code}`, status };
  }
}
