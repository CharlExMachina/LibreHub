// Hands-on check of macros, software actions and Freestyle on the real G502 X PLUS, through the
// real CLI and agent, with a person pressing buttons and looking at the LEDs (macOS: the prompts
// are osascript dialogs). Quit G Hub first, then:  npm run build && node tools/re/g502x-handson.mjs
//
// It backs up the onboard memory, sets profile 1 up as below, runs `g502x agent`, asks you to
// press buttons, checks the results, and restores everything (memory, mode, active profile).
//
//   G8 (DPI up)    double-click            stored on the mouse
//   G9             text:Hello, World!      stored on the mouse
//   G7 (DPI down)  run:touch <tmp file>    performed by the agent
//   Freestyle      rainbow                 painted by the agent

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(import.meta.dirname, '../../dist/mouse/cli.js');
const dir = mkdtempSync(join(tmpdir(), 'g502x-handson-'));
const env = { ...process.env, G502X_CONFIG: join(dir, 'g502x.json') };
const marker = join(dir, 'agent-ran');
const backup = join(dir, 'backup.json');
const results = {};

const g502x = (...args) => execFileSync('node', [cli, ...args], { env, encoding: 'utf8' });
const log = (...a) => console.log(`${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`);
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
function dialog(text, { answer, buttons = ['OK'] } = {}) {
  const field = answer === undefined ? '' : `default answer "${esc(answer)}"`;
  const script = `activate\ndisplay dialog "${esc(text)}" ${field} buttons {${buttons.map((b) => `"${b}"`).join(', ')}} with title "G502 X PLUS check" giving up after 900`;
  const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
  return { button: out.match(/button returned:([^,]*)/)?.[1], text: out.match(/text returned:(.*), gave up/)?.[1] };
}

const status = JSON.parse(g502x('status', '--json'));
log(`mode ${status.mode}, active profile ${status.activeProfile}`);
g502x('backup', backup);
let agent;
try {
  g502x('mode', 'onboard');
  g502x('profile', '1');
  g502x('profile', '1', 'button', 'dpi-up', 'double-click');
  g502x('profile', '1', 'button', 'g9', 'text:Hello, World!');
  g502x('profile', '1', 'button', 'dpi-down', `run:touch '${marker}'`);
  g502x('profile', '1', 'freestyle', '#ff0000,#ff8000,#ffff00,#00ff00,#00ffff,#0000ff,#8000ff,#ff00ff');
  log(g502x('profile', '1', 'show').trim());

  agent = spawn('node', [cli, 'agent'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  agent.stdout.on('data', (d) => log('agent:', d.toString().trim()));
  agent.stderr.on('data', (d) => log('agent err:', d.toString().trim()));
  await new Promise((r) => setTimeout(r, 3000));

  const typed = dialog(
    'Step 1 of 3 (macros on the mouse, and an action on the computer)\n\n' +
      '1. Point the mouse at the word "beta" in the box below and press G8 (the upper button left of the left click). The mouse double-clicks: "beta" gets selected.\n' +
      '2. Press G9 (behind the wheel). The mouse types "Hello, World!" over it.\n' +
      '3. Press G7 (the lower button left of the left click) once.\n\nThen click OK.',
    { answer: 'alpha beta gamma' },
  );
  results.text = typed.text;
  results.textOk = typed.text === 'alpha Hello, World! gamma';
  results.actionOk = existsSync(marker);
  log(`typed ${JSON.stringify(typed.text)} → ${results.textOk ? 'OK' : 'NOT AS EXPECTED'}; G7 action ${results.actionOk ? 'ran' : 'did NOT run'}`);

  results.freestyleOk = dialog('Step 2 of 3 (Freestyle)\n\nDo the mouse lights show several different colours (a rainbow along the strip) instead of the usual animation?', { buttons: ['No', 'Yes'] }).button === 'Yes';
  agent.kill('SIGINT');
  await new Promise((r) => agent.once('exit', r));
  agent = undefined;
  await new Promise((r) => setTimeout(r, 1500));
  results.releasedOk = dialog('Step 3 of 3\n\nI stopped the agent. Are the lights back to the usual animation?', { buttons: ['No', 'Yes'] }).button === 'Yes';
} finally {
  agent?.kill('SIGINT');
  g502x('restore', backup);
  g502x('mode', status.mode);
  if (status.mode === 'onboard') g502x('profile', String(status.activeProfile));
  rmSync(dir, { recursive: true, force: true });
  log('restored the onboard memory, mode and active profile');
}
log('RESULTS', JSON.stringify(results));
process.exitCode = Object.entries(results).every(([k, v]) => !k.endsWith('Ok') || v) ? 0 : 1;
