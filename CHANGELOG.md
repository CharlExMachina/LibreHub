# Changelog

Libre Hub follows [Semantic Versioning](https://semver.org): a **major** version for changes
that break something you rely on (a moved settings file, a dropped feature), a **minor** version
for new features, a **patch** version for fixes. Each release is the tag `vX.Y.Z`.

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
