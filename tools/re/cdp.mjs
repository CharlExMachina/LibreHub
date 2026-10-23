// Minimal CDP driver for the G Hub UI (relaunch lghub_ui with --remote-debugging-port=9333):
//   eval <js> | shot <file.png> | click x,y | clicktext <text> | drag x1,y1:x2,y2
//   html5drag x1,y1:x2,y2 (G Hub assignments use HTML5 drag and drop) | type <text> | key <input>:<Key>:<n>
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const events = []; ws.on('message', m => { const j = JSON.parse(m); if (j.method) events.push(j); if (j.id && pending.has(j.id)) { const p = pending.get(j.id); pending.delete(j.id); j.error ? p.rej(new Error(j.error.message)) : p.res(j.result); } });
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
} else if (cmd === 'drag') {
  // drag x1,y1:x2,y2 - press, move in steps, release (works for pointer-event based drag and drop)
  const [[x1, y1], [x2, y2]] = arg.split(':').map((p) => p.split(',').map(Number));
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 20; i++) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 20, y: y1 + ((y2 - y1) * i) / 20, button: 'left', buttons: 1 });
    await new Promise((r) => setTimeout(r, 30));
  }
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
  console.log('dragged', arg);
} else if (cmd === 'html5drag') {
  // html5drag x1,y1:x2,y2 - intercept Chromium's native drag and replay it as drag events
  const [[x1, y1], [x2, y2]] = arg.split(':').map((p) => p.split(',').map(Number));
  await call('Input.setInterceptDrags', { enabled: true });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  let data;
  for (let i = 1; i <= 10 && !data; i++) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + 3 * i, y: y1 + 3 * i, button: 'left', buttons: 1 });
    await new Promise((r) => setTimeout(r, 50));
    data = events.find((e) => e.method === 'Input.dragIntercepted')?.params.data;
  }
  if (!data) { console.log('no drag intercepted'); await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left' }); process.exit(2); }
  for (const type of ['dragEnter', 'dragOver']) await call('Input.dispatchDragEvent', { type, x: x2, y: y2, data });
  await new Promise((r) => setTimeout(r, 200));
  await call('Input.dispatchDragEvent', { type: 'dragOver', x: x2, y: y2, data });
  await call('Input.dispatchDragEvent', { type: 'drop', x: x2, y: y2, data });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left' });
  await call('Input.setInterceptDrags', { enabled: false });
  console.log('html5-dragged', arg, JSON.stringify(data).slice(0, 200));
} else if (cmd === 'type') {
  // type <text> - insert text into the focused element, then press Enter
  await call('Input.insertText', { text: arg });
  for (const type of ['rawKeyDown', 'char', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'char' ? '\r' : undefined });
  console.log('typed', arg);
} else if (cmd === 'key') {
  // key <inputIndex>:<Key>:<count> - focus the n-th visible input and press a key count times
  const [idx, key, count] = arg.split(':');
  await call('Runtime.evaluate', { expression: `[...document.querySelectorAll('input')].filter(e=>e.offsetParent)[${idx}].focus()` });
  const codes = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40 };
  for (let i = 0; i < Number(count || 1); i++) for (const type of ['rawKeyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key] });
  console.log('pressed', key, count);
} else if (cmd === 'shot') {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(arg, Buffer.from(r.data, 'base64')); console.log('saved', arg);
}
ws.close(); process.exit(0);
