#!/bin/sh
# tvbox safe mode: bring the box up with networking and SSH but WITHOUT the TV
# session, so a box that cannot start its session is still reachable and still
# says why.
#
#   tvbox-safemode            decide, early in the boot and before greetd
#   tvbox-safemode --screen   when safe mode is on: start sshd and print the
#                             diagnostics report on the TV
#
# Two ways in:
#
#   requested  an empty file named tvbox-safe-mode on the boot partition, or
#              SAFE_MODE=true in tvbox.conf. Sticky: it holds until removed, and
#              it is the only way in that works when the root filesystem is
#              read-only, because it needs nothing writable.
#   automatic  three starts in a row that never reached the launcher. One boot
#              only: engaging safe mode clears the counter, so the next start is
#              a normal attempt again and a box can never be locked out of its
#              own session by this.
#
# The decision is published as /run/tvbox-safe-mode, which greetd refuses to
# start alongside (its drop-in carries ConditionPathExists=!). /run is a tmpfs,
# so the decision cannot outlive the boot it was made for.
#
# The healthy-boot signal comes the other way across the root boundary: the shell
# writes ~/.tvbox/healthy when the launcher has loaded (shell/boothealth.js), and
# this script deletes it at every boot. Its presence therefore means "the boot
# that just ended got as far as a working launcher" and nothing older. The box
# user can forge it, which only ever suppresses safe mode - it grants nothing -
# and keeping the marker in the user's home is what lets a rootless shell write it.
#
# TVBOX_TEST_ROOT prefixes every path; it exists for deploy/tvbox-safemode.test.js
# and is empty on a box.
set -u

ROOT="${TVBOX_TEST_ROOT:-}"
STATE="$ROOT/var/lib/tvbox"
RUN="$ROOT/run"
BOOT="$ROOT/boot/firmware"
[ -d "$BOOT" ] || BOOT="$ROOT/boot"
CONF="$BOOT/tvbox.conf"
MARKER="$BOOT/tvbox-safe-mode"
FLAG="$RUN/tvbox-safe-mode"
STATEFILE="$STATE/boot-state"
CONSOLE="$ROOT/dev/tty1"
MAX_ATTEMPTS=3 # this many starts without reaching the launcher

conf_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -n1 | tr -d '\r'; }
truthy() { case "$1" in true | TRUE | True | 1 | yes | YES | on) return 0 ;; *) return 1 ;; esac; }
get_state() { conf_get "$STATEFILE" "$1"; }

