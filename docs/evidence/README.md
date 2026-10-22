# Evidence

Raw material behind [PROTOCOL.md](../PROTOCOL.md) and [GHUB-INTERNALS.md](../GHUB-INTERNALS.md),
captured on 2026-10-20 from a real A50 X (base station firmware 1.2.18) with G Hub
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
byte, gives the real length). The captures include the headset's serial number, its
given name, and the paired computer's Bluetooth name and address.
