# Libre Hub

## Pull requests

Every pull request needs a demo: a GIF of the change working in the app, plus the full video
(MP4). For a change with nothing to see in the window, show the CLI or the behaviour it fixes.
If the demo uses simulated data or a stubbed main process, say so in the PR.

Attach the GIF and MP4 to the PR description as GitHub uploads, so GitHub hosts them and the
video plays inline:

1. Use the GitHub CLI, 2.103 or newer (check `gh --version`). `gh pr create`, `gh pr edit` and
   `gh pr comment` take `--attach <file>` (images and video, up to 50 a command) and upload them to
   GitHub. In the body file's Demo section, refer to each file by a path relative to the body
   file: `![alt text](./demo.gif)` for the GIF, `![](./demo.mp4)` on its own line for the video.
   gh replaces each with the uploaded asset, the video as a bare `user-attachments` URL, which
   GitHub plays inline. A file you attach but don't refer to is added at the end of the body.
   Read the body back afterwards (`gh pr view --json body`). A new video's URL can answer 403
   for a minute while GitHub processes it.
2. If gh can't do it (older than 2.103, or the upload fails), use a browser tool you have
   (Claude in Chrome, or the host app's built-in browser) to open the PR on github.com, edit the
   description and upload both files into the Demo section.
3. If neither works, open the PR with a placeholder in the Demo section. Then give the user the
   local paths of both files and ask them to drag the files into the description.

GitHub takes GIFs up to 10 MB: shorten, speed up or shrink the GIF to fit, and keep the MP4 whole.

Don't commit demo media to the repo or to a separate branch.
