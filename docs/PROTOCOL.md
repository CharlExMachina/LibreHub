# A50 X control protocol

How to control a Logitech A50 X headset, byte by byte. Everything below was observed
on a real A50 X (base station firmware **1.2.18**, model id 36, hardware revision 7) and
then exercised by `test/hardware/`. Captured frames used by the unit tests are in
`test/fixtures/captures.ts`; the raw logs are in `docs/evidence/captures/`.

## Transport

Settings go to the **base station over USB**, never over Bluetooth. The headset's
Bluetooth link to a computer carries audio only (HFP/A2DP/AVRCP); it exposes no HID or
GATT service, reports vendor `0x000A` / product `0xFFFF`, and G Hub does not see it.
The base station relays everything to the headset over Lightspeed.

| | |
|---|---|
| USB device | `046d:0b0b` "A50 X" (full speed, 12 Mb/s) |
| HID interface | usage page `0xFF32`, usage `0x74` |
| Report descriptor | `06 32 ff 09 74 a1 01 a1 03 85 02 75 08 15 00 26 ff 00 95 3f 09 75 81 02 75 08 15 00 26 ff 00 95 3f 09 76 91 02 c0 c0` |
| Reports | report ID `0x02`; 63-byte input (usage 0x75) and 63-byte output (usage 0x76), i.e. 64 bytes on the wire |

Opening the interface non-exclusively works on macOS while G Hub is running; on Linux it
is a plain hidraw node (see `linux/70-logitech-a50x.rules`).

## Framing

```
02 0c LEN | DEV IDX FNSW params… | zero padding to 64 bytes
```

| Field | Meaning |
|---|---|
| `02` | HID report ID |
| `0c` | constant in all observed traffic (meaning unknown) |
| `LEN` | count of bytes that follow: `DEV IDX FNSW` + params |
| `DEV` | always `00` here; probably a device/route byte (not probed) |
| `IDX` | feature index, resolved through the Root feature |
| `FNSW` | `(function << 4) \| swid`. A request picks a software id 1..15 and the reply echoes it. Unsolicited events use swid 0. G Hub's agent picked `0xA` in one session and `0xE` in another; this project uses `0xB`. |

Error reply: `02 0c 05 | 00 ff IDX FNSW CODE`.

| Code | Seen when |
|---|---|
| `02` | calling a function the feature doesn't have |
| `03` | too few parameter bytes |
| `05` | an argument the feature rejects (unknown feature ID, wrong channel byte, index past the end) |
| `0b` | a value out of range |

This is structurally HID++ 2.0 under different IDs; Logitech's code calls it
**Centurion** (`CenturionTransport` → `CenturionPacketLayer` → features). Events are pushed
whenever a setting changes, including changes made with the headset's own controls.

## Feature discovery

Root (`0x0000`) always lives at index 0. Function 0 takes a 16-bit feature ID and returns
`[index][type][version]`. FeatureSet (`0x0001`) function 0 returns the count, and
function 1 (`start`) returns `[n]` followed by `n × (idHi idLo type version)`, at most 14
per reply. Don't hardcode indexes; resolve them. On firmware 1.2.18 they are:

| idx | ID | v | G Hub class name | Controlled here |
|---|---|---|---|---|
| 0 | `0000` | 2 | Root | discovery |
| 1 | `0001` | 1 | FeatureSet | discovery |
| 2 | `010A` | 6 | GenericDFU | no (firmware update, deliberately untouched) |
| 3 | `0102` | 1 | (none) | no |
| 4 | `0100` | 6 | DeviceInfo | read |
| 5 | `0101` | 2 | DeviceName | read |
| 6 | `0104` | 4 | BatterySOC | read |
| 7 | `0108` | 3 | AutoSleep | yes |
| 8 | `0200` | 4 | VolumeSet | yes |
| 9 | `0604` | 2 | HeadsetAudioSidetone | yes |
| 10 | `0609` | 2 | HeadsetMix | yes |
| 11 | `0303` | 4 | (none) | no |
| 12 | `0800` | 1 | MixerAudio | yes |
| 13 | `020D` | 1 | AdvancedParaEQ | yes |
| 14 | `0305` | 1 | BtHostInfo | read |
| 15 | `0110` | 1 | LEDBrightness | yes |
| 16 | `060B` | 1 | HeadsetTones | yes |
| 17 | `0103` | 1 | Memfault | no |
| 18 | `0004` | 4 | Profile | settings-checksum events |
| 19 | `020E` | 2 | MicTest | no |
| 20 | `0806` | 1 | (none) | no |
| 21 | `0805` | 1 | (none) | no |
| 22 | `0801` | 1 | MixerMic | yes (noise gate) |
| 23 | `0807` | 1 | (none) | no |

