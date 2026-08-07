#!/bin/sh
# Launch the tvbox Electron shell inside the Wayland session.
# Invoked from ~/.tvbox/session.sh in a respawn loop (restarts on crash).
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

# Safe mode keeps the session down at the greetd layer, so normally nothing gets
# this far. This is the belt for a box whose session comes up some other way (a
# display manager without our drop-in): the point of safe mode is that the shell
# is NOT what the box is trying to run. Before the attempt counter below, because a
# safe-mode boot must not spend one of the three tries a release gets. The sleep
# keeps the respawn loop from spinning on the exit.
if [ -e /run/tvbox-safe-mode ]; then
  echo "tvbox: safe mode - not starting the shell ($(cat /run/tvbox-safe-mode 2>/dev/null))" >&2
  sleep 60
  exit 0
fi

# Never start while the previous shell is still going. Two Electron instances fight
# over Chromium's storage lock and the loser silently gets an in-memory
# localStorage, so the launcher forgets the box was ever set up and offers
# onboarding again.
#
# This runs BEFORE the attempt counter below and gives up rather than falling
# through: a shell that starts anyway would spend one of the three boot attempts a
# release gets, and a wedged predecessor could roll a perfectly good update back.
# The respawn loop simply tries again a second later (and during an update the boot
# watchdog kills a wedged shell, which is what breaks the tie).
#
# A main process is any electron whose argv carries no --type= (every child -
# renderer, GPU, utility - does). Matching argv ORDER instead would be brittle: the
# app path and the flags trade places depending on how electron is invoked.
shell_running() {
  for pid in $(pgrep -f 'electron[/]dist/electron' 2>/dev/null); do
    tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -q '^--type=' || return 0
  done
  return 1
}
i=0
while [ "$i" -lt 20 ] && shell_running; do
  sleep 1
  i=$((i + 1))
done
if shell_running; then
  echo "tvbox: another shell is still running after ${i}s - not starting a second one" >&2
  exit 0
fi

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

# Opt-in Chromium DevTools protocol, for measuring the launcher on the TV it
# actually runs on: `touch ~/.tvbox/debug-port` (or write a port into it), restart
# the shell, then `ssh -L 9222:127.0.0.1:9222` and attach a CDP client. There is
# nowhere to pass an argument - greetd starts the session and the session starts
# this script - so the request is a marker file.
#
# **The marker is consumed, not honoured for ever.** One request, one boot. An open
# DevTools endpoint is arbitrary code in the launcher window, which runs with Node in
# its preload, so it reaches ~/.tvbox/config.json and everything in it; leaving a
# forgotten `touch` to survive every reboot and OTA update is not a debug aid, it is a
# back door with no indication on the TV that it is there.
#
# Two deliberate omissions. There is no `--remote-debugging-address`, so the endpoint
# binds loopback - that is Chromium's default for the absence of that switch, not a
# property of the port flag, so do not add one. And no `--remote-allow-origins`: a CDP
# client sends no Origin header and does not need it, while a wildcard would let any
# PAGE this Chromium renders - including third-party app windows - open the endpoint.
# Add `--remote-allow-origins=devtools://devtools` only if you attach a browser
# DevTools frontend, and take it out again afterwards.
#
# Note the message below goes to the session's stderr (the greetd journal), NOT to
# shell.log - the redirect on the exec line truncates that file a moment later.
TVBOX_DEBUG_ARGS=""
if [ -f "$TVBOX/debug-port" ]; then
  port=$(cat "$TVBOX/debug-port" 2>/dev/null)
  rm -f "$TVBOX/debug-port"
  # Digits only, and a port this user can actually bind. 0 would make Chromium pick a
  # random one and report a port that is not the one it listens on.
  # Digits only AND at most five of them: a longer run of digits passes the first
  # test but overflows the integer comparison below, which exits 2 and leaves the
  # value in place.
  case "$port" in
    *[!0-9]* | "" | ??????*) port=9222 ;;
  esac
  if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then port=9222; fi
  TVBOX_DEBUG_ARGS="--remote-debugging-port=$port"
  echo "tvbox: DevTools protocol on 127.0.0.1:$port for THIS boot only (marker consumed)" >&2
fi
# Capture this session's shell output (main-process + renderer console, mpv) to a
# log for on-device debugging over ssh - `cat ~/.tvbox/shell.log`. Truncated each
# boot so it stays bounded to one session. Harmless on a kiosk (no console shown).
# Deliberately NO --no-sandbox. That switch is process-wide: it also stripped the
# OS sandbox off the remote-app windows, which ask for `sandbox: true` precisely
# because they load someone else's web content. Chromium sandboxes them through
# the namespace layer here - own pid+user namespace, seccomp-BPF - which needs
# unprivileged user namespaces (the Pi kernel allows them) and NOT a setuid
# chrome-sandbox, so the npm-installed helper staying non-setuid is fine. Windows
# that opt out per-window (the launcher, local apps - they need Node in the
# preload) are unaffected either way.
exec ./node_modules/.bin/electron . --ozone-platform=wayland $TVBOX_DEBUG_ARGS >"$TVBOX/shell.log" 2>&1
