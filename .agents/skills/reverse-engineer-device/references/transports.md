# Transports seen so far

Both devices speak a HID++ 2.0 style protocol: a root feature at index 0 maps 16-bit feature
ids to indexes, and requests carry `(function << 4) | software id`. Resolve indexes from the
feature table every time; never hardcode them. Use software id `0xB` so our replies are easy to
tell from G Hub's (`0xD`, `0xA` and `0xE` were seen). Unsolicited events use software id 0.

Find the interface with `node-hid`: list `HID.devices()` for vendor `0x046d` and look at
the usage pages. Open it non-exclusively, so G Hub can keep running while you read. On Linux
it is a hidraw node; add a udev rule like `linux/70-logitech-*.rules` (the `70-` prefix must
sort before systemd's `73-seat-late.rules`).

## Centurion (A50 X base station, `046d:0b0b`)

Details are in `docs/PROTOCOL.md`. Usage page `0xFF32`, report id `0x02`, 64-byte reports:
`02 0c LEN | 00 IDX FNSW params`. Errors are `02 0c 05 | 00 ff IDX FNSW CODE`. The base
station relays to the headset; the headset's Bluetooth link carries audio only. Events arrive
whenever a setting changes, including from the headset's own buttons, so sniffing while G Hub
applies a setting shows the value layout. Tools: `tools/re/hid-sniff.mjs`, `hid-query.mjs`.

## HID++ 2.0 behind a Lightspeed receiver (G502 X PLUS, receiver `046d:c547`)

Details are in `docs/G502X-PROTOCOL.md`. Usage page `0xFF00` (usage 1 = short `0x10` reports,
usage 2 = long `0x11`). Long request: `11 DEV IDX FNSW p0…p15`; the device index is the
receiver slot (1 here; `0xFF` on the cable).

- Feature error: `11 DEV FF IDX FNSW CODE`.
- Receiver error: `10 DEV 8F IDX FNSW CODE`; code `08` means the device is asleep or off. Wait
  for it to wake (the user moves it) and retry the request. A multi-step write (a flash
  session) restarts from its first step; one chunk is never re-sent.
- Find paired devices by reading the receiver's pairing register (`10 FF 83 B5 20+slot`). It
  answers while the device sleeps; pinging each slot stalls.
- Connection notifications (`10 DEV 41 …`, flags bit 6 = link lost) mark sleep and wake.
  Anything set live (software control, button spy, per-LED colours) has to be set again after
  a wake.
- Tool: `tools/re/hidpp.mjs features | send | dump | sniff`. With more than one Logitech
  receiver plugged in, pick one with `HIDPP_PRODUCT=<usb product id, hex>`; `dump` reads
  device index `HIDPP_DEVICE` (default 1, `ff` on the cable).

## Recognising which one

Both use vendor `0x046d`. A vendor usage page with report id `0x02` and `02 0c` framing means
Centurion; `0x10`/`0x11` reports on usage page `0xFF00` mean HID++. G Hub's agent names the
features in both cases (`devio::FeatureXXXX…` classes; `CenturionTransport` for Centurion).
A new transport goes into `docs/` and this file before any code.

A new kind of device brings questions the two so far didn't: a keyboard's HID interfaces
need Input Monitoring permission on macOS to read; a device with Bluetooth, receiver and cable
modes may speak differently in each. Answer them during the inventory, before the plan.
