#!/bin/bash
# Usage: wire.sh <label> <plugin-dir> <session-id> <cwd>
# Forks a real session, /compact with the plugin, then one probe turn in a new process;
# prints the first post-compaction request as seen on the wire.
set -u
S=$(cd "$(dirname "$0")" && pwd); OUT=${WIRE_OUT:-/tmp/jev-wire}
label=$1; plugin=$2; sid=$3; cwd=$4
out=$OUT/$label-${sid:0:8}; mkdir -p "$out"
port=$((8800 + RANDOM % 900))
node "$S/proxy.mjs" "$out/cap" "$port" & pid=$!
trap 'kill $pid 2>/dev/null' EXIT
sleep 1
off='{"enabledPlugins":{"jev-compaction-plus@jev-compaction-plus":false,"fast-jev-compaction@fast-jev-compaction":false}}'
cd "$cwd" || exit 2
ANTHROPIC_BASE_URL=http://127.0.0.1:$port claude -p "/compact" --resume "$sid" --fork-session --plugin-dir "$plugin" --settings "$off" \
  --debug-file "$out/debug1.log" --output-format json < /dev/null > "$out/compact.json" 2> "$out/compact.err"
fork=$(python3 -c "import json;print(json.load(open('$out/compact.json')).get('session_id',''))")
echo "fork $fork" | tee "$out/fork"
[ -n "$fork" ] || { head -c 400 "$out/compact.err"; exit 3; }
rm -f "$out"/cap/*
ANTHROPIC_BASE_URL=http://127.0.0.1:$port claude -p "只回覆 ok" --resume "$fork" --plugin-dir "$plugin" --settings "$off" \
  --debug-file "$out/debug2.log" --output-format json < /dev/null > "$out/probe.json" 2> "$out/probe.err"
grep -h -E 'kept [0-9]+/|fallback to built-in|skipped, conversation|hooks module jev' "$out/debug1.log" | cut -c1-260
first=$(ls "$out"/cap/*.req.json 2>/dev/null | while read -r f; do python3 - "$f" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1]))
if len(d.get('messages',[]))>3 and d.get('tools'): print(sys.argv[1])
EOF
done | head -1)
python3 "$S/classify.py" "$first"
