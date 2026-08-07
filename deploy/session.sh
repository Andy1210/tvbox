#!/bin/sh
# The box's session (installed to ~/.tvbox/session.sh), started by the compositor.
#
# It replaces the labwc autostart, and it is shorter than that was because the
# compositor does the rest itself: it owns the output modes (no kanshi), clears to
# black behind every client (no swaybg), hides the idle pointer, and picks the
# render node without being told.
#
# Keep it dependency-free POSIX sh. It runs before anything else in the session, so
# a missing interpreter here is a black screen.
set -u

# Tell the user's own service manager which display this session is on.
#
# Nothing here needs it; what needs it is everything systemd or D-Bus starts on
# demand later, because those inherit the manager's environment and not ours. The
# xdg-desktop-portal GTK backend is the one that bites: without WAYLAND_DISPLAY it
# exits with "cannot open display", the portal then answers no Settings call, and
# every app that asks one waits out the full 25-second D-Bus timeout before it
# draws anything. Measured on the box: a game's first frame at 25.2 s, and 0.5 s
# once this line existed. Qt apps (the Dolphin core) pay the same toll.
#
# XDG_SESSION_TYPE is exported first because logind calls a greetd session "tty" -
# it is a Wayland session, and toolkits key off that.
XDG_SESSION_TYPE=wayland
export XDG_SESSION_TYPE

# Keep a crashing app's core dump from writing more than it has to.
#
# The default filter (0x33) includes shared anonymous mappings, which is what an
# emulator's fastmem arena is: guest memory mapped through a multi-gigabyte
# window. Clearing bit 1 drops those and keeps the stacks, heap and JIT pages, so
# a backtrace still works.
#
# On its own this does NOT make a dump cheap, and it was measured not to: the
# Dolphin core's address space is 65 GB against 475 MB resident, and a coredump
# PIPE cannot skip a hole - the kernel writes it out as zeroes, a page at a time -
# so the dump still ran past twenty seconds. What bounds the freeze is the
# RuntimeMaxSec drop-in; this only lowers what must be written before that bound.
#
# coredump_filter is inherited by every child and survives exec, bwrap included,
# so `flatpak run` apps get it too. A kernel without the knob is not a reason to
# stop the session.
echo 0x31 >/proc/self/coredump_filter 2>/dev/null || true
# Both ways, because the first can fail for reasons its presence does not cover (no
# session bus yet, a manager that refuses the set), and a silent skip here is a
# 25-second stall in every app later.
dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE >/dev/null 2>&1 ||
	systemctl --user import-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE >/dev/null 2>&1 ||
	echo "tvbox-session: could not export the session environment; portal-backed apps will be slow to start" >&2

# Route audio to HDMI. Honour the OTA `current` symlink (like run-shell.sh) so a
# release's own copy wins over the dev tree.
AUDIO_SH="$HOME/.tvbox/current/shell/audio-default.sh"
[ -f "$AUDIO_SH" ] || AUDIO_SH="$HOME/.tvbox/shell/audio-default.sh"
sh "$AUDIO_SH" >/dev/null 2>&1 &

# The shell, respawned on crash. A plain loop rather than a helper from the Pi
# desktop: the flashable image is Raspberry Pi OS Lite and has none of that. It also
# keeps the OTA rollback contract - run-shell.sh exec's Electron, so when Electron
# exits run-shell.sh exits, we re-run it, and its own attempt counter and rollback
# run again.
while :; do
	"$HOME/.tvbox/run-shell.sh"
	sleep 1
done