BOX_HOME=""
for d in "$ROOT"/home/*; do
  [ -d "$d/.tvbox" ] || continue
  BOX_HOME="$d"
  break
done
[ -n "$BOX_HOME" ] || BOX_HOME="$ROOT/home/tv"

# --- --screen: the recovery screen, run late (needs the network to be up) ------

if [ "${1:-}" = "--screen" ]; then
  [ -f "$FLAG" ] || exit 0 # not in safe mode, nothing to show
  # Recovery is the whole point of this mode, so make sure the way in is open. A
  # box with no authorized key and a locked account gains nothing from this, and
  # loses nothing either.
  systemctl start ssh 2> /dev/null || systemctl start sshd 2> /dev/null || true
  DIAG="$(dirname "$0")/tvbox-diag"
  [ -x "$DIAG" ] || DIAG="$(command -v tvbox-diag 2> /dev/null || true)"
  [ -n "$DIAG" ] || exit 0
  # The report on the TV, on the console nothing else is drawing to: greetd is not
  # running in safe mode, so tty1 is what the panel shows. getty's login prompt may
  # be there already; clearing first puts this on top of it.
  #
  # --brief, not the whole report: the console is about 48 rows on a 1360x768 panel
  # and the full report is longer, so printing all of it scrolls the verdict and the
  # warnings off the top - the only part someone on a sofa needs. What to do next is
  # printed here rather than read out of the report, so it stays the last thing on
  # screen whatever the report's length.
  {
    printf '\033[H\033[2J'
    printf 'tvbox SAFE MODE\n%s\n\n' "$(cat "$FLAG" 2> /dev/null)"
    "$DIAG" --brief 2> /dev/null
    printf '\nWhat now:\n'
    printf '  Reboot to try a normal start.\n'
    printf '  To stop coming back here, delete tvbox-safe-mode or set SAFE_MODE=false\n'
    printf '  in tvbox.conf, both on the boot partition (readable on any computer).\n'
    printf '  To get in over SSH, put SSH_AUTHORIZED_KEY=<your public key> there.\n'
  } > "$CONSOLE" 2> /dev/null || exit 0
  # Only when it really is a console: a regular file (the tests) must never make
  # this switch the machine's foreground VT.
  [ -c "$CONSOLE" ] && command -v chvt > /dev/null 2>&1 && chvt 1 2> /dev/null
  exit 0
fi

if [ $# -gt 0 ]; then
  echo "usage: tvbox-safemode [--screen]" >&2
  exit 2
fi

# --- the decision -------------------------------------------------------------

HAD_STATE=no
[ -f "$STATEFILE" ] && HAD_STATE=yes
# What the PREVIOUS boot decided, read before this boot overwrites it.
PREV_SAFE="$(get_state safe-mode)"

PREV=unknown
if [ -f "$BOX_HOME/.tvbox/healthy" ]; then
  PREV=yes
  rm -f "$BOX_HOME/.tvbox/healthy" 2> /dev/null
elif [ "$HAD_STATE" = yes ]; then
  # A safe-mode boot never starts a session, so it cannot have reached a launcher.
  # Reporting that as a failed start would read like a fault in the report right
  # after someone deliberately used safe mode.
  if [ -n "$PREV_SAFE" ] && [ "$PREV_SAFE" != no ]; then
    PREV="n/a (the previous boot was safe mode)"
  else
    PREV=no # there was a previous boot and it never wrote the marker
  fi
fi

ATTEMPTS="$(get_state attempts)"
case "$ATTEMPTS" in '' | *[!0-9]*) ATTEMPTS=0 ;; esac
[ "$PREV" = yes ] && ATTEMPTS=0
ATTEMPTS=$((ATTEMPTS + 1))

REASON=""
if truthy "$(conf_get "$CONF" SAFE_MODE)"; then
  REASON="Requested by SAFE_MODE in tvbox.conf on the boot partition."
elif [ -f "$MARKER" ]; then
  REASON="Requested by the tvbox-safe-mode file on the boot partition."
elif [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
  REASON="$ATTEMPTS starts in a row did not reach the launcher. This boot only; the next one tries normally."
fi

if [ -n "$REASON" ]; then
  mkdir -p "$RUN" 2> /dev/null
  printf '%s\n' "$REASON" > "$FLAG" 2> /dev/null ||
    echo "tvbox-safemode: cannot write $FLAG - the session will start normally" >&2
  echo "tvbox-safemode: SAFE MODE. $REASON" >&2
  # A safe-mode boot is not a failed attempt at the session, so it does not count
  # as one. That is also what makes the automatic trigger a single boot.
  ATTEMPTS=0
fi

# The counter lives on the root filesystem, not the boot partition: it changes at
# every boot and FAT is the one medium that has to stay intact for the report. A
# read-only root therefore loses the counter and the automatic trigger with it,
# which is why the boot-partition marker exists and needs nothing writable.
if ! mkdir -p "$STATE" 2> /dev/null; then
  echo "tvbox-safemode: cannot create $STATE (root filesystem read-only?)" >&2
  exit 0
fi
# Temp file then rename, so an interrupted write cannot leave a half-parsed counter
# behind and talk the next boot into safe mode.
if {
  echo "# tvbox boot state, written by tvbox-safemode at every boot."
  echo "attempts=$ATTEMPTS"
  echo "max-attempts=$MAX_ATTEMPTS"
  echo "prev-healthy=$PREV"
  echo "safe-mode=${REASON:-no}"
} > "$STATEFILE.tmp" 2> /dev/null && mv -f "$STATEFILE.tmp" "$STATEFILE" 2> /dev/null; then
  exit 0
fi
rm -f "$STATEFILE.tmp" 2> /dev/null
echo "tvbox-safemode: cannot write $STATEFILE (root filesystem read-only?)" >&2
exit 0
