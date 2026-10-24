import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedProducts, DeviceAccess, helperScript, RULE_FILE, type RunResult } from '../../src/access/udev.js';

const SHIPPED = readFileSync(new URL('../../linux/70-libre-hub.rules', import.meta.url), 'utf8');
const A50X_ONLY = 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="0b0b", TAG+="uaccess"\n';

function setup(installed: Record<string, string> = {}, result: RunResult = { code: 0, stderr: '' }) {
  const root = mkdtempSync(join(tmpdir(), 'libre-hub-access-'));
  const etc = join(root, 'etc');
  const lib = join(root, 'lib');
  mkdirSync(etc);
  mkdirSync(lib);
  for (const [file, text] of Object.entries(installed)) writeFileSync(join(file.startsWith('lib/') ? lib : etc, file.replace(/^lib\//, '')), text);
  const shipped = join(root, RULE_FILE);
  writeFileSync(shipped, SHIPPED);
  const calls: string[][] = [];
  const access = new DeviceAccess({
    shippedRule: shipped,
    rulesDirs: [etc, lib],
    dataDir: join(root, 'data'),
    platform: 'linux',
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return result;
    },
  });
  return { access, calls, root };
}

describe('device access (udev rule)', () => {
  it('reads which Logitech devices a rules file lets the user open', () => {
    expect([...allowedProducts(SHIPPED)]).toEqual(['0b0b', 'c547', 'c095']);
    expect([...allowedProducts('# SUBSYSTEM=="hidraw", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="c547", TAG+="uaccess"')]).toEqual([]);
    expect([...allowedProducts('KERNEL=="hidraw*", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="c547", MODE="0666"')]).toEqual(['c547']);
    expect([...allowedProducts('SUBSYSTEM=="hidraw", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="c547", GROUP="plugdev"')]).toEqual([]);
  });

  it('tells nothing installed, the old per-device rule, a package rule and our own rule apart', async () => {
    expect(await setup().access.status()).toMatchObject({ supported: true, rule: 'none', missing: ['0b0b', 'c547', 'c095'] });
    // Someone who installed the A50 X rule before the mouse was supported:
    expect(await setup({ '70-logitech-a50x.rules': A50X_ONLY }).access.status()).toMatchObject({ rule: 'partial', missing: ['c547', 'c095'] });
    expect(await setup({ 'lib/42-solaar.rules': SHIPPED.replaceAll('0b0b', '0000') + A50X_ONLY }).access.status()).toMatchObject({ rule: 'covered', missing: [] });
    expect(await setup({ [RULE_FILE]: SHIPPED }).access.status()).toMatchObject({ rule: 'current', missing: [] });
    expect(await setup({ [RULE_FILE]: A50X_ONLY }).access.status()).toMatchObject({ rule: 'outdated', missing: ['c547', 'c095'] });
  });

  it('installs through pkexec with a helper that holds the rule', async () => {
    const { access, calls, root } = setup();
    expect(await access.allow()).toMatchObject({ outcome: 'done' });
    expect(calls).toEqual([['pkexec', join(root, 'data', 'allow-device-access')]]);
    const helper = readFileSync(join(root, 'data', 'allow-device-access'), 'utf8');
    expect(helper).toContain(SHIPPED.trim());
    expect(helper).toContain('udevadm trigger --subsystem-match=hidraw --action=change');
    expect(statSync(join(root, 'data', 'allow-device-access')).mode & 0o777).toBe(0o755);
    execFileSync('sh', ['-n', join(root, 'data', 'allow-device-access')]);
    // The copy the manual commands point at:
    expect(readFileSync(join(root, 'data', RULE_FILE), 'utf8')).toBe(SHIPPED);
    await access.remove();
    expect(calls[1]).toEqual(['pkexec', join(root, 'data', 'allow-device-access'), 'remove']);
  });

  it('says why it didn’t work: dialog closed, no password dialog, password refused', async () => {
    expect(await setup({}, { code: 126, stderr: '' }).access.allow()).toMatchObject({ outcome: 'cancelled' });
    expect(await setup({}, { code: 127, stderr: 'Error executing command as another user: No authentication agent found.' }).access.allow()).toMatchObject({ outcome: 'no-agent' });
    expect(await setup({}, { code: null, stderr: '', missing: true }).access.allow()).toMatchObject({ outcome: 'no-agent' });
    expect(await setup({}, { code: 127, stderr: 'Error executing command as another user: Not authorized' }).access.allow()).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/password/) });
  });

  it('removes the old per-device rules it replaces', () => {
    const script = helperScript(SHIPPED);
    expect(script).toMatch(/rm -f "\$dir\/70-logitech-a50x.rules" "\$dir\/70-logitech-g502x.rules"/);
    expect(() => helperScript('LIBRE_HUB_RULE')).toThrow(/heredoc/);
  });
});
