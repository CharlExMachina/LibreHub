# How G Hub talks to the A50 X, and how that was worked out

Studied: G Hub 2026.6.981214 (build 876194) on macOS, A50 X base station firmware 1.2.18.
The wire-level result is in [PROTOCOL.md](PROTOCOL.md); this document covers G Hub's
architecture and the method, so the work can be repeated after a firmware or G Hub update.

## Architecture

```
lghub_ui (Electron 39) ── renderer ── preload bridge ── main.js
                                                      │  ws://localhost:9010, subprotocol "json"
                                                      ▼
                                        lghub_agent (native C++, ~240 MB)
                                          devio::FeatureXXXX classes  (one per device feature)
                                          CenturionPacketLayer / CenturionTransport
                                                      │  IOHIDDeviceSetReport, report ID 0x02
                                                      ▼
                                  A50 X base station, USB 046d:0b0b ── Lightspeed ── headset
```

- **`lghub_ui`** is an Electron app (`Contents/MacOS/lghub_ui.app/Contents/Resources/app.asar`).
  Its main process opens the websocket; the renderer is a React bundle (`app.min.js`, no
  source map) and talks to main through a preload bridge.
- **`lghub_agent`** owns every device. It listens on `127.0.0.1:9010` and accepts
  `Origin: file://` with subprotocol `json`. It links IOKit HID plus CoreBluetooth and
  IOBluetooth, but uses Bluetooth only for Logitech's Bluetooth HID devices (it enumerates
  paired devices and matches them against its device database).
- **`lghub_system_tray`** relaunches the UI; the **UI relaunches the agent** if it dies.
- Device definitions under `/Library/Application Support/Logi/LGHUB/depots/<build>/core/data/devices/`
  are mostly encrypted (a `key-id` / `file-sha` header, then ciphertext). They were not
  decrypted, and didn't need to be.

## The websocket API (UI ↔ agent)

Envelope: `{"msgId":"<n>","verb":"GET|SET|SUBSCRIBE|…","path":"…","payload":{…}}`.
Payloads are protobuf messages rendered as JSON with an `@type` Any URL. The agent embeds
103 serialized `.proto` descriptors. The audio, devices, wireless and centurion ones are in
`evidence/ghub-protos/`, recovered with `tools/re/extract_protos.py`.

GETs are served from the agent's cache, with no USB traffic. A SET makes the agent write
to the device; the device then emits an event, and the agent updates its cache from that
event. The agent therefore also picks up changes made by other programs (including this
one) while G Hub is running.

A50 X paths (`{id}` = `dev00000000`):

| G Hub control | Path | Payload |
|---|---|---|
| Sidetone | `/audio/{id}/sidetone` | `audio.Volume {gain: step/6, channel: SIDETONE}` |
| Balance | `/audio/{id}/centurion_mix` (+ `_info`) | `audio.Mix {balance 0..12}` |
| Device volume | `/audio/{id}/centurion/volume` | `audio.Volume {gain, channel: OUTPUT}` |
| Sleep after | `/battery/{id}/sleep_timer` | `devices.SleepTimer {shutdown: minutes}` |
| Base station brightness | `/lighting/{id}/firmware/brightness` | `util.Number {value}` |
| Tones | `/audio/{id}/headset_tones` | `audio.HeadsetTones {state}` |
| Noise gate | `/audio/{id}/centurion/mixer_mic` | `cards.Card {attribute: CENTURION_MIXER_MIC, centurionMixerMic: {noiseGate}}` |
| Routing | `/audio/{id}/mixing_matrix` (+ `/info`, `/state`) | `audio.MixingMatrix` (gains as %) |
| EQ | `/audio/{id}/equalizer_manager/information` | `UnifiedEqualizer.Information`; presets are applied as cards |
| Battery | `/battery/{id}/state` | `wireless.Battery` |
| Bluetooth host | `/hosts_info/{id}/bluetooth` | `wireless.BluetoothHost` |
| Firmware / hardware | `/devices/{id}/centurion/firmware_info`, `…/hardware_info`, `…/serial_number` | |