G Hub never touches `0102`, `0303`, `0805`, `0806` or `0807`.

## Features

Notation: `fnN(args) → reply`. "Event" means an unsolicited swid-0 frame with the given
function number. Every setter below was checked against the bytes G Hub itself produces.

### Sidetone (`0604`)

| | |
|---|---|
| `fn0() → [01][01][ff][step]` | current step (one record: count, channel, `ff`, step) |
| `fn1([01][ff][step])` | set; G Hub's slider 0..100 maps to steps 0..6 |
| `fn2() → [ee][00][07]` | info: 7 steps |
| event fn0 | same layout as `fn0` |

The middle byte of the setter isn't understood; `01 01 05` was also accepted.

### Device volume (`0200`)

| | |
|---|---|
| `fn0() → [scale][muted][level]` | `level` is 0..21; `scale` is a derived 0..31 value (31 at level 21, 28 at level 19) |
| `fn1([ff][level])` | set level. `ff` is the "render" channel; anything else gives error `05`. G Hub logs "Only Render volume can be set through feature 0200" |
| `fn2([0\|1])` | mute / unmute |
| `fn3() → [22]` | number of levels |
| event fn0 | same layout as `fn0` |

G Hub's "Device volume 100" is level 21.

### Game / voice balance (`0609`)

| | |
|---|---|
| `fn0() → [balance]` | 0..12, 6 = centered |
| `fn1([balance])` | set |
| `fn2() → [12][05][04]` | max step, then left/right source codes |
| event fn0 | `[balance]` |

G Hub's metadata (`balanceMixerInSettings.inverted = true`, left = GAME, right = VOICE)
shows its slider is drawn inverted relative to the raw value. Which end is all-game
wasn't confirmed by ear.

### Sleep timer (`0108`)

| | |
|---|---|
| `fn0() → [3c][minutes]` | `minutes` 0 = never |
| `fn1([3c][minutes])` | set. **Send both bytes.** G Hub writes Never / 15 / 30 / 60 as `3c 00` / `3c 0f` / `3c 1e` / `3c 3c` |
| event fn0 | `[3c][minutes]` |

The device also accepts a 1-byte write but then stores `[value][00]`, i.e. *never sleep*.
That happened during this investigation and was caught by comparing against G Hub's
bytes. The meaning of the `3c` (60) lead byte is unknown.

### Base station brightness (`0110`)

| | |
|---|---|
| `fn0() → [percent]` | 0..100 |
| `fn1([percent])` | set |

There's no event of its own. A Profile (`0004`) event carrying a new settings checksum
follows instead (`00 00 f8 72 0e ad` with the original settings).

### Headset tones (`060B`)

| | |
|---|---|
| `fn0() → [state]` | 0 = none, 1 = all, 2 = minimal (G Hub labels; protobuf DISABLED / ENABLED / PARTIALLY_ENABLED) |
| `fn1([state])` | set |
| event fn0 | `[state]` |

### Mic noise gate (MixerMic, `0801`)

| | |
|---|---|
| `fn0() → [40]` | capabilities (unknown bits) |
| `fn1() → [gate]` | current gate |
| `fn2([gate])` | set |
| `fn3() → [n][gate…]` | supported gates; A50 X: `04 00 01 02 04` |
| event fn0 | `[gate]` |

Values follow G Hub's `MixerMic.NoiseGateSetting` enum: 0 off, 1 home, 2 night,
3 stream, 4 tournament, 5 push-to-talk, 6 ClearVoice. The A50 X supports off, home,
night and tournament.

The thresholds aren't exposed. What can be observed, on the USB mic stream (Linux, Pro
Audio profile, firmware 1.2.18, quiet room, nobody talking): with the gate off the mic sends
room noise peaking around −60 dBFS; with any of the three gates closed it sends digital
silence, ±1 LSB of 16-bit (−90.3 dBFS peak, about 73% exact zeros). The app's Microphone
page uses this to show when the gate is open or closed.

### Stream-port mix (MixerAudio, `0800`)

This is G Hub's "Routing" page: what the stream port (`USB_STREAM`) outputs and how
loud each source is in it.

