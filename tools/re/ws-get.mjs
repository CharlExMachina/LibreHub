import WebSocket from 'ws';
const paths = process.argv.slice(2);
const ws = new WebSocket('ws://127.0.0.1:9010', 'json', { origin: 'file://' });
let n = 0; const want = new Map();
ws.on('open', () => { for (const p of paths) { const id = String(++n); want.set(id, p); ws.send(JSON.stringify({ msgId: id, verb: 'GET', path: p })); } });
ws.on('message', (m) => { const s = m.toString(); let j; try { j = JSON.parse(s); } catch { console.log('RAW', s.slice(0,500)); return; }
  if (want.has(j.msgId)) { console.log('=== ' + want.get(j.msgId)); console.log(JSON.stringify(j, null, 1).slice(0, 40000)); want.delete(j.msgId); if (!want.size) ws.close(); }
  else console.log('EVT', s.slice(0, 300)); });
ws.on('error', e => console.log('ERR', e.message));
setTimeout(() => { console.log('timeout; pending', [...want.values()]); process.exit(0); }, 5000);
