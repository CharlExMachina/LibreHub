---
name: reverse-engineer-device
description: Reverse-engineer how Logitech G Hub drives a device and add that device or setting to Libre Hub, from the first capture to a tested, documented PR. Use when adding a new Logitech device, mapping a G Hub setting or feature the app lacks, or rechecking a protocol after a G Hub or firmware update.
---

# Reverse-engineering a Logitech device

The process that mapped the A50 X headset (Centurion over USB) and the G502 X PLUS mouse
(HID++ 2.0 over a Lightspeed receiver). Their results are the worked examples: read
`docs/GHUB-INTERNALS.md` (architecture and method), `docs/PROTOCOL.md` and
`docs/G502X-PROTOCOL.md` (wire format and settings maps) and `tools/re/README.md` (scripts)
before starting. G Hub runs on macOS or Windows; the target is Linux, so the investigation
happens on a machine with G Hub and the result must work without it. The scripts in
`tools/re/` need `ws` and `node-hid` (`npm i ws node-hid` in a scratch folder); several are
specific to one device (see `tools/re/README.md`), so copy and adapt them for a new one.

## Ground rules, every step

- **G Hub is the oracle.** Copy the bytes G Hub writes, and have G Hub decode the bytes you
  write. A round trip through your own decoder proves nothing: the A50 X sleep timer
  "verified" that way was wrong on the device.
- **Back up, then restore.** Snapshot the device state (every readable setting, or every
  memory sector) before the first write; at the end, compare against the snapshot field by
  field. Note in the docs what was touched and that it was restored.
- **Evidence.** Every claim in the docs points at a capture, dump, log or screenshot under
  `docs/evidence/<device>/` (the A50 X predates this and sits at the top level), indexed in
  `docs/evidence/README.md`. Name `.txt`, not `.log` (gitignored).
- **Public repo.** Replace serial numbers, unit ids, Bluetooth host names and addresses,
  usernames and local paths with placeholders before committing (see `test/fixtures` and the
  evidence files for the placeholder style).
- **One driver at a time.** Quit G Hub (`lghub_agent`, `lghub_system_tray`, `lghub_ui`)
  before any write or hardware test, and check again before each one: on macOS it can
  relaunch itself minutes later and silently undo or fight your changes. Read alongside G Hub
  only, with this project's software id `0xB`.

## Steps

1. **Inventory.** Screenshot every G Hub page for the device (`screencapture -x -R x,y,w,h`
   on the G Hub window, or ask the user for screenshots). Dump its `/devices/list` entry
   (capabilities, slots) and its depot folder (`light_map.json`, `metadata.json`,
   `defaults_override.json`): see [G Hub on macOS](references/ghub-macos.md). Check that
   what the user asked for exists on this model before promising it (G Hub's page, and later
   the feature table). Done when a table lists every G Hub control for the device, with an
   empty "where it lives" column.
2. **Static pass with REA.** REA ("reverse engineer anything",
   [morluto/rea](https://github.com/morluto/rea)) analyses the shipped G Hub. Install it with
   `npx rea-agents setup`, which registers its MCP server and its `reverse-engineer-anything`
   skill; follow that skill for the tools. If its tools don't show up in this session, use the
   CLI, which needs no registration:
   `npx -y rea-agents@latest analyze-javascript-application <app.asar or extracted dir> --json`
   (and `extract-artifact`). Run it on `lghub_ui`'s `app.asar` for the websocket paths and
   model id. Read the agent binary's feature class names, log strings and embedded protobuf
   schemas (`tools/re/extract_protos.py`, `render_protos.py`); the binary is
   `/Applications/lghub.app/Contents/MacOS/lghub_agent.app/Contents/MacOS/lghub_agent`.
   Done when you know the device's model id, its transport and the names of its features.
3. **Talk to it.** Identify the transport and read its feature table with our software id:
   see [transports](references/transports.md). Done when a getter you send returns a reply
   you can decode.
4. **Map every setting.** For each row of the table, make G Hub apply the setting
   (websocket SET, or its UI) while sniffing the device. Restart `lghub_agent` once while
   sniffing to capture its whole startup read sequence. For anything stored on the device
   (profiles, slots), make G Hub write it, read the memory back, and vary one thing per round.
   Then replicate the write with `0xB` and check that the device ends up in the state
   G Hub's write produced. Done when every row has its bytes and an evidence file, or a
   reason it can't be stored on the device.
5. **Go past G Hub where the hardware allows.** "Software only" in G Hub means G Hub does it
   from the computer, not that the device can't. Probe the advertised capabilities G Hub
   doesn't use. The G502's firmware plays onboard macros, and its button spy works in
   onboard mode too. Anything that only a hand or eye can confirm (a typed macro, a lit LED)
   needs a person: see [hands-on testing](references/hands-on.md).
6. **Implement.** A new device gets its own folder, modelled on `src/mouse/` (the newer of
   the two): framing and codecs, a transport that finds the device, a client that matches
   replies and survives sleep, a service shared by the app and the CLI, and a CLI with a
   `bin` entry in `package.json`. Wire it to the app with a module like
   `src/main/mouse-ipc.ts` and a bridge in `src/main/preload.cjs`. A window page in
   `src/renderer/` is a separate decision: ask the user (the G502 has none yet). Add a udev
   rule in `linux/`. Tests: unit tests built from captured frames, a simulator in `test/sim/`
   that behaves like the firmware (errors, sleep, storage), and a hardware test file with
   its own `test:hardware:<device>` script that restores everything it touches. Break each
   new behaviour on purpose and see its test fail. Done when `npm run typecheck`,
   `npm test` and the device's hardware script pass, and every deliberate break failed a
   test.
7. **Verify independently.** Where G Hub can read the device, have it decode what you wrote
   (G502: write a slot, restart the agent, compare `/onboard_profiles/{id}/profiles`). Run the
   hardware suite more than once. Do a hands-on check through the real CLI for anything
   physical.
8. **Document and open the PR.** Update the settings map (with a "Verified" column saying
   how), the method, dead ends and restored state in `GHUB-INTERNALS.md`, the evidence index
   and the README tables. The PR needs a demo (the repo's `CLAUDE.md` on `main`); recording
   without leaking the rest of the screen is in
   [hands-on testing](references/hands-on.md#recording-a-demo).

## Lessons that cost time

- A reply that doesn't echo parameters shows *which* function G Hub called, not *what* it
  sent. Get the payload from G Hub's own stored writes, its protobufs, or a bounded sweep
  (the A50 X volume setter was found by sweeping).
- "Looks like a no-op" isn't G Hub's encoding. On the G502, `80 00 00 00` reads as
  "native button" to G Hub; its Disable is `90 00 00 00`.
- Library layouts (libratbag, Solaar) are good cross-checks, not truth: the G502's wave
  period is split across two offsets in G Hub's writes.
- Devices sleep. Answer "unknown device" by waiting and retrying, never by repeating one
  chunk of a multi-step write; restart the whole write session instead.
- After a mode or profile change the device repaints its own state shortly after; anything
  you set live right before it can be overwritten (G502 per-LED colours).
- Not every device has reports to sniff. A UVC camera's settings are control requests with no
  echo: read every control before and after each G Hub SET and diff (MX Brio). And G Hub can't
  decode for you if it writes its own profile whenever it sees the device.
- Write findings to the docs as you go: the session that finds them may not be the one that
  finishes.
