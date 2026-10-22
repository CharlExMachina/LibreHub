// Send one request {verb, path, payload} to the G Hub agent and print the reply.
import WebSocket from 'ws';
const [verb, path, payload] = process.argv.slice(2);
const ws = new WebSocket('ws://127.0.0.1:9010', 'json', { origin: 'file://' });
ws.on('open', () => { const m = { msgId: '1', verb, path }; if (payload) m.payload = JSON.parse(payload); ws.send(JSON.stringify(m)); });
ws.on('message', (m) => { const j = JSON.parse(m.toString()); if (j.msgId === '1') { console.log(JSON.stringify(j)); ws.close(); } });
setTimeout(() => process.exit(0), 1500);
