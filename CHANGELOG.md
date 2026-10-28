# Changelog

Libre Hub follows [Semantic Versioning](https://semver.org): a **major** version for changes
that break something you rely on (a moved settings file, a dropped feature), a **minor** version
for new features, a **patch** version for fixes. Each release is the tag `vX.Y.Z`.

## Unreleased

- **The MX Brio webcam.** The sidebar lists it next to the headset and the mouse, with a live
  preview and everything G Hub sets on it: field of view, zoom, pan and tilt, Show Mode; auto or
  manual exposure (shutter speed, ISO), compensation, HDR and priority; brightness, contrast,
  saturation, vibrance, sharpness, tint, white balance and temperature; auto or manual focus;
  anti-flicker; and the microphones on or off. Each card has G Hub's presets and your own. The
  camera forgets its framing when it restarts, so Libre Hub puts your settings back whenever it
  connects, like G Hub. `librehub camera …` does the same from a terminal. On the Camera page the
  picture fills the page and the framing floats over it on glass, like a camera app: the framing
  presets (G Hub's, named by what they do, then yours) and zoom along the bottom, and a map in the
  corner to drag for pan and tilt. The Image page has the same picture, with exposure, colour and
  focus over it as a photo editor has them: a chip for each adjustment with its value, the picked
  one's control under them, and the group's presets along the top.
- **Fixed: the mouse's DPI buttons took seconds to show in the app**, or only once you clicked
  back into its window. The mouse doesn't say when its DPI level changes, so Libre Hub checked
  every two seconds, and only while its window had the focus. It now sees the DPI buttons being
  pressed and reads the new level at once, whichever window has the focus.
- **Which DPI level is in use** is now marked on the Sensitivity page: a filled dot on the line and
  an "In use" tag on its row. Where the profile starts is a ring, and the sniper level an orange
  middle. The overview's DPI card says what its levels do, and the Computer actions row only shows
  a badge when the agent isn't running in Libre Hub.
- **Fixed: no sidetone after the PC starts with the headset on the dock.** The headset came off
  the dock without sidetone, but the base station still reported it as set, so the settings check
  saw nothing to fix. Libre Hub now sends your sidetone on every check, and checks whenever the
  headset leaves the dock or turns on.

## 1.3.0 - 2026-10-24

- **A new look:** neutral greys with a blue accent, in a dark and a light version. Settings →
  Libre Hub → Appearance picks light, dark or whichever your system uses.
- **Liquid glass where something floats over the page.** Toasts, and the profile bar on the mouse's
  pages, which stays in view while the page scrolls under it, are glass that bends what's behind
  it. Settings → Libre Hub → Liquid glass makes it Clear or Tinted (more opaque, more contrast);
  it's Tinted on its own when the system asks for reduced transparency. The glass is drawn by
  Chromium's compositor, so it costs nothing while nothing on screen changes.

## 1.2.0 - 2026-10-24

- **The G502 X PLUS in the app.** The sidebar now lists both devices; pick the mouse to see its
  pages: Overview, Sensitivity (DPI levels, presets, report rate), Buttons (every control on both
  layers: mouse buttons, keys, media keys, DPI and profile functions, macros you can type or
  record, text, double click, opening apps and running commands), Lighting (effects, idle
  lighting and timers, Freestyle) and Settings (profiles, on-board mode, startup effect, backup
  and restore). Changes are saved on the mouse. The tray menu shows the mouse's battery too.
- **One command, `librehub`,** replaces `a50x` and `g502x`: `librehub headset …` and
  `librehub mouse …` take the same commands as before, and `librehub status` shows both devices.
  If you run `librehub mouse agent` as a service, copy `linux/g502x-agent.service` again.
- **Allow access with one click (Linux).** The first time, instead of commands to paste into a
  terminal, Libre Hub shows **Allow access**: your desktop asks for your password, and both
  devices connect right away, without replugging. Settings → Libre Hub shows whether access is set
  up, and updates or removes it. One rule, `70-libre-hub.rules`, now covers both devices and
  replaces `70-logitech-a50x.rules` and `70-logitech-g502x.rules` (the app removes those when it
  installs it). If you already had them, nothing changes until you choose to update.
- Libre Hub now connects to a device that is plugged in, or gets its udev permission, after the
  app started. Before, it kept looking without ever retrying.

## 1.1.0 - 2026-10-22

- **Check for updates now:** a small refresh button next to the firmware version, at the bottom
  of the sidebar, checks for a new version right away instead of waiting for the scheduled
  check. A message says what it found: up to date, downloading, ready to install (with Restart
  to update), or why the check failed. The button only shows in the AppImage.
- **The mic level is a row of LED dots** on the Microphone page, lit from the left up to the
  level, instead of a scrolling trace. Every dot goes dark when the noise gate cuts your mic to
  silence.

## 1.0.1 - 2026-10-22

- The application menu, launcher and login entry keep Libre Hub's icon when you run it from the
  AppImage. They used to point inside the AppImage, which only exists while the app is open.
  The icon is now installed into your icon theme, like other apps.

## 1.0.0 - 2026-10-22

The first release of Libre Hub, a G Hub replacement for the Logitech A50 X on Linux.

- **Every headset setting G Hub has:** sidetone, game/voice balance, volume and mute, sleep
  timer, tones, base station brightness, mic noise gate, the stream mix, and both 10-band
  equalizers with curated and custom presets. Changes made on the headset show up live.
- **Keeps your settings.** When the computer starts, wakes, unlocks or the headset reconnects,
  Libre Hub reads the headset, puts back anything that changed, and reads it again to confirm.
- **Runs in the system tray**, and can start at login without opening its window.
- **Game and chat audio (Linux):** splits the base station into separate Game and Voice outputs,
  with voice-chat apps routed to Voice automatically.
- **Updates itself** from GitHub releases (AppImage).
- **`a50x` command-line tool** for every setting.
