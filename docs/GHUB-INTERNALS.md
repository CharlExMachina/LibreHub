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

## G502 X PLUS

The wire format and the full settings map are in [G502X-PROTOCOL.md](G502X-PROTOCOL.md). This
section covers how G Hub handles the mouse and how that was established.

### What G Hub exposes

`/devices/list` reports the mouse as model `g502x_plus` (PID 0x4099, `LIGHTSPEED`) with
capabilities `onboardProfiles.supportsOnboardMode`, `lightingSupport.deviceCategory =
MOUSE_RGB_PER_KEY` (zones `ZONE_PRIMARY` and `ZONE_ALL`, 6 custom-effect slots), `dpiVersion 2`,
`hasWiredReportRate`, `unifiedBattery`, `inputSupport.supportedLayers [LAYER_BASE, LAYER_G]`,
`scrollControls {scrollUp: 13, scrollDown: 12}` and `dpiIndicatorLed` colours for five levels.
Its slots are `g502x-plus_g1_m1` … `g11`, `scroll1`, `scroll2` (each with a `_shifted`
twin), `mouse_settings`, `mouse_sensitivity` and `lighting_setting_firmware`.

Mouse paths (`{id}` from `/devices/list`, `dev00000000` after an agent restart):

| Path | Payload |
|---|---|
| `/mouse/{id}/info` | report rates, DPI range 100–25600 step 50, default 1600 |
| `/mouse/{id}/dpi_shift` | DPI shift state |
| `/onboard_profiles/{id}/onboard_mode` | on-board memory mode |
| `/onboard_profiles/{id}/profiles` | **G Hub's decoding of the five onboard slots** (DPI table, report rate, lighting, `buttonMappings`, `gshiftMappings`) |
| `/onboard_profiles/{id}/active_profile`, `…/profile`, `…/restore_defaults`, `…/enable_profile` | slot management |
| `/lighting/{id}/state`, `…/power_saving`, `…/firmware/effects`, `…/custom/effects`, `…/brightness` | LIGHTSYNC, inactivity timers, stored animations |
| `/battery/{id}/state` | percentage, mileage, per-component power consumption |

G Hub's device depot for the model (`depots/<build>/<uuid>/` with `manifest.json` naming
`g502x_plus`) holds `defaults_override.json` (default cards and the curated
`MOUSE_SETTINGS_ADVANCED` DPI prefabs), `light_map.json` (8 per-key LEDs), `metadata.json`
(button marker positions on the device image) and `lighting_effects.json`.

The default cards encode the assignment in their last bytes, using the enums of
`logi.protocol.macros.Macro` (`ghub-protos/macros.proto`): `…-0201…` = mouse button 1,
`…-0403…` = Mouse action 3 (DPI_SHIFT), `…-0901…` = Device action 1 (PROFILE_CYCLE). Read
alongside the button markers, this gives the slot-to-control map.

### Method

1. **Feature table and state**: `tools/re/hidpp.mjs features` and a handful of getters, read
   non-exclusively next to G Hub (software id 0xB versus G Hub's 0xD).
2. **G Hub's startup**: sniffing the receiver while restarting `lghub_agent` showed the whole
   host-mode setup: `setMode(2)`, MouseButtonSpy start, the RGB software-control handshake,
   DPI and report rate (`captures/sniff-ghub-agent-start.txt`).
3. **Driving G Hub's UI over CDP** (`tools/re/cdp.mjs`) while sniffing, with a timestamped log of
   each click (`captures/ui-actions-timeline.txt`): DPI, report rate, effects, the on-board
   memory toggle. Replies to setters do not echo their parameters, so live captures show *which*
   function G Hub calls but not always *what* it sends.
4. **Letting G Hub write the onboard format**: in on-board mode, "Enable with new" / "Replace
   with" on slot 3 makes G Hub convert its software profile and write the sector. Five rounds
   (E0–E5), each changing a few things in G Hub first and reading the sector back afterwards,
   pinned down the layouts: Fixed and Breathing (E0), Colour Wave and "Dim Active Effect" with
   2 min / never (E1), wave direction and brightness, Neutron Null, 5 / 15 min (E2), Cycle (E3),
   the split wave period (E4: 18500 ms = `44 … 48`), and Disable, macros, Double Click, Go to
   DPI Shift and Cycle Maximum Brightness (E5, assigned with replayed HTML5 drags).
5. **G Hub as an independent decoder**: write a deliberately varied profile into a spare slot
   with this project's encoder, restart `lghub_agent` so it re-reads the memory, and compare
   `/onboard_profiles/{id}/profiles` with what was meant (`ghub/oracle-round*.json`,
   `tools/re/ghub-onboard-decode.mjs`). G Hub agreed on report rate, DPI levels, default and
   shift, name, keystrokes, media keys, every firmware function, breathing and colour-wave
   parameters.
6. **Hardware tests** (`test/hardware/g502x.hw.test.ts`, run with G Hub quit): every setting is
   changed, read back independently (including the sensor DPI and report rate the mouse
   actually runs after a profile switch), and restored; all 16 sectors are compared at the end.

Cross-checks: the onboard layout matches libratbag's `hidpp20` profile format and Solaar's
`OnboardProfile`; button function codes and LED effect ids match both. Where they disagree
with G Hub (Solaar's wave layout, the meaning of `FF FF FF FF`), G Hub's own writes win.

### Dead ends and corrections

- **"Disabled"**: `80 00 00 00` (a HID no-op) looked right but G Hub decodes it as "native
  button"; G Hub's own Disable is `90 00 00 00`. `FF FF FF FF` is not "disabled" either: the
  factory profiles leave the scroll wheel like that and it scrolls normally.
- **Wave period**: Solaar assumes a contiguous big-endian period for effect 0x04; G Hub writes
  the low byte at offset 7 and the high byte at offset 10. Two G Hub writes (5000 and 18500 ms)
  and G Hub's decoding of a third (7000 ms) agree.
- **Macros**: the mouse advertises macro format 1, but G Hub 2026.6 writes only a placeholder
  binding for a macro and no macro data.
- **Erasing a sector**: a write whose CRC is wrong fails at write end with error 04; since
  write start erases the sector, writing all `FF` leaves it erased, which is how
  `eraseSector()` works.
- **Lighting enumeration**: `0x8071` getInfo for cluster 0xFF has no cluster record; its effects
  are listed until the mouse answers "invalid argument".
- **A sleeping mouse**: discovery originally pinged each receiver slot and stalled while the
  mouse slept; the receiver's pairing register answers regardless, so discovery uses that.

### Things that were touched and restored

All 16 onboard sectors were backed up before the first experiment
(`onboard/original-*.txt`) and restored byte for byte at the end with this project's own
writer (the hardware suite re-checks this after every run). G Hub's software profile ("Desktop:
Default") was put back to Pulsar Point 32 ms, Neutron Null, 1 min / 5 min, default
assignments, and the test macro was deleted. The startup effect was toggled and returned to off.
