# Evidence

Raw material behind [PROTOCOL.md](../PROTOCOL.md), [G502X-PROTOCOL.md](../G502X-PROTOCOL.md) and
[GHUB-INTERNALS.md](../GHUB-INTERNALS.md). The A50 X material below was captured on 2026-10-20 from a real A50 X (base station firmware 1.2.18) with G Hub
2026.6.981214 on macOS.

| Path | What it is |
|---|---|
| `captures/sniff-agent-start.txt` | Every input report while G Hub's agent restarted: its whole read sequence (all getters and replies) |
| `captures/sniff-sidetone.txt`, `sniff-set.txt` | G Hub setting sidetone (ack + event) |
| `captures/sniff-multi.txt` | G Hub changing balance and tones |
| `captures/sniff-eq-hp.txt`, `sniff-eq-mic.txt` | G Hub applying curated EQ presets from its own UI |
| `captures/sniff-gets.txt` | Agent GETs causing no USB traffic (served from cache) |
| `captures/sniff-eq.txt` | Note: a misclick moved the sidetone slider in this capture; it was restored |
| `captures/lldb-agent-output-reports.txt` | The first 14 output reports from a re-signed agent copy run under LLDB (it stalled after that) |
| `devices-list.json` | G Hub's `/devices/list` reply for the A50 X, including its capability block |
| `agent-device-paths.txt` | Per-device websocket paths found in `lghub_agent` |
| `ghub-protos/` | `.proto` schemas recovered from descriptors embedded in `lghub_agent` |
| `screenshots/ghub-*.png` | G Hub's A50 X pages, captured over CDP |
| `screenshots/logitech-manager-app.png` | This project's app, showing the same headset |

Input report lines are `ms IN bytes`, with trailing zero padding trimmed (`LEN`, the third
byte, gives the real length). The headset's serial number and the paired computer's
Bluetooth name and address are replaced with placeholders; the headset's given name is as
captured.

## G502 X PLUS (`g502x/`)

Captured on 2026-10-20 from a G502 X PLUS (firmware MPM27 27.0.16, receiver 046d:c547 4.2.9)
with the same G Hub build. Report lines are `time IN bytes`; G Hub's requests use software id
0xD (`…d` in the fourth byte), ours 0xB.

| Path | What it is |
|---|---|
| `captures/feature-table.txt` | The 32-entry HID++ feature table |
| `captures/sniff-ghub-agent-start.txt` | G Hub's agent starting: host-mode setup, button spy, RGB handshake, onboard memory read |
| `captures/sniff-ghub-ui-dpi-reportrate-lighting.txt` | G Hub's UI changing DPI, report rate and the lighting effect |
| `captures/sniff-ghub-onboard-mode-and-slot-write.txt` | On-board mode on/off and G Hub writing slot 3 (fn6/fn7/fn8) |
| `captures/ui-actions-timeline.txt` | Timestamp of every UI action, to line up with the captures |
| `onboard/original-*.txt` | Full onboard memory before any change, including factory sectors 0x0100–0x0102 |
| `onboard/ghub-E0…E5-*.txt` | Slot 3 (and the directory) after each G Hub write experiment; see GHUB-INTERNALS.md |
| `ghub/devices-list-g502x.json` | `/devices/list` entry: capabilities, slots, firmware |
| `ghub/ghub-gets.json` | G Hub's mouse, onboard, battery and lighting state |
| `ghub/oracle-round1/2-*.json` | G Hub's decoding of profiles this project wrote into slot 5 |
| `screenshots/*.png` | G Hub's pages for the mouse (sensitivity, assignments, LIGHTSYNC, settings, on-board slots, macro editor) |
| `lab/lab.txt` | 2026-10-23, G Hub closed, a person at the mouse: spy events for each control in onboard (test 1) and host mode (test 2); a firmware macro on G9 typing "hi" (test 3); per-LED frames right after a profile write (test 4, not shown) |
| `lab/lab2.txt`, `lab/lab3.txt` | Per-LED (Freestyle) frames in host and onboard mode, by eye |
| `lab/lab4.txt` | An attempt to map LED numbers by eye (unreliable: the strip is Y-shaped; G Hub's `light_map.json` is used instead) |
| `lab/lab5.txt` | Which `0x8071` effect calls keep per-LED frames visible on an animated profile |
| `lab/handson-1-ghub-running.txt`, `lab/handson-2.txt` | `tools/re/g502x-handson.mjs` through the real CLI and agent: the first with G Hub restarted in the background (Freestyle failed), the second with it closed (all passed) |

In the `lab/` logs, `ANSWER`/`DIALOG` lines are what the person clicked or typed into the
prompt; a "Yes" with a contradicting comment counts as No (lab2, first answer).

The mouse's serial number and unit id are replaced with placeholders, as in the rest of the
evidence.
