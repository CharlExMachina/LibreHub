// Try 2-byte payloads for feature idx 8 fn1 until one is accepted; print it and the resulting state.
import HID from 'node-hid';
const info = HID.devices().find(d => d.vendorId === 0x046d && d.productId === 0x0b0b && d.usagePage === 0xff32);
const dev = new HID.HID(info.path, { nonExclusive: true });
const hex = a => [...a].map(x => x.toString(16).padStart(2, '0')).join(' ');
let waiter = null; const events = [];
dev.on('data', b => { if (b[4] === 0x08 && (b[5] === 0x1b || (b[4] === 0xff))) {} if (waiter) waiter(b); if (b[4] === 0x08 && b[5] === 0x00) events.push(hex(b.slice(0, 3 + b[2]))); });
const send = (p) => new Promise(res => { const pkt = Array(64).fill(0); pkt[0] = 2; pkt[1] = 0x0c; pkt[2] = p.length; p.forEach((v, i) => pkt[3 + i] = v);
  const t = setTimeout(() => { waiter = null; res(null); }, 400);
  waiter = (b) => { if ((b[4] === 0xff && b[5] === p[1] && b[6] === p[2]) || (b[4] === p[1] && b[5] === p[2])) { clearTimeout(t); waiter = null; res(b); } };
  dev.write(pkt); });
const cands = [];
for (let a = 0; a < 256; a++) cands.push([a, 0x13]);
for (let b = 0; b < 256; b++) cands.push([0x13, b]);
let errs = {};
for (const [a, b] of cands) {
  const r = await send([0x00, 0x08, 0x1b, a, b]);
  if (r && r[4] === 0xff) errs[r[7]] = (errs[r[7]] || 0) + 1; if (!r) errs.timeout = (errs.timeout || 0) + 1;
  if (r && r[4] !== 0xff) { console.log('ACCEPTED', hex([a, b]), '->', hex(r.slice(0, 3 + r[2]))); await new Promise(r => setTimeout(r, 300)); console.log('events', events); break; }
}
console.log('errors', errs); dev.close(); process.exit(0);
