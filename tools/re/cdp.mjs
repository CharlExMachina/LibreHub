// Minimal CDP driver for the G Hub UI page: `eval <js>` or `shot <file.png>`.
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.on('message', m => { const j = JSON.parse(m); if (j.id && pending.has(j.id)) { const p = pending.get(j.id); pending.delete(j.id); j.error ? p.rej(new Error(j.error.message)) : p.res(j.result); } });
await new Promise(r => ws.on('open', r));
if (cmd === 'eval') {
  const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 500) : JSON.stringify(r.result.value, null, 1));
} else if (cmd === 'click') {
  const [x, y] = arg.split(',').map(Number);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  console.log('clicked', x, y);
} else if (cmd === 'clicktext') {
  // Click the innermost visible element whose trimmed text equals arg exactly; fails if not unique.
  const js = `(() => { const want = ${JSON.stringify(arg)};
    const els = [...document.querySelectorAll('body *')].filter(e => e.offsetParent && e.textContent.trim() === want && ![...e.children].some(c => c.textContent.trim() === want));
    if (els.length !== 1) return 'NOMATCH ' + els.length;
    const r = els[0].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`;
  const r = await call('Runtime.evaluate', { expression: js, returnByValue: true });
  const v = r.result.value; if (typeof v === 'string') { console.log(v); process.exit(2); }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: v[0], y: v[1], button: 'left', clickCount: 1 });
  console.log('clicked', arg, v.map(Math.round).join(','));
} else if (cmd === 'shot') {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(arg, Buffer.from(r.data, 'base64')); console.log('saved', arg);
}
ws.close(); process.exit(0);
