#!/bin/sh
# Recover the screen without the launcher's help (installed to ~/.tvbox/recover.sh).
#
# tvbox-wc runs this when the remote's Home key is held, which is the one input
# that still arrives when the launcher's page is crashed, frozen or has lost its
# cursor. Two stages, the second only if the first did not help and the key is
# still down:
#
#   recover.sh reload    the shell reloads the launcher and brings it forward
#   recover.sh restart   the shell is ended; session.sh's respawn loop starts a new one
#
# Keep it dependency-free POSIX sh, like run-shell.sh: it is what runs when other
# things have gone wrong.
set -u

# The shell's main process: an electron with no --type= in its command line, and
# whose parent is not an electron itself. Every child (zygote, renderer, GPU,
# utility) carries --type=, but Chromium rewrites a child's argv into one
# space-joined string, so the flag is looked for anywhere rather than as an
# argument of its own; the parent test catches any child that still slipped by.
main_pids() {
	all=""
	# Only a process whose EXECUTABLE is electron: the command line alone also
	# matches anything that merely mentions the path, an ssh session included.
	for pid in $(pgrep -f 'electron[/]dist/electron' 2>/dev/null); do
		case "$(readlink "/proc/$pid/exe" 2>/dev/null)" in
		*/electron/dist/electron | */electron/dist/electron" (deleted)") all="$all $pid" ;;
		esac
	done
	for pid in $all; do
		tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q -e ' --type=' && continue
		ppid=$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)
		case " $(echo $all) " in *" $ppid "*) continue ;; esac
		echo "$pid"
	done
}

case "${1:-}" in
reload)
	pids=$(main_pids)
	if [ -z "$pids" ]; then
		echo "tvbox-recover: no shell running - the respawn loop will start one" >&2
		exit 0
	fi
	echo "tvbox-recover: asking the shell to reload the launcher" >&2
	for pid in $pids; do
		# A shell in its first seconds has not installed a handler yet, and the
		# signal's default action would end it. It is starting anyway.
		age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
		case "$age" in "" | *[!0-9]*) age=0 ;; esac
		if [ "$age" -lt 3 ]; then
			echo "tvbox-recover: the shell is still starting" >&2
			continue
		fi
		kill -USR2 "$pid" 2>/dev/null
	done
	;;
restart)
	pids=$(main_pids)
	[ -n "$pids" ] || exit 0
	echo "tvbox-recover: restarting the shell" >&2
	for pid in $pids; do kill -TERM "$pid" 2>/dev/null; done
	# A shell that is hung does not act on SIGTERM. Five seconds is longer than a
	# clean shutdown takes (a native app gets 2.5 s to save) and short enough that
	# holding the key is not mistaken for nothing happening.
	i=0
	while [ "$i" -lt 5 ]; do
		sleep 1
		alive=""
		for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
		[ -n "$alive" ] || exit 0
		i=$((i + 1))
	done
	for pid in $alive; do kill -KILL "$pid" 2>/dev/null; done
	;;
*)
	echo "usage: recover.sh reload|restart" >&2
	exit 2
	;;
esac
