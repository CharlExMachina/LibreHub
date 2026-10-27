#!/bin/bash
# mxbrio-ghub-diff.sh NAME PATH JSON: read every MX Brio control, have G Hub SET a card, read again,
# print what changed. Needs uvc.cjs and ws-send.mjs next to it, usb@2 and ws installed; OUT=dir for the files.
cd "$(dirname "$0")"; mkdir -p "${OUT:-exp}"
node uvc.cjs cur | tr ',' '\n' > "${OUT:-exp}/$1.before"
node ws-send.mjs SET "$2" "$3" > "${OUT:-exp}/$1.ws.txt" 2>&1
sleep 1.5
node uvc.cjs cur | tr ',' '\n' > "${OUT:-exp}/$1.after"
echo "== $1: $(grep -o '"code": *"[A-Z_]*"' ${OUT:-exp}/$1.ws.txt | head -1)"
diff "${OUT:-exp}/$1.before" "${OUT:-exp}/$1.after" | grep '^[<>]'
