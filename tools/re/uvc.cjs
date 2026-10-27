// MX Brio: raw UVC control requests through libusb (npm i usb@2; works on macOS while other programs
// have the camera). Unit ids and control bitmaps are this camera's (docs/MXBRIO-PROTOCOL.md#units).
//   node uvc.cjs dump [out.json]   GET_LEN/INFO/CUR/MIN/MAX/RES/DEF of every control
//   node uvc.cjs cur               GET_CUR of every control, one JSON object
//   node uvc.cjs get UNIT SEL      one control
//   node uvc.cjs set UNIT SEL HEX  SET_CUR (writes to the camera)
const usb = require('usb');
const fs = require('fs');
const bmBytes = { 1: '2e0a02', 3: '5b17', 2: '3f00', 6: 'ff6f', 8: 'fb3f', 9: 'f3ffff', 10: 'ba1f1e', 11: '64c983', 21: '03', 22: '01' };
let d;
function open() { d = usb.findByIds(0x46d, 0x944); if (!d) throw new Error('MX Brio not found'); d.open(); }
function xfer(type, req, unit, sel, lenOrBuf) {
  return new Promise((res) => d.controlTransfer(type, req, sel << 8, (unit << 8) | 0, lenOrBuf, (e, b) => res(e ? { err: e.message } : { data: b })));
}
const get = (req, unit, sel, len) => xfer(0xa1, req, unit, sel, len);
function selectors(unit) { const b = Buffer.from(bmBytes[unit], 'hex'); const out = []; for (let i = 0; i < b.length * 8; i++) if (b[i >> 3] & (1 << (i & 7))) out.push(i + 1); return out; }
const STD_LEN = { 1: { 1: 1, 2: 1, 3: 1, 4: 4, 6: 2, 8: 1, 0xb: 2, 0xd: 8 }, 3: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 1, 7: 2, 8: 2, 0xa: 2, 0xb: 1 } };
async function readCtl(unit, sel) {
  let len;
  if (unit === 1 || unit === 3) len = STD_LEN[unit][sel];
  else { const l = await get(0x85, unit, sel, 2); if (l.err) return { err: 'LEN ' + l.err }; len = l.data.readUInt16LE(0); }
  const r = { len };
  const info = await get(0x86, unit, sel, 1); r.info = info.err ? info.err : info.data[0];
  for (const [k, req] of [['cur', 0x81], ['min', 0x82], ['max', 0x83], ['res', 0x84], ['def', 0x87]]) { const x = await get(req, unit, sel, len); r[k] = x.err ? 'ERR' : x.data.toString('hex'); }
  return r;
}
async function dump() {
  const out = {};
  for (const u of Object.keys(bmBytes).map(Number)) for (const s of (u === 1 ? [2, 3, 4, 6, 0xb, 0xd, 8] : u === 3 ? [1, 2, 3, 4, 5, 7, 8, 0xa, 0xb] : selectors(u))) out[`${u}:${s}`] = await readCtl(u, s);
  return out;
}
(async () => {
  open();
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'dump') { const o = await dump(); const s = JSON.stringify(o, null, 0).replace(/\},"/g, '},\n"'); if (a[0]) fs.writeFileSync(a[0], s); else console.log(s); }
  else if (cmd === 'get') { console.log(await readCtl(+a[0], +a[1])); }
  else if (cmd === 'cur') { const o = {}; for (const u of Object.keys(bmBytes).map(Number)) for (const s of (u === 1 ? [2, 3, 4, 6, 0xb, 0xd, 8] : u === 3 ? [1, 2, 3, 4, 5, 7, 8, 0xa, 0xb] : selectors(u))) { const r = await readCtl(u, s); o[`${u}:${s}`] = r.cur; } console.log(JSON.stringify(o)); }
  else if (cmd === 'set') { const r = await xfer(0x21, 0x01, +a[0], +a[1], Buffer.from(a[2], 'hex')); console.log(r.err ? 'ERR ' + r.err : 'ok'); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
