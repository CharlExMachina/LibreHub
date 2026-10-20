# Reverse-engineering tools

The scripts used to work out the protocol. Rerun them after a firmware or G Hub update.
They run with Node from a directory that has `ws` and `node-hid` installed
(`npm i ws node-hid`), on macOS with G Hub installed unless noted.

| Script | Purpose |
|---|---|
| `ws-get.mjs <path>…` | Read-only GETs against G Hub's agent (`ws://127.0.0.1:9010`, subprotocol `json`) |
| `ws-send.mjs VERB PATH [json]` | One request to the agent, e.g. a SET with a protobuf-JSON payload |
| `hid-sniff.mjs [secs]` | Passive, non-exclusive listener on the base station's input reports. Works on Linux too |
| `probe.sh SECS` | Reads tab-separated `VERB PATH JSON` lines from stdin, sends each to the agent and sniffs the device meanwhile |
| `hid-query.mjs "<payload hex>"…` | Sends raw Centurion packets (`02 0c LEN` is added) with swid `0xB` and prints all input reports. **Writes to the device.** |
| `sweep-vol.mjs` | The bounded sweep that found the volume setter's `ff <level>` layout |
| `cdp.mjs eval\|click\|clicktext\|shot\|html5drag\|type\|key` | Drives G Hub's UI over CDP. Start it with `lghub_ui --notray --remote-debugging-port=9333`. `html5drag` replays a native drag (G Hub's assignment and macro panels use HTML5 drag and drop) |
| `hidpp.mjs features\|send\|dump\|sniff` | G502 X PLUS / Lightspeed receiver: dump the HID++ 2.0 feature table, send raw long reports (swid `0xB`), read whole onboard-memory sectors, or listen passively. Waits while the mouse sleeps. `send` **can write to the device** |
| `ghub-onboard-decode.mjs [--restart] [slot]` | Prints how G Hub decodes the mouse's onboard slots; `--restart` makes G Hub re-read the memory. Used as an independent check of what this project writes |
| `extract_protos.py BINARY OUT.pb` | Finds serialized `FileDescriptorProto`s in a binary (`pip install protobuf`) |
| `render_protos.py OUT.pb DIR` | Renders those descriptors as `.proto` text |
| `lldb-hidtrace.py` | LLDB breakpoint script that logs `IOHIDDeviceSetReport` buffers (needs an ad-hoc re-signed agent copy; see GHUB-INTERNALS.md) |

Safety: read with function 0 getters first. Restore anything you change, and compare
against the bytes **G Hub** produces, not just against your own decoder (see the
sleep-timer note in GHUB-INTERNALS.md).
