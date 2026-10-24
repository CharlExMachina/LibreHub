# Logitech G502 X PLUS: protocol and settings map

Studied with G Hub 2026.6.981214 on macOS, mouse firmware MPM27 27.0.16 (bootloader BL142
42.0.16), Lightspeed receiver 046d:c547 firmware 4.2.9. Everything below was read from the
real mouse or from what G Hub itself wrote to it; raw evidence is in
[evidence/g502x/](evidence/g502x/). How it was worked out is in
[GHUB-INTERNALS.md](GHUB-INTERNALS.md#g502-x-plus).

- [How G Hub drives the mouse](#how-g-hub-drives-the-mouse)
- [Settings map](#settings-map): every G Hub control → where it lives on the mouse
- [Transport and framing](#transport-and-framing)
- [Feature table](#feature-table)
- [Live features](#live-features): DPI, report rate, lighting, wheel, battery
- [Onboard memory](#onboard-memory): directory, profile layout, bindings, lighting, macros
- [Macros, software actions and Freestyle](#macros-software-actions-and-freestyle): the G Hub
  features that look software-only, and how this project provides them
- [What is not possible](#what-is-not-possible)

## How G Hub drives the mouse

The mouse has two modes (feature 0x8100, `setMode`):

| Mode | Who applies settings | What persists |
|---|---|---|
| **host** (2) | G Hub, live, over HID++ | nothing; G Hub re-applies everything when it starts |
| **onboard** (1) | the mouse, from one of five profiles in its flash | everything in the profile |

G Hub's **software mode** ("On-board memory mode: OFF", the default) is host mode. At startup
the agent switches the mouse to host mode, starts *MouseButtonSpy* so every button press comes
to G Hub instead of the computer, takes software control of the LEDs, and pushes DPI, report
rate and lighting from its own profile database. Button assignments then happen in G Hub's
software: the mouse only reports which button went down.

G Hub's **on-board memory mode** is onboard mode. G Hub stops the button spy, releases the
LEDs and calls `setMode(1)`; from then on the mouse runs its active onboard profile with no
software involved. G Hub does not edit onboard profiles in place: "Enable with new" /
"Replace with" on a slot converts one of G Hub's software profiles into the onboard format
and writes the whole sector.

Host mode does not stick: after the mouse had gone to sleep and woken up, G Hub's agent found
it back in onboard mode (mode 1, profile 2) and switched it to host mode again. Stopping G Hub
does not change the mode by itself. **This project uses onboard mode**: settings are written to the
mouse's flash, so they work on Linux with nothing running in the background, exactly like a
profile G Hub put in an on-board slot. The live (host-mode) setters are implemented too, for
parity and for previews.

## Settings map

Every control G Hub shows for this mouse, where it lives, and how it was verified.
"Profile byte" offsets are into a 255-byte profile sector ([layout](#profile-sector-layout)).

### Sensitivity (DPI) and report rate

| G Hub control | Values | On the mouse | Verified |
|---|---|---|---|
| DPI speeds (up to 5) | 100–25600, step 50 | profile bytes 3–12: 5 × u16 LE, 0 = deleted level | G Hub wrote; G Hub decoded ours (`400/800/1600/0/0`) |
| Current DPI speed (underlined) | one of the levels | profile byte 1 (default index); live: `0x8100` fn12 `setCurrentDpiIndex` | hardware test: sensor follows |
| DPI shift speed | one of the levels | profile byte 2 (shift index) | G Hub decoded ours |
| Report rate | 1000/500/250/125 Hz | profile byte 0 = interval in ms (1/2/4/8); live: `0x8060` fn2, host mode only (onboard mode answers INVALID_ARGUMENT) | G Hub wrote and decoded; hardware test |
| Restore default settings | | copy factory profile (sector 0x0101/0x0102) | hardware test |
| Curated sensitivity presets | Default, First Person, Third Person, MMORPG, MOBA, RTS, Simulation, Productivity | DPI table as above | from G Hub's device depot (`defaults_override.json`, model `g502x_plus`) |

In software mode G Hub sets DPI live with `0x2201` fn3 `[sensor 0][dpi u16 BE][level]`, for
example `00 09 60 04` = 2400 DPI, level 4 (the 1-based level drives the DPI indicator LED).

### Assignments (13 controls × default and G-Shift layer)

| Onboard index | G Hub slot | G Hub label | Physical control | Factory binding |
|---|---|---|---|---|
| 0 | g1 | Primary Click | left button | `80 01 00 01` left |
| 1 | g2 | Secondary Click | right button | `80 01 00 02` right |
| 2 | g3 | Middle Click | wheel click | `80 01 00 04` middle |
| 3 | g4 | Mouse Button 4 | rear thumb button | `80 01 00 08` back |
| 4 | g5 | DPI Shift | front thumb (sniper) button | `90 07 00 00` DPI shift |
| 5 | g6 | Mouse Button 5 | middle thumb button | `80 01 00 10` forward |
| 6 | g7 | Scroll Left | wheel tilt left | `90 01 00 00` |
| 7 | g8 | Scroll Right | wheel tilt right | `90 02 00 00` |
| 8 | g9 | Onboard Profile Cycle | button behind the wheel | `90 0a 00 00` |
| 9 | g10 | DPI Up | upper button left of the left click (printed G8) | `90 03 00 00` |
| 10 | g11 | DPI Down | lower button left of the left click (printed G7) | `90 04 00 00` |
| 11 | scroll2 | Scroll Down | wheel down | `90 10 00 00` (G Hub) / `FF FF FF FF` (factory) |
| 12 | scroll1 | Scroll Up | wheel up | `90 11 00 00` (G Hub) / `FF FF FF FF` (factory) |

The description reports 11 buttons; G Hub writes the two wheel directions as entries 11 and 12
(capability `scrollControls {scrollUp: 13, scrollDown: 12}`). The G-Shift layer is the same 13
entries at profile byte 96.

| G Hub assignment | Bytes | Verified |
|---|---|---|
| Mouse buttons (Primary/Secondary/Middle/Button 4/Button 5) | `80 01 MASK.hi MASK.lo` (bit 0 = left … bit 4 = forward) | G Hub wrote and decoded |
| Keys and key combinations (KEYS tab, COMMANDS that are one keystroke) | `80 02 MODIFIERS USAGE` (HID keyboard usage; modifiers 1 Ctrl, 2 Shift, 4 Alt, 8 GUI, ×16 for right-hand) | factory Ctrl+T etc.; G Hub decoded ours as `KEYSTROKE` |
| Media / consumer keys | `80 03 USAGE.hi USAGE.lo` (e9 vol up, ea vol down, e2 mute, cd play/pause, b5/b6 next/prev, b7 stop) | factory; G Hub decoded ours as `MEDIA` |
| DPI Up / Down / Cycle / Default / Shift | `90 03` / `90 04` / `90 05` / `90 06` / `90 07` | G Hub decoded ours (`DPI_UP`, `DPI_CYCLE`, `DPI_DEFAULT`, …) |
| Scroll Left / Right (tilt) | `90 01` / `90 02` | G Hub |
| Scroll Up / Down | `90 11` / `90 10` | G Hub |
| Onboard Profile Cycle / next / previous | `90 0a` / `90 08` / `90 09` | G Hub decoded ours (`PROFILE_CYCLE`, `PROFILE_NEXT`, `PROFILE_PREV`) |
| G-Shift | `90 0b` | factory profile 2; G Hub decoded ours |
| Battery Level | `90 0c` | G Hub decoded ours as `BATTERY_LIFE` |
| Disable | `90 00 00 00` | G Hub wrote it (G9 → DISABLE) |
| Use default | the factory binding above | |
| Macros, Double Click, Go to DPI Shift | G Hub: `00 00 00 00` (macro) / `00 01 00 00` (the other two), placeholders that do nothing on the mouse. This project stores text, Double Click and macros as real onboard macros instead, `0S SS 00 OO` (see [Macros](#macros)) | G Hub wrote the placeholders; the mouse ran our macros (hands-on) |
| Cycle Maximum Brightness | `90 00 00 00`: G Hub cannot store it, so the button does nothing on the mouse | G Hub wrote it |

In software mode G Hub performs every assignment itself through MouseButtonSpy (`0x8110`); in
onboard mode only the rows above with real bytes work. Launch Application and other actions on
the computer are covered by the agent here; see
[Macros, software actions and Freestyle](#macros-software-actions-and-freestyle).

### LIGHTSYNC

| G Hub control | Values (G Hub's ranges) | On the mouse | Verified |
|---|---|---|---|
| Effect: Off | | both active LED slots `00…` | |
| Effect: Fixed | colour | primary slot: `01 R G B 02 00…` | G Hub wrote; G Hub decoded ours |
| Effect: Cycle | rate 1000–20000 ms, brightness 1–100 % | primary slot: `03 00 00 00 00 00 P.hi P.lo BRIGHT 00 00` | G Hub wrote (11000 ms, 50 %) |
| Effect: Breathing | colour, rate, brightness | primary slot: `0a R G B P.hi P.lo WAVEFORM BRIGHT 00 00 00` | G Hub wrote; G Hub decoded ours (`BREATHING 3000 ms 0.5`) |
| Effect: Color Wave | rate, direction (horizontal / reverse), brightness | all slot: `04 00 00 00 00 00 00 P.lo DIR BRIGHT P.hi` (period split!) | G Hub wrote 5000/18500 ms; G Hub decoded ours (`COLORWAVE 7000 ms REVERSE_HORIZONTAL 0.7`) |
| Effect: Pulsar Point | effect rate 32–64 ms | all slot: `0f 00 00 00 00 00 F.hi F.lo BRIGHT 00 00` (`SIGNATURE_FRAME_ACTIVE`) | G Hub wrote |
| Effect: Screen Sampler | | software only | |
| Freestyle (per-LED colours) | 8 LEDs | not storable: `0x8081` per-LED frames while software controls the LEDs, in either mode | seen on the mouse (hands-on); see [Freestyle](#freestyle) |
| Animations / Effects on device | 6 stored animation slots | stored through `0x8071`; not editable here | |
| Inactivity: Neutron Null | | inactive all slot: `10 … F.hi F.lo BRIGHT` (`SIGNATURE_FRAME_INACTIVE`) | G Hub wrote |
| Inactivity: Breathing | colour | inactive primary slot, breathing as above | G Hub wrote |
| Inactivity: Dim Active Effect | brightness % | the active effect again with lower brightness | G Hub wrote (wave at 50 %) |
| Inactivity: Start after | never, 1, 2, 5, 10, 15 min | profile bytes 28–29: seconds u16 LE, `FFFF` = never | G Hub wrote 60/120/300 |
| Inactivity: All lights off after | never, 1, 2, 5, 10, 15 min | profile bytes 30–31, same encoding | G Hub wrote 300/900/never |
| Device startup effect | on/off | `0x8071` fn3 NV config, capability `0x0001`: data byte 1 = on, 2 = off | toggled in G Hub, read back; hardware test |

The four LED slots sit at profile byte 208: active-all, active-primary, inactive-all,
inactive-primary (11 bytes each). G Hub puts Fixed/Cycle/Breathing in the primary slot and
everything else in the all slot, and turns the other slot off. Byte 252 is a flag G Hub derives
from that: bit 0 = the active effect uses the all slot, bit 1 = the inactive effect does
(observed values 0, 1, 3 across all G Hub writes).

In software mode G Hub sends the same effect parameters live with `0x8071` fn1
`setEffect [cluster][effect index][10 params][persist]`, after taking software control with fn5
`[01 03 07]` / `[01 03 05]`; it runs the inactivity timers itself through fn7 (power config:
idle and sleep seconds) and the `0x8071` activity events.

### Settings page

| G Hub control | On the mouse |
|---|---|
| Battery level, approximate hours, power consumption | `0x1004` fn1 `[percent][level][charging][external]`; G Hub computes hours and mW itself |
| Firmware versions | `0x0003` fn1 per entity: `[type][prefix×3][major BCD][minor BCD][build BCD×2]` → MPM27 27.0.16 |
| On-board memory mode | `0x8100` fn1 `setMode` (1 onboard, 2 host) |
| Slot 1–5 enable / disable | directory sector 0, enabled byte per entry |
| Active slot (radio) | `0x8100` fn3 `setCurrentProfile [00 n]`, fn4 reads it (0 in host mode) |
| Slot name | profile bytes 160–207, UTF-16LE, 24 characters, zero padded; unnamed = all `FF` |
| Restore default profile / Restore all slots | copy factory sector 0x0101 (slot 1, 3–5) or 0x0102 (slot 2) |

## Transport and framing

The mouse pairs to a Lightspeed receiver (USB 046d:c547). HID++ goes through the receiver's
vendor interface, usage page 0xFF00 (usage 1 = short reports, 2 = long). The mouse is device
index 1 behind the receiver (the receiver's pairing register `0xB5 0x20` reports wireless PID
0x4099 for slot 1). With its cable the mouse is 046d:c095 and answers as device 0xFF.

```
short request   10 DEV SUB ADDR p0 p1 p2
long request    11 DEV FIDX FN<<4|SWID p0..p15
reply           11 DEV FIDX FN<<4|SWID r0..r15         (same header)
event           11 DEV FIDX FN<<4|0    ...              (software id 0)
feature error   11 DEV FF FIDX FN<<4|SWID CODE          (02 invalid argument, 04 hardware error, 07 invalid function)
receiver error  10 DEV 8F FIDX FN<<4|SWID CODE 00       (08 = unknown device: the mouse is asleep or off)
connection      10 DEV 41 PROTO FLAGS WPID.lo WPID.hi   (FLAGS bit 6 = link not established)
```

G Hub uses software id 0xD; this project uses 0xB, so replies are never confused when both
are running. That only makes reading safe alongside G Hub: two programs writing the onboard
memory at the same time would interleave their write sessions, and G Hub in software mode
re-applies its own DPI, report rate and lighting. Quit G Hub before changing settings. The mouse sleeps after a few idle minutes; until it is moved again the receiver
answers every request with `8F … 08`. The client retries for a configurable time.

## Feature table

`0x0001` fn1 for each index (flags 0x70 = hidden engineering feature):

| Index | ID | Name | Used for |
|---|---|---|---|
| 0 | 0000 | Root | getFeature, ping (protocol 4.2) |
| 1 | 0001 | FeatureSet v2 | |
| 2 | 0003 | FirmwareInfo v4 | firmware, serial (unit id 499602d2 = 1234567890) |
| 3 | 0005 | DeviceName | "G502 X PLUS" |
| 4 | 1D4B | WirelessDeviceStatus | reconnect events |
| 5 | 0020 | ConfigChange | |
| 6 | 1004 | UnifiedBattery v3 | battery |
| 7 | 2201 | AdjustableDpi v2 | live DPI |
| 8 | 2121 | HiResWheel | wheel mode, ratchet switch |
| 9 | 8071 | RgbEffects v2 | live lighting, startup effect, inactivity timers |
| 10 | 8081 | PerKeyLighting v2 | Freestyle |
| 11 | 8100 | OnboardProfiles | modes, profiles, memory |
| 12 | 8110 | MouseButtonSpy | G Hub's software assignments |
| 13 | 8060 | ReportRate | live report rate |
| 14 | 1500 | (unknown) | fn0 returns 0; G Hub does not call it |
| 15 | 00D0 | Dfu v3 | firmware updates (not used) |
| 16–31 | 1802 1803 1806 1811 1805 1830 1875 1861 1890 18A1 1801 1E00 1E22 1EB0 18B1 18C0 | engineering / test features | never touched |

## Live features

| Feature | Function | Request | Reply |
|---|---|---|---|
| 2201 AdjustableDpi | fn0 sensor count | | `[1]` |
| | fn1 DPI list | `[sensor]` | `[sensor] 00 64 e0 32 64 00 00` = 100, step 50, 25600 |
| | fn2 get DPI | `[sensor]` | `[sensor][dpi u16][default u16]` |
| | fn3 set DPI | `[sensor][dpi u16][level 1-based]` | echo |
| 8060 ReportRate | fn0 list | | `[0x8b]` = bits 0,1,3,7 = 1, 2, 4, 8 ms |
| | fn1 get / fn2 set | `[ms]` | `[ms]` / empty |
| 2121 HiResWheel | fn0 capability | | `[8][0x0c]` = ×8, has invert, has ratchet switch |
| | fn1 get mode / fn2 set mode | `[bit0 HID++ divert, bit1 hi-res, bit2 invert]` | G Hub keeps 0 |
| | fn3 ratchet state | | `[1]` ratchet, `[0]` free spin (mechanical switch) |
| 1004 UnifiedBattery | fn1 status (also pushed as event fn0) | | `[percent][level 1/2/4/8][charging 0..6][external power]` |
| 8071 RgbEffects | fn0 info | `[ff ff 00]` device, `[cluster ff 00]` cluster, `[cluster effect 00]` effect | cluster 0: effects 0000 off, 0001 fixed, 000a breathing, 0003 cycle; cluster ff: 0004 wave, 000c, 000f, 0010, 0013 |
| | fn1 set effect | `[cluster][effect index][10 params][1]` | |
| | fn3 NV config | `[0 get / 1 set][cap u16][data]` | cap 0x0001 = startup effect |
| | fn5 software control | `[1][mode 3][flags]` / `[1][0][0]` to release | |
| | fn7 power config | `[0]` get → `[00 00 00][idle s u16][sleep s u16]`; `[1 00 00 idle sleep]` set | |
| 8110 MouseButtonSpy | fn0 count | | `[0b]` |
| | fn1 start / fn2 stop | | |
| | fn3 get / fn4 set remapping | | `01 02 03 04 00 05 00…`, which reads as control k → HID mouse button n (0 = none). G Hub sets all zeros in software mode. Not exercised here |
| | event 0 (while started) | | `[mask u16 BE]` of the controls held down, bit k = onboard control k (left `0001` … DPI down `0400`), on every press and release, in onboard and host mode |
| 8100 OnboardProfiles | event 0 | | `[00][profile]` after the profile button switched profile (not after a host-requested switch) |

## Onboard memory

### Functions (feature 0x8100)

| fn | Name | Request | Reply |
|---|---|---|---|
| 0 | getDescription | | `01 05 01 05 02 0b 10 00 ff 0a 04`: memory model 1, profile format 5, macro format 1, 5 profiles, 2 factory profiles, 11 buttons, 16 sectors of 0x00FF bytes, layout 0x0a (G-Shift), info 4 |
| 1 / 2 | set / get mode | `[1 onboard / 2 host]` | |
| 3 / 4 | set / get current profile | `[00][n]` (1-based) | `[00][n]`, 0 in host mode. Selecting another profile starts at its default DPI level; selecting the active one again keeps the current level |
| 5 | read | `[sector u16][offset u16]` | 16 bytes (offset + 16 must stay inside the sector, so read the last chunk at size − 16) |
| 6 | write start | `[sector u16][offset u16][length u16]` | erases the sector |
| 7 | write | 16 bytes | `[00][chunk count]` |
| 8 | write end | | **fails with 04 (hardware error) if the sector's CRC is wrong**; an all-FF write is how a sector is erased |

A write session (fn6, sixteen fn7, fn8) must not be interrupted: if the mouse falls asleep
part-way, the client waits for it and starts the session again from fn6 (repeating a single
chunk would shift the data). A profile sector that fails its checksum is reported, not
replaced; an erased one reads as the factory profile, and an erased directory makes the mouse
use the factory directory, so the client recreates sector 0 before the next edit.
| 11 / 12 | get / set current DPI index | `[index 0..4]` | |

User sectors are 0x0000–0x000F; reads beyond fail with 02. Factory (read-only) sectors:
0x0100 is the factory directory (profiles 0x0101 and 0x0102, followed by an `RGB_V0000`
record), 0x0101 and 0x0102 are the factory profiles. Factory sectors leave the CRC bytes `FF`.

Every user sector ends in a CRC-16/CCITT (polynomial 0x1021, initial 0xFFFF) over the first 253
bytes, stored big-endian in bytes 253–254.

### Directory (sector 0)

```
00 01 01 ff  00 02 01 ff  00 03 00 ff  00 04 00 ff  00 05 00 ff  ff ff …  CRC
sector u16   enabled      (reserved FF)
```

### Profile sector layout

| Bytes | Field |
|---|---|
| 0 | report interval, ms (1, 2, 4, 8) |
| 1 | default DPI index |
| 2 | DPI-shift index |
| 3–12 | 5 DPI levels, u16 little-endian, 0 = deleted |
| 13–15 | profile colour (unused, FF FF FF) |
| 16 | power mode (FF) |
| 17 | angle snapping (0) |
| 18–27 | reserved (FF) |
| 28–29 | inactive lighting after N seconds, u16 LE, FFFF = never |
| 30–31 | all LEDs off after N seconds, u16 LE, FFFF = never |
| 32–95 | 16 bindings × 4 bytes (13 used) |
| 96–159 | 16 G-Shift bindings × 4 bytes |
| 160–207 | name, UTF-16LE, 24 code units |
| 208–218 | active lighting, all-LEDs slot |
| 219–229 | active lighting, primary-zone slot |
| 230–240 | inactive lighting, all-LEDs slot |
| 241–251 | inactive lighting, primary-zone slot |
| 252 | lighting slot flags (bit 0 active uses all, bit 1 inactive uses all) |
| 253–254 | CRC |

After writing the active profile, re-select it (fn3) and the mouse applies the new settings
immediately (hardware test: the sensor DPI changes). It stays on its current DPI level; if that
level was removed, it moves to the last one left (checked on Linux, 2026-10-24).

### Macros

The description advertises macro format 1 (libratbag's "G402" opcodes: `43 MOD KEY` key down,
`44 MOD KEY` key up, `40 MS` delay, `41/42 MASK` buttons down/up, `45/46 USAGE` consumer
down/up, `20`/`21` wheel/tilt, `61` move, `FF` end; a binding `0S SS 00 OO` points at sector S,
offset O). G Hub 2026.6 does not use it for this mouse: when a G Hub macro is assigned and the
profile written to a slot, G Hub stores the placeholder `00 00 00 00` and writes no macro data.

**The firmware runs these macros by itself.** A G9 binding pointing at `43 00 0b 44 00 0b 40 00
1e 43 00 0c 44 00 0c ff` in sector 6 typed "hi" into a text field
([lab.txt](evidence/g502x/lab/lab.txt), test 3). Through the CLI, a double-click macro selected
a word and `text:Hello, World!` typed over it exactly, capitals and punctuation included
([handson-2.txt](evidence/g502x/lab/handson-2.txt)). Shift is the modifier byte of the same key
step (`43 02 0b` = H).

Sectors 6–15 are erased on the factory mouse and nothing else uses them. This project gives
each profile two of them (profile n: sectors 4+2n and 5+2n), packs that profile's macros into
them first-fit, and rewrites them before the profile that points into them, so editing one
profile never touches another's macros. A macro has to fit in one sector (253 bytes, about 40
characters of text, at 6 bytes per character).

## Macros, software actions and Freestyle

G Hub lists some features that it can't store on this mouse, because in its default software
mode it does them itself: it runs MouseButtonSpy, sees every press, and plays macros, types
text, launches applications and paints per-LED colours from the computer. In on-board memory
mode those assignments become placeholders that do nothing.

This project splits them by what the hardware can do:

| G Hub feature | Here | Needs software running? |
|---|---|---|
| Macros (keys, combos, pauses, mouse buttons, media keys, wheel) | an onboard macro: `macro:ctrl+c, 50ms, ctrl+v` | no: the mouse plays it |
| Text (Text & Emojis) | an onboard macro of key taps: `text:Hello, World!` (printable ASCII, US layout) | no |
| Double Click | an onboard macro: `double-click` | no |
| Launch Application, open a file or website, Lock screen and other system actions | `open:<app, file or URL>` / `run:<command>`; the mouse stores "disabled" and the agent acts on the press | yes |
| Freestyle | per-LED colours per profile; the agent paints them | yes |

Emojis and other non-ASCII text are not possible from the mouse: it can only send key presses.

### The agent

`librehub mouse agent` (or the app, while it runs, also from the tray) does the part that needs the computer:

1. Starts MouseButtonSpy. In onboard mode the profile keeps working normally (G9 still
   switched profile while spied, [lab.txt](evidence/g502x/lab/lab.txt) test 1), and every press
   is also reported as event 0. Without the remapping G Hub uses, nothing is taken away from
   the mouse.
2. On a press, looks up the active profile's action for that control and layer (G-Shift layer
   while a control bound to `fn:g-shift` is held) and runs it, but only if the mouse binding
   is still "disabled", so a profile changed by other software never fires a stale action.
3. Paints Freestyle for the active profile and paints again when the profile changes (event 0
   of 0x8100), when the mouse wakes up (receiver notification 0x41), and when the settings
   file changes.
4. On exit, stops the spy and hands the LEDs back.

Software actions and Freestyle are kept in `g502x.json` next to the app's other settings
(`~/.config/logitech-manager/` on Linux, `~/Library/Application Support/logitech-manager/` on
macOS). A lock file next to it keeps the app and `librehub mouse agent` from both acting.

### Freestyle

- Per-LED frames (`0x8081` fn1 `[led][r][g][b]`×4, fn7 frame end), sent after taking software
  control (`0x8071` fn5 `[1][3][5]`, as G Hub does), show in host and onboard mode alike
  ([lab2.txt](evidence/g502x/lab/lab2.txt), [lab3.txt](evidence/g502x/lab/lab3.txt)). Frames
  without software control were not tried.
- The LEDs are numbered 1–8 (fn0 info `[00 00]` → `00 00 ff 01`: LED 0 does nothing). G Hub's
  `light_map.json` maps its eight Freestyle dots to these numbers; left to right on its
  picture: 3, 4, 8, 7, 6, 5, then 2 (right side, upper) and 1 (right side, lower). The strip is
  Y-shaped, which made a by-eye map unreliable ([lab4.txt](evidence/g502x/lab/lab4.txt)).
- The mouse repaints its own effect shortly after a profile is selected or the mode changes,
  over any frame sent just before; a frame sent a few seconds later stays. Selecting effect
  `0x13` on cluster `ff` keeps frames visible; selecting a cluster-0 effect or `0x0c` hides
  them ([lab5.txt](evidence/g502x/lab/lab5.txt)).
- G Hub running at the same time takes the LEDs back. The first hands-on run failed only on
  Freestyle, with G Hub's agent restarted in the background
  ([handson-1-ghub-running.txt](evidence/g502x/lab/handson-1-ghub-running.txt)); with it
  closed, it passed.

## What is not possible

- **Emojis and non-ASCII text**: the mouse can only send key presses. Text is typed with a US
  layout, so other keyboard layouts may get different characters for symbols.
- **G HUB/Audio actions and Cycle Maximum Brightness** control G Hub itself; there is nothing
  to control here. Use `run:` for an equivalent command.
- **Screen Sampler and LIGHTSYNC sync** (lighting that follows the screen or other devices)
  are not implemented.
- **Freestyle without software running**: the mouse can't store per-LED colours in a profile.
  Without the agent, the profile's own lighting shows.
- **Editing the stored animations** ("Effects on device", 6 slots) is not implemented; they can
  still be read through `0x8071` fn0 info type 1.
- **Asymmetric X/Y DPI** presets exist in G Hub's data but this sensor feature stores one DPI.
- **Firmware updates** (`0x00D0`) and the engineering features are deliberately left alone.
