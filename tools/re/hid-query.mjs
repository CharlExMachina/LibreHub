// Send read-only Centurion queries (swid 0xB) to the A50 X base station and print every input report.
// Each arg is a hex payload (after the 02 0c LEN header), e.g. "00 00 0b 06 04".
import HID from 'node-hid';
const info = HID.devices().find(d => d.vendorId === 0x046d && d.productId === 0x0b0b && d.usagePage === 0xff32);
const dev = new HID.HID(info.path, { nonExclusive: true });
const hex = (a) => [...a].map(x => x.toString(16).padStart(2, '0')).join(' ');
dev.on('data', (b) => { let e = b.length; while (e > 8 && b[e - 1] === 0) e--; console.log('   IN ', hex(b.slice(0, e))); });
const payloads = process.argv.slice(2).map(s => s.trim().split(/\s+/).map(x => parseInt(x, 16)));
for (const p of payloads) {
  const pkt = new Array(64).fill(0); pkt[0] = 0x02; pkt[1] = 0x0c; pkt[2] = p.length; p.forEach((v, i) => (pkt[3 + i] = v));
  console.log('OUT', hex(pkt.slice(0, 3 + p.length)));
  dev.write(pkt);
  await new Promise(r => setTimeout(r, 400));
}
setTimeout(() => { dev.close(); process.exit(0); }, 600);
