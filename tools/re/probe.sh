#!/bin/bash
# usage: probe.sh SECS -- then lines on stdin: "VERB PATH JSON" ; sniffs HID during the whole sequence
SECS=$1; OUT=$(mktemp)
node hid-sniff.mjs $SECS > $OUT 2>&1 &
sleep 0.8; T0=$(python3 -c 'import time;print(time.time())')
while IFS=$'\t' read -r V P J; do
  [ -z "$V" ] && continue
  T=$(python3 -c "import time;print(int((time.time()-$T0)*1000)+800)")
  echo "--- t=$T $V $P $J"; node ws-send.mjs "$V" "$P" "$J" | python3 -c 'import json,sys
for l in sys.stdin:
  j=json.loads(l); print("    ->", j["result"]["code"], j["result"].get("what",""), json.dumps(j.get("payload",""))[:300])'
  sleep 1
done
wait; cat $OUT
