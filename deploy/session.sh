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
