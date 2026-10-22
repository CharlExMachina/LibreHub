// Passive, non-exclusive listener on the A50 X base station's vendor HID interface. Never writes.
import HID from 'node-hid';
const secs = Number(process.argv[2] || 10);
const info = HID.devices().find(d => d.vendorId === 0x046d && d.productId === 0x0b0b && d.usagePage === 0xff32);
if (!info) { console.error('A50 X vendor interface not found'); process.exit(1); }
const dev = new HID.HID(info.path, { nonExclusive: true });
const t0 = Date.now();
dev.on('data', (b) => { const hex = [...b].map(x => x.toString(16).padStart(2, '0')); let end = hex.length; while (end > 8 && hex[end - 1] === '00') end--; console.log(String(Date.now() - t0).padStart(6), 'IN ', hex.slice(0, end).join(' ')); });
dev.on('error', (e) => console.error('ERR', e.message));
setTimeout(() => { dev.close(); process.exit(0); }, secs * 1000);
