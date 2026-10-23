// Ask G Hub how it decodes the mouse's onboard profiles: an independent check of what we write.
// G Hub caches onboard memory, so --restart kills lghub_agent first (the G Hub UI relaunches it and
// it re-reads every sector). Needs G Hub running and `npm i --no-save ws`.
//
//   node tools/re/ghub-onboard-decode.mjs [--restart] [slot]
import { execSync } from 'node:child_process';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const restart = args.includes('--restart');
const slot = Number(args.find((a) => /^\d$/.test(a)) ?? 0);

function get(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:9010', 'json', { origin: 'file://' });
    const t = setTimeout(() => reject(new Error('G Hub agent did not answer')), 5000);
    ws.on('open', () => ws.send(JSON.stringify({ msgId: '1', verb: 'GET', path })));
    ws.on('message', (m) => {
      const j = JSON.parse(m.toString());
      if (j.msgId !== '1') return;
      clearTimeout(t);
      ws.close();
      resolve(j);
    });
    ws.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (restart) {
  execSync('pkill -x lghub_agent || true');
  await sleep(3000);
}
let id;
for (let i = 0; i < 30 && !id; i++) {
  try {
    const list = await get('/devices/list');
    id = list.payload?.deviceInfos?.find((d) => d.deviceModel === 'g502x_plus')?.id;
  } catch {
    // agent still starting
  }
  if (!id) await sleep(1000);
}
if (!id) throw new Error('G502 X PLUS not found in G Hub');
await sleep(restart ? 6000 : 0);
const res = await get(`/onboard_profiles/${id}/profiles`);
const entries = res.payload.directoryEntries.filter((_, k) => !slot || k === slot - 1);
const action = (b) => {
  const m = b.macro;
  if (!m) return `button ${b.button}`;
  const body = m.mouse ?? m.device ?? m.keystroke ?? m.media ?? {};
  return `${m.type} ${JSON.stringify(body)}`;
};
for (const e of entries) {
  console.log(`${e.onboardSlotId} enabled=${e.enabled} name=${JSON.stringify(e.name)}`);
  console.log(`  mouse    ${JSON.stringify(e.mouseSettings)}`);
  console.log(`  lighting ${JSON.stringify(e.lighting?.effects)}`);
  (e.buttonMappings ?? []).forEach((b, k) => console.log(`  base  ${k}: ${action(b)}`));
  (e.gshiftMappings ?? []).forEach((b, k) => console.log(`  shift ${k}: ${action(b)}`));
}