| | |
|---|---|
| `fn0() → [n] n×(type ? ? index)` | inputs: `0a` mic (index 0), `06` game (1), `09` bluetooth (2), `07` voice (3) |
| `fn1() → [n] n×(type ? ? index routedMask)` | outputs: `09` stream (index 0), routed mask `0f` |
| `fn4() → [4][e0][00][21]` | max inputs 4, gain −32..0 dB, 33 steps |
| `fn5(output) → [gain][muted][n] n×(input gain muted)` | state; gains are steps 0..32 (G Hub shows step/32 as %) |
| `fn6([output][gain][muted][n] n×(input gain muted))` | set the whole state |
| event fn2 | `[output]` + the `fn5` layout |

The type codes match G Hub's `MixingMatrix.Input.Type` / `Output.Type` enums.

### Equalizers (AdvancedParaEQ, `020D`)

There are two instances: **0 = microphone** (audio path HEADSET_MIC) and
**1 = headphones** (GAME_IN | VOICE_IN | STREAM_OUT | BT_IN). Each has 10 bands, 3
read-only onboard presets in slots 0..2 and one writable custom slot (slot 3).

| | |
|---|---|
| `fn0() → [n] n×12 bytes` | per instance: `[readonly<<4 \| custom][gainMin i8][gainMax i8][steps u16][pathMask u32][bands][2 unknown]`, e.g. `31 fa 06 00f1 00000001 0a 55 f0` |
| `fn1(instance, slot) → [00] 10×band` | bands in a slot (G Hub reads slot 3, the live one) |
| `fn2([instance][slot][00] 10×band)` | write bands into a slot and make it active |
| `fn3(instance) → [slot][00]` | active slot (3 in every observation) |
| `fn5(instance, preset) → 10×band` | a read-only onboard preset (no leading byte) |
| event fn0 | `[instance][slot][00] 10×band` |

A band is 5 bytes: `[frequency Hz u16 BE][q][gain step u16 BE]`. Gain steps run
0..240 over −6..+6 dB (0.05 dB per step, 120 = 0 dB). G Hub writes q `0x16` for every
band. Read-only mic presets report q `00` and G Hub writes them back with `16`.

Band frequencies (fixed by the device):

- mic: 80, 150, 250, 400, 800, 1500, 2500, 5000, 10000, 19000 Hz
- headphones: 20, 50, 125, 250, 500, 1000, 2500, 5000, 10000, 20000 Hz

**Curated presets are the onboard read-only presets.** G Hub applies one by reading it
and writing its bands into slot 3. Verified by applying each one in G Hub and comparing
the event to `fn5`:

| Instance | Slot 0 | Slot 1 | Slot 2 |
|---|---|---|---|
| mic | Default (flat) | Competition: −3 −3 −1.5 0 0 +1 +1.5 +1.5 +1.5 +2 | Broadcast: +4 +4 +2.5 +1.5 0 0 0 0 +0.5 +1 |
| headphones | Default (flat) | Gaming: −5 −4.5 −3.5 −2 0 +2 +3 +3 +3 +3 | Media: +4 +3 +2 −0.5 −0.5 +1 +2 +1.5 +0.5 −0.5 |

**Custom presets** live on the computer (G Hub keeps them in its settings database),
and applying one is the same `fn2` write.

### Read-only information

| Feature | Call | Reply |
|---|---|---|
| DeviceInfo `0100` | `fn0` | `[modelId][hwRev]…` (`24 07 …`) |
| | `fn1` | `[major][minor][build u16][len][branch]` (`01 02 0012 04 "main"` = 1.2.18) |
| | `fn2` | `[len][serial]` |
| DeviceName `0101` | `fn0` | `[maxLen 30][len][name]` (the name you gave the headset) |
| | `fn2` | `[len]["A50 X"]` |
| BatterySOC `0104` | `fn0`, event fn0 | `[percent][percent]` |
| BtHostInfo `0305` | `fn0` | `[count]` |
| | `fn1` | 6-byte address of the paired Bluetooth host |
| | `fn2` | `[maxLen][len][host name]` |
| Profile `0004` | `fn0`, events | `[?][checksum 4 bytes]`; changes with EQ and brightness writes |

## Not covered

- Writing the device name (G Hub reports `hasRename: false` for the A50 X).
- EU power mode (`BasePowerMode`, `power_mode_control`): G Hub lists the capability,
  but its agent registers no path for this device, so there's nothing to replicate.
- Charging state: battery events seen so far carry only the percentage twice.
- Features `0102`, `0303`, `0805`–`0807`: present on the device but never used by G Hub.
  `0805` `fn0` returns `03 00 00 30 03 01 04 15 03 02 00 15 03`.
- Firmware update (`010A`): intentionally not touched.
