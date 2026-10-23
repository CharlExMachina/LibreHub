# G Hub on macOS: where to look and how to drive it

What G Hub is made of and the handles this project used on it. Paths and ports are from
G Hub 2026.6 on macOS; re-check them after an update (G Hub updates itself). The full write-up
is `docs/GHUB-INTERNALS.md`.

## The pieces

| Process | What it is | Handle |
|---|---|---|
| `lghub_ui` | Electron UI, `Contents/MacOS/lghub_ui.app/Contents/Resources/app.asar` | REA static analysis; CDP (below) |
| `lghub_agent` | native C++ service that owns every device | websocket API on `127.0.0.1:9010`; its strings, symbols and embedded protobufs |
| `lghub_system_tray`, `lghub_updater` | relaunch the UI and the agent, update G Hub | quit them too, or G Hub comes back |

Quitting: `pkill -x lghub_system_tray; pkill -x lghub_ui; pkill -x lghub_agent`. G Hub has
relaunched itself about ten minutes later, so check `pgrep -fl lghub` before each experiment.
Relaunch normally with `open -a lghub`.

## The websocket API

`ws://127.0.0.1:9010`, subprotocol `json`, `Origin: file://`. Envelope:
`{"msgId":"1","verb":"GET|SET|SUBSCRIBE","path":"…","payload":{…}}`. Payloads are protobuf
messages as JSON with an `@type`. Tools: `tools/re/ws-get.mjs` and `ws-send.mjs`. To sniff
while sending, run the transport's sniffer (`hidpp.mjs sniff`, or `hid-sniff.mjs`, which only
opens the A50 X) next to `ws-send.mjs`; `probe.sh` combines the two for the A50 X and runs
from inside `tools/re/`.

- GETs come from the agent's cache, without touching the device. A SET makes the agent write
  to the device. The agent also picks up changes other programs make, from the device's
  events.
- Device ids look like `dev00000000`, taken from `/devices/list`; they can change when the
  agent restarts.
- `/devices/list` holds the capability block: the cheapest way to learn what G Hub thinks a
  device can do.
- Path names are in the UI bundle (REA on `app.asar`) and the agent's strings
  (`strings -n 5 lghub_agent | grep -E '^/[a-z_]+(/[a-z_{}]+)*$'`).

## Protobuf schemas

The agent embeds its `.proto` descriptors as serialized `FileDescriptorProto`s.
`tools/re/extract_protos.py <binary> out.pb` finds them and `render_protos.py out.pb dir/`
writes `.proto` text (needs `pip install protobuf`). They give exact payload types and enums;
the ones used so far are in `docs/evidence/ghub-protos/`.

## Device depots

`/Library/Application Support/Logi/LGHUB/depots/<build>/<uuid>/`, one folder per model
(`manifest.json` names it). The core device database is encrypted and wasn't needed. The
per-model folders are plain JSON:

- `metadata.json`: positions of the button markers and LED dots on G Hub's device picture.
  It is the reliable way to name physical controls and LEDs. A person describing positions
  is not: the G502's light strip is Y-shaped and the by-eye map came out wrong.
- `light_map.json`: G Hub's LED dot → firmware LED index.
- `defaults_override.json`: default assignments and curated presets (the G502's DPI prefabs).
- `lighting_effects.json`: effect definitions.

## Driving the UI (CDP)

Relaunch the UI with the Chromium debugging switch, then drive it with `tools/re/cdp.mjs`
(`eval`, `click`, `clicktext`, `shot`, `type`, `key`, `html5drag`):

```bash
pkill -x lghub_ui; /Applications/lghub.app/Contents/MacOS/lghub_ui.app/Contents/MacOS/lghub_ui --notray --remote-debugging-port=9333 &
```

- G Hub's assignment and macro panels use HTML5 drag and drop: use `html5drag`, which goes
  through `Input.setInterceptDrags`. Plain mouse drags do nothing.
- Reach off-screen list items through the panel's search box instead of scrolling.
- Keep a timestamped log of each UI action next to the device capture, so the two can be lined
  up (`docs/evidence/g502x/captures/ui-actions-timeline.txt`).
- After G Hub's update of 2026-10-23 the switch no longer opened a port. If that holds, use
  the websocket API, which is what the UI itself calls, and take screenshots with
  `screencapture` or from the user.

## Capture tricks that worked

- **Startup sequence**: restart `lghub_agent` while sniffing. Its startup reads every getter,
  which gives each reply's layout.
- **Stored formats**: make G Hub write device storage for you (G502: in on-board mode, an
  on-board slot's "Replace with"), then dump the memory. Change one thing per round.
- **G Hub as decoder**: write with your own encoder, restart the agent so it re-reads the
  device, and GET its decoding (`tools/re/ghub-onboard-decode.mjs`).
- **G Hub's own requests are invisible.** macOS shows HID input reports only, so you see the
  device's replies to G Hub (by their software id), not what G Hub sent. Running a re-signed
  agent under LLDB with breakpoints on `IOHIDDeviceSetReport` (`tools/re/lldb-hidtrace.py`)
  logged a few writes, then stalled. The methods above were enough.

Windows has not been tried. The architecture is presumably the same, but none of these paths
or switches has been checked there.
