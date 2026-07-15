#!/bin/sh
# tvbox - set the default PipeWire sink. By default auto-detects whatever HDMI
# output is present (falls back to the first available sink), so it's TV/port-
# independent. An optional arg ($1 = a sink node.name) is a MANUAL OVERRIDE from
# Settings: if that sink is present it wins; otherwise we fall back to auto. Uses
# pw-metadata (the rescan-revert-proof method).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
preferred="$1"

sink_ids=$(wpctl status 2>/dev/null | sed -n '/Sinks:/,/Sources:/p' | grep -oE '[0-9]+\. ' | grep -oE '[0-9]+')
hdmi="" first_name="" pref_ok=""
for id in $sink_ids; do
  name=$(wpctl inspect "$id" 2>/dev/null | grep -m1 'node.name' | sed -E 's/.*= "//; s/".*//')
  [ -z "$name" ] && continue
  [ -z "$first_name" ] && first_name="$name"
  [ -n "$preferred" ] && [ "$name" = "$preferred" ] && pref_ok="$name"
  case "$name" in *hdmi*|*HDMI*) [ -z "$hdmi" ] && hdmi="$name";; esac
done

# manual override (if present) > HDMI > first sink
target="${pref_ok:-${hdmi:-$first_name}}"
if [ -n "$target" ]; then
  pw-metadata -n default 0 default.audio.sink "{\"name\":\"$target\"}" >/dev/null 2>&1
  pw-metadata -n default 0 default.configured.audio.sink "{\"name\":\"$target\"}" >/dev/null 2>&1
fi
# stdout: the effective sink node.name (consumed by main.js for mpv --audio-device)
echo "$target"
