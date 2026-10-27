# Logitech MX Brio: protocol and settings map

Studied with G Hub 2026.6.981214 on macOS, camera firmware 1.1.394 (USB 046d:0944, model
`brio_700` to G Hub), connected at USB 2.0 high speed. Everything below was read from the real
camera, or is what G Hub itself wrote to it; raw evidence is in
[evidence/mx-brio/](evidence/mx-brio/). How it was worked out is in
[GHUB-INTERNALS.md](GHUB-INTERNALS.md#mx-brio).

- [How G Hub drives the camera](#how-g-hub-drives-the-camera)
- [Settings map](#settings-map): every G Hub control → the UVC control it writes
- [Transport](#transport): UVC control requests, and how they reach the camera on macOS and Linux
- [Units](#units): the camera terminal, the processing unit and Logitech's extension units
- [Behaviour](#behaviour): what the camera refuses, what it forgets, the microphone switch
- [The HID interface](#the-hid-interface)
- [Not covered](#not-covered)

## How G Hub drives the camera

The MX Brio is a plain USB Video Class camera with Logitech extension units. Unlike the A50 X and
the G502, nothing G Hub sets goes over HID++: every camera setting is a UVC control request
(`SET_CUR`) to a unit in the Video Control interface. G Hub's agent has its own UVC library
(`provider/devices/uvc/src/uvc_lib`), which finds each unit by GUID and on macOS sends the requests
through IOKit's USB interface (`usb_interface_request.cpp`).

The camera keeps most values through a restart, but not all (see [Behaviour](#behaviour)), and has
no profile memory (G Hub's capability block: `hasPersistentMemory: false`). G Hub keeps its
settings per profile on the computer and writes them whenever the camera appears. Libre Hub does
the same: it saves what you change in `mx-brio.json` (next to `g502x.json`) and, whenever the
camera connects, writes back whatever differs.

## Settings map

G Hub groups the settings in four cards (Crop, Exposure, Image, Focus) plus anti-flicker and the
microphone switch. Units are named as below; on this camera the camera terminal is unit 1, the
processing unit 3, the video pipe XU 10 and the peripheral XU 11 (resolve them by GUID). Values are
little-endian. "Verified" says how: **G Hub** = the bytes G Hub wrote when told to change this
setting (diffing every control before and after, `evidence/mx-brio/uvc/ghub-set-diffs.txt`);
**HW** = written by Libre Hub and read back by `npm run test:hardware:camera`.

### Crop

| G Hub setting | Values | Control | Encoding | Verified |
|---|---|---|---|---|
| Field of view | 65°, 78°, 90° | video pipe XU, selector 5 (1 byte) | 90° = 0, 78° = 1, 65° = 2 | G Hub, HW |
| Zoom | 100–400 % | camera terminal `CT_ZOOM_ABSOLUTE` (0x0B, 2 bytes) | the percentage | G Hub, HW |
| Pan, tilt | ±72000 arc seconds (±20°), steps of 3600 | `CT_PANTILT_ABSOLUTE` (0x0D, 8 bytes) | pan (signed 32) then tilt | G Hub, HW |
| Show Mode | on/off | video pipe XU, selector 13 (1 byte) | 1 = on | G Hub, HW, and by eye: the camera itself turns the picture when tilted down |
| RightSight | on/off | none | software: G Hub hands it to LogiRightSight, which frames you on the computer | G Hub (no control changed) |

The camera mirrors zoom into video pipe selector 6 and pan/tilt into peripheral selector 12 by
itself; neither G Hub nor Libre Hub writes those.

### Exposure

| G Hub setting | Values | Control | Encoding | Verified |
|---|---|---|---|---|
| Auto exposure | on/off | `CT_AE_MODE` (0x02, 1 byte) | on = 8 (aperture priority; GET_RES = 0x09: the camera has manual and aperture priority only), off = 1 | G Hub, HW |
| Shutter speed | G Hub's 1/2000 … 1/17 | `CT_EXPOSURE_TIME_ABSOLUTE` (0x04, 4 bytes, 100 µs units) | G Hub's "mac" table: 2000→5, 800→10, 400→20, 200→39, 120→78, 60→156, 30→312, 24→625, 20→1250, 17→2047 | G Hub, HW |
| ISO | 100–1600 in 100s | `PU_GAIN` (0x04, 2 bytes) | (ISO / 100 − 1) × 16, so 0–240 | G Hub, HW |
| Exposure compensation | 0–255, 128 = none | video pipe XU, selector 19 (1 byte) | the value | G Hub, HW |
| HDR | on/off | `PU_BACKLIGHT_COMPENSATION` (0x01, 2 bytes) | 1 = on | G Hub, HW |
| Priority | exposure / frame rate | `CT_AE_PRIORITY` (0x03, 1 byte) | exposure = 1 (frame rate may drop), frame rate = 0 | G Hub, HW |

G Hub's labels for the slow shutter speeds don't match what it writes (its "1/17" is 204.7 ms,
about 1/5 s). Libre Hub keeps G Hub's labels, so the two show the same thing.

### Image

| G Hub setting | Values | Control | Verified |
|---|---|---|---|
| Brightness | 0–255 | `PU_BRIGHTNESS` (0x02, 2 bytes) | G Hub, HW |
| Contrast | 0–255 | `PU_CONTRAST` (0x03) | G Hub, HW |
| Saturation | 0–255 | `PU_SATURATION` (0x07) | G Hub, HW |
| Sharpness | 0–255 | `PU_SHARPNESS` (0x08) | G Hub, HW |
| Tint | 0–100, 50 = none | video pipe XU, selector 18 (1 byte) | G Hub, HW |
| Vibrance | 0–255 | video pipe XU, selector 20 (1 byte) | G Hub, HW |
| White balance | auto, or 2800–7500 K | `PU_WHITE_BALANCE_TEMPERATURE_AUTO` (0x0B) and `PU_WHITE_BALANCE_TEMPERATURE` (0x0A, 2 bytes, kelvin) | G Hub, HW |
| Temperature (warmer/cooler) | 0–100, 50 = none | video pipe XU, selector 21 (1 byte) | G Hub, HW |

### Focus, anti-flicker, microphone

| G Hub setting | Values | Control | Verified |
|---|---|---|---|
| Focus | auto, or 0–255 | `CT_FOCUS_AUTO` (0x08) and `CT_FOCUS_ABSOLUTE` (0x06, 2 bytes) | G Hub, HW |
| Anti-flicker | 50 / 60 Hz | `PU_POWER_LINE_FREQUENCY` (0x05, 1 byte): 50 Hz = 1, 60 Hz = 2 | G Hub, HW |
| Microphone on/off | on/off | peripheral XU, selector 16 (1 byte): 1 = on; the camera restarts (below) | G Hub, HW, and the audio device appearing in macOS |

### Presets

G Hub's preset menus come from its depot for this model (`device_presets.json`): Crop: Default,
FOV 78, FOV 65, Zoom 1.5×, Zoom 2×; Exposure: Default, Streaming (frame-rate priority); Image:
Default, Black and White (saturation 0), Warmer (temperature 60), Cooler (temperature 40); Focus:
Default. "Default" and G Hub's Reset are its `default_configurations.json`: everything as in the
tables' defaults, with Show Mode on, HDR on, exposure priority, 60 Hz. Libre Hub has the same
presets, and saves yours in `mx-brio.json`.

## Transport

Standard UVC 1.5 class requests to the Video Control interface (interface 0):
`bmRequestType` 0x21 (SET) / 0xA1 (GET), `wValue` = selector << 8, `wIndex` = unit << 8 |
interface. GET_LEN (0x85) gives an extension-unit control's length and GET_INFO (0x86) whether
it can be set; GET_MIN/MAX/RES/DEF work on the controls above. A refused request is a STALL.

- **macOS:** control requests go through the device's default pipe, so they work while the system
  camera driver, G Hub, LogiRightSight (which holds the device as `UsbExclusiveOwner`) or a video
  call has the camera. Libre Hub uses libusb (the `usb` package); `libusb_open` can't take the
  device, and doesn't need to.
- **Linux:** uvcvideo owns the Video Control interface, and usbfs refuses class requests to an
  interface the caller hasn't claimed, so libusb is out. The camera terminal and processing unit
  controls are V4L2 controls on `/dev/videoN` (`VIDIOC_G_CTRL`/`S_CTRL`/`QUERYCTRL`: brightness,
  contrast, saturation, gain, power_line_frequency, white_balance_temperature(_automatic),
  sharpness, backlight_compensation, exposure_auto (menu 0 auto, 1 manual, 2 shutter, 3 aperture
  priority), exposure_auto_priority, exposure_time_absolute, focus_absolute,
  focus_automatic_continuous, zoom_absolute, pan_absolute, tilt_absolute). Logitech's extension
  units are reached with uvcvideo's `UVCIOC_CTRL_QUERY` (`_IOWR('u', 0x21, struct
  uvc_xu_control_query)`), which takes the unit, selector, request and a data pointer. Node has no
  `ioctl()`; Libre Hub calls libc's through koffi. The unit ids come from the USB device's sysfs
  `descriptors`. The capture node is the one whose `index` is 0 (index 1 is the metadata node).
  Video devices are already open to the logged-in user (systemd tags video4linux for `uaccess`),
  so no udev rule is needed. **The Linux path is tested against a stand-in kernel only**; it
  has not run on a Linux machine with the camera yet.

## Units

From the configuration descriptor (`evidence/mx-brio/uvc/config-descriptor-hex.txt`):

| Id | Unit | GUID | Name in G Hub's agent |
|---|---|---|---|
| 1 | Camera terminal (input terminal 0x0201) | | |
| 3 | Processing unit | | |
| 2 | Extension unit, 6 controls | `2c49d16a-32b8-4485-3ea8-643a152362f2` | (not named) |
| 6 | Extension unit, 5 controls | `23e49ed0-1178-4f31-ae52-d2fb8a8d3b48` | firmware update ("Videopipe Control" list in the DFU code) |
| 8 | Extension unit, 13 controls | `69678ee4-410f-40db-a850-7420d7d8240e` | Device Info Unit: selector 1 firmware (`01 01 8a 01` = 1.1.394), 7 serial number (ASCII), 6 VID/PID/bcdDevice |
| 9 | Extension unit, 22 controls | `1f5d4ca9-de11-4487-840d-50933c8ec8d1` | firmware update; selector 22 climbs while the camera streams (a temperature, it seems) |
| 10 | Extension unit, 14 controls | `49e40215-f434-47fe-b158-0e885023e51b` | Video Pipe Unit |
| 11 | Extension unit, 7 controls | `ffe52d21-8030-4e2c-82d9-f587d00540bd` | Peripheral Unit |
| 21 | Extension unit, 2 controls | `5a6d654c-7e35-4d4e-810d-069d15e0f79b` | Device Statistics Unit |
| 22 | Extension unit, 1 control | `29144c1f-658d-4f47-a40f-0ed339428bf0` | App Settings Unit |

The full dump of every readable control is `evidence/mx-brio/uvc/dump-before-any-write.txt`.

## Behaviour

- **Manual values are refused in auto.** While auto exposure, auto focus or auto white balance is
  on, `SET_CUR` on the exposure time, focus or white-balance temperature STALLs. Gain is accepted
  either way, and G Hub writes it either way. So the mode goes first, then the value
  (`evidence/mx-brio/uvc/writes-while-auto.txt`). In auto, those controls read back whatever they
  last held, so a read can show a manual value that isn't in effect.
- **What a restart forgets.** After a restart (the microphone switch is one), zoom, pan, tilt,
  field of view and the auto-exposure mode are back at their defaults. AE priority came back
  different in two restarts of five, once each way. Brightness, Show Mode, tint, anti-flicker,
  HDR and the manual values were kept (`evidence/mx-brio/uvc/persistence-reboot.txt`,
  `restart-probes.txt`). A power cycle (unplugging) was
  not tested separately.
- **The microphone switch restarts the camera.** The camera says yes to the write. About 2.5 s
  later it leaves USB, and about a second after that it is back, with or without its USB Audio
  interfaces. The switch itself survives restarts. On macOS the camera can drop out of libusb's
  device list a moment before it really goes, so wait for it to be gone, and then some, before
  reopening it.

## The HID interface

Interface 2 is HID, with vendor collections on usage pages 0xFF00–0xFF02, 0xFFA1 and 0xFF99, and a
telephony collection (hook switch, mute, mute LED). There is no HID++ (no 0x10/0x11 reports).
G Hub lists two of them (`HID_046d_0944_ff000001`, `…_ff010001`) and has paths for Show Mode HID
reports and button actions. With G Hub running, tilting the camera produced report 0x55
`00 00 a4 00 0X 00` (X = 1 down, 0 up) and a 0x0A status report (`evidence/mx-brio/lab/hid-tilt-*.txt`).
With G Hub quit, neither tilting nor the privacy shutter produced any report
(`lab/hid-tilt-shutter-ghub-quit.txt`), so G Hub or its helper presumably switches them on, with an
output report that macOS doesn't let us see. The camera turns the picture by itself, so Libre Hub
doesn't need them.

## Not covered

- **RightSight** (auto framing): done on the computer by LogiRightSight, not by the camera.
- **Separate framing in Show Mode:** G Hub has a `showmode/settings` path with its own pan, tilt,
  zoom and FOV. It would need the tilt reports above.
- **Microphone volume and mute:** G Hub sets these as the system's input level (`defaultVolume`
  0.95). Use your system's sound settings.
- **G Hub's factory reset** (`/uvc/…/factory_reset`): not mapped. Libre Hub's Reset writes G Hub's
  defaults instead.
- **Firmware updates** (`brio_700_v1_1_394.bin` through extension units 6 and 9) and the device
  statistics unit.
- **4K and 1080p60 preview** need USB 3: at USB 2 speed the camera offers up to 1080p30 for MJPEG.
