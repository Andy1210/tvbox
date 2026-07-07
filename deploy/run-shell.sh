#!/bin/sh
# Launch the tvbox Electron shell inside the labwc Wayland session.
# Invoked from ~/.config/labwc/autostart in a respawn loop (restarts on crash).
#
# OTA health gate: updater.js installs a release under ~/.tvbox/versions/<v>,
# flips the ~/.tvbox/current symlink and writes update/pending ("<prev> <new>").
# Every (re)spawn while that marker exists bumps update/attempts; a release
# that can't reach its first healthy boot (the shell commits the update on the
# launcher's first page load, clearing the markers) gets 3 tries, then we flip
# `current` back and record update/failed for the UI. This file must stay
# self-sufficient - it is the rollback path when the NEW shell is the broken
# part. Without a `current` symlink the dev tree (~/.tvbox/shell, deploy.sh)
# runs, which is also where a rollback from the first-ever OTA update lands
# ("-" as <prev>).
export ELECTRON_OZONE_PLATFORM_HINT=wayland
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

TVBOX="$HOME/.tvbox"
UPD="$TVBOX/update"

if [ -f "$UPD/pending" ]; then
  read -r PREV NEXT < "$UPD/pending"
  N=$(cat "$UPD/attempts" 2>/dev/null || echo 0)
  N=$((N + 1))
  echo "$N" > "$UPD/attempts"
  if [ "$N" -gt 3 ] && [ -n "$NEXT" ]; then
    echo "tvbox: update to $NEXT failed to boot $((N - 1))x - rolling back to ${PREV:--dev-tree-}" >&2
    if [ "$PREV" = "-" ] || [ ! -d "$TVBOX/versions/$PREV" ]; then
      rm -f "$TVBOX/current"
    else
      ln -sfn "$TVBOX/versions/$PREV" "$TVBOX/current"
    fi
    printf '%s %s\n' "$PREV" "$NEXT" > "$UPD/failed"
    rm -f "$UPD/pending" "$UPD/attempts"
  fi
fi

# Boot watchdog for the attempt just started: a broken release doesn't always
# EXIT - an Electron main-process exception pops an error dialog and hangs,
# which would freeze the attempt counter forever. If the update isn't
# committed (pending cleared by the shell's first healthy page load) within
# 90s, kill the shell; the autostart respawn loop restarts us and the counter/rollback above
# proceeds. Survives the exec below (it's a separate background process).
if [ -f "$UPD/pending" ]; then
  (
    t=0
    while [ "$t" -lt 90 ]; do
      sleep 3
      t=$((t + 3))
      [ -f "$UPD/pending" ] || exit 0   # committed (or reset by a dev deploy)
    done
    if [ -f "$UPD/pending" ]; then
      echo "tvbox: boot watchdog - update not committed in ${t}s, killing the shell for retry/rollback" >&2
      pkill -f 'electron[/]dist'
    fi
  ) &
fi

if [ -d "$TVBOX/current/shell" ]; then
  cd "$TVBOX/current/shell" || exit 1
else
  cd "$TVBOX/shell" || exit 1
fi
# Capture this session's shell output (main-process + renderer console, mpv) to a
# log for on-device debugging over ssh - `cat ~/.tvbox/shell.log`. Truncated each
# boot so it stays bounded to one session. Harmless on a kiosk (no console shown).
exec ./node_modules/.bin/electron . --ozone-platform=wayland --no-sandbox >"$TVBOX/shell.log" 2>&1