`/devices/list` returns the device with its capability block. For the A50 X it includes
`unifiedEqualizer.type = CENTURION_ADVANCED_PARAMETRIC` (instances MICROPHONE / HEADPHONES),
`hasSidetoneInSettings`, `hasCenturionVolumeInSettings`, `balanceMixerInSettings`,
`hasAudioMixingMatrix`, `hasHeadsetTones`, `autoSleep`, `powerOffTimer`, `ledBrightness`,
`wirelessSupport.btHostInfo` and `hasEuPowerModeControl`. The full dump is in
`evidence/devices-list.json`.

## What G Hub shows for the A50 X

Screenshots are in `evidence/screenshots/`:

- **Microphone**: Equalizer (curated Broadcast / Competition / Default, plus custom) and
  Noise Gate (Off / Night / Home / Tournament), plus Mic Test.
- **Headphones**: Equalizer (curated Default / Gaming / Media, plus custom).
- **Routing**: Stream Port level, and Mic Out / Game / Bluetooth / Voice levels with mutes.
- **Settings**: Sidetone, Balance (Game ↔ Voice), Device Volume, Sleep After
  (Never / 15 / 30 / 60 minutes), Base Station Brightness, Bluetooth host, Tones
  (None / All / Minimal), firmware, factory reset.

There is no separate "mic volume". The mic level G Hub exposes is the Mic Out level of the
stream-port mix. On Linux the headset mic's capture level is the ordinary ALSA/PipeWire
input volume.

## Method

1. **Static analysis of the UI** with [REA](https://github.com/morluto/rea)
   (`rea analyze-javascript-application`, `rea extract-artifact` on `app.asar`) found the
   websocket client, the path constants and the A50 X model id `a50_x`.
2. **Agent strings and symbols**: the `devio::Feature0604HeadsetAudioSidetone`-style class
   names, log strings ("Centurion device pid … usage … report id …") and mangled signatures
   (`setVolumeLevel(unsigned char)`, `setMuteState(bool)`) named the features and argument
   types.
3. **Protobuf schemas**, extracted from the agent binary, gave exact payload types and
   enums (noise gate values, mixing matrix types, EQ audio paths).
4. **Live driving**: `tools/re/ws-send.mjs` makes G Hub's agent apply a setting while
   `tools/re/hid-sniff.mjs` listens non-exclusively to the base station's input reports.
   The device's acknowledgement shows the function number; its event shows the value
   layout.
5. **Restarting the agent** while sniffing captured its whole startup read sequence, i.e.
   every getter and its reply layout.
6. **Driving G Hub's own UI**: relaunching `lghub_ui` with `--remote-debugging-port`
   (Chromium switch; Electron's Node inspector fuse is off) and clicking curated presets via
   CDP (`tools/re/cdp.mjs`) captured how presets are applied.
7. **Replicating** each write with our own software id (`tools/re/hid-query.mjs`) and
   checking that the device state matches what G Hub's write produced.

### Dead ends and corrections

- **Sniffing G Hub's outgoing reports.** macOS has no software view of HID output reports.
  A re-signed copy of `lghub_agent` was run under LLDB with breakpoints on
  `IOHIDDeviceSetReport`; it logged the first 14 writes, then stalled during enumeration
  (likely missing keychain or system-extension entitlements). The device-event method above
  was enough without it.
- **Volume setter.** One-byte writes failed with `03` and two-byte guesses with `05`. A
  bounded sweep found `ff <level>` in about a second.
- **Sleep timer.** An early "verified" one-byte write round-tripped through my own reader
  but left the device at `[30][0]`, which means never sleep. Comparing against G Hub's own
  writes (`3c 0f`, `3c 1e`, …) caught it. Lesson: verify against the bytes G Hub produces,
  not against your own decoder. `test/hardware` now compares the full raw state.
- **EQ preset reads** (`fn5`) have no leading byte, unlike live reads (`fn1`); the unit
  tests caught a decoder that assumed otherwise.

### Things that were touched and restored

During the investigation sidetone, volume, mute, balance, sleep, brightness, tones, noise
gate, routing and both EQs were changed briefly and restored. The final state was checked
field by field against a snapshot taken beforehand, and the device's settings checksum
returned to its original value (`f8 72 0e ad`).
