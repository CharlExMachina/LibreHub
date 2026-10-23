# Hands-on testing with a person

Some behaviour only a person can produce or see: pressing a button, watching an LED. The
person reads your messages only between turns, so put the prompt on their screen instead.
On macOS, `osascript` dialogs work well. Each test should read as a short script: set the
device up, show a dialog, read the answer, restore. `tools/re/g502x-handson.mjs` is the
template; the logs from the G502 work are in `docs/evidence/g502x/lab/`.

## Dialogs as instruments

```js
execFileSync('osascript', ['-e', `activate\ndisplay dialog "…" default answer "" buttons {"No", "Yes"} with title "Mouse test" giving up after 600`])
```

- **A text field is a typing oracle.** `default answer ""` gives a focused field, so a key
  macro types into it and the returned text shows exactly what the device sent (`"hi"`,
  `"alpha Hello, World! gamma"`). Prefill it (`default answer "alpha beta gamma"`) to test a
  double-click: the person double-clicks "beta", then a text macro replaces it.
- **Click-only answers** are the most reliable. Use `buttons {"No","Yes"}` with no default
  button, or `choose from list {…}` for a pick. Read typed comments as a bonus: one answer was
  "Yes" with the text "nope, still purple", because Return chose the default button.
- **Name things by the vendor's map, not by position.** Ask "which colour do you see",
  never "which LED is lit". Map LEDs and buttons with G Hub's `metadata.json` / `light_map.json`.
- Return may not reach the dialog when the person clicked elsewhere first; tell them to click
  OK.
- `execFileSync` blocks Node's event loop, so device events queue up while a dialog is open
  and arrive all at once when it closes. That's fine for logging presses; use async
  `execFile` if you must react while the dialog is up.
- Run long tests in the background and watch their log, so the person can work through the
  dialogs at their own pace. A device that sleeps between dialogs answers "unknown device"
  until it is moved; say so in the prompt.
- Run one probe per variant with a distinct colour or text each, so one answer settles one
  question (lab5: A green, B red, C blue, D yellow).

## Shell gotchas

- In a non-interactive shell, background jobs ignore SIGINT, so `kill -INT` does nothing.
  Stop background agents with SIGTERM.
- Don't stop a hands-on helper by waiting on a fixed timer the person may miss. Wait on the
  event itself (the action log line, the file the action creates), with a generous timeout.

## Recording a demo

The repo's `CLAUDE.md` asks every PR for a GIF and an MP4. The screen holds other people's
work, so record a region, not the screen:

1. Tile the windows to fill the region exactly, so nothing else shows: a Terminal on the
   left, the target app or a TextEdit note on the right. Place them with AppleScript
   (`set bounds of front window to {x1, y1, x2, y2}`). Run the Terminal script under
   `env -i … bash --norc --noprofile` with `printf '\e]0;Libre Hub demo\a'`, so no prompt
   shows the user or host name, and crop the region below the title bars.
2. Record with ffmpeg, which stops cleanly on SIGTERM (stopping `screencapture` with a signal
   lost the file):
   `ffmpeg -f avfoundation -capture_cursor 1 -framerate 30 -i "Capture screen 0" -vf "crop=W:H:X:Y" -pix_fmt yuv420p demo.mp4`
   (crop values in pixels: twice the points on a Retina screen).
3. Cue the person with a dialog when it's their turn ("Your turn: … Click OK to start"). It
   shows in the recording, which is fine. End the recording when their last action has
   happened (watch for it), not on a timer.
4. Check every part before uploading: tile frames with
   `ffmpeg -vf "fps=1/2,scale=400:-1,tile=5x5"` and look for anything outside the demo. Cut
   from the start any second where windows were still moving into place.
5. Encode: `libx264 -crf 26` MP4, and a GIF at 10 fps and about 860 px through
   `palettegen`/`paletteuse`. Upload both through the PR page (a browser signed in to
   GitHub). Dropping files on the comment box and copying the `user-attachments` URLs into the
   description works without posting a comment.
