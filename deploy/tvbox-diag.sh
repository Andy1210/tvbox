#!/bin/sh
# tvbox out-of-band diagnostics: a plain-text report on the FAT boot partition.
#
#   tvbox-diag             write <boot>/tvbox-diag.txt
#   tvbox-diag --logs      also write <boot>/tvbox-diag-logs.txt (journal + shell.log tails)
#   tvbox-diag --stdout    print the report, write nothing
#   tvbox-diag --brief     print the short form that fits a TV console, write nothing
#
# The boot partition is the only medium the firmware, this box, and any laptop
# running any OS can all read, and it stays readable when the root filesystem has
# gone full or read-only - which is exactly the state this report has to describe.
# So nothing here needs the network, the shell, or a writable root, and nothing
# here blocks: no pings, no DNS lookups, no HTTP. A boot must never wait on it.
#
# The file is world-readable (FAT has no ownership), so it carries NO secrets:
# tvbox.conf keys are reported by name and "set"/"empty" only, never by value, and
# authorized_keys is reported as a count.
#
# Runs as root (the boot partition mounts fmask=0022) from tvbox-diag.service and
# its timer. TVBOX_TEST_ROOT prefixes every path read or written below; it exists
# for deploy/tvbox-diag.test.js and is empty on a box.
set -u

ROOT="${TVBOX_TEST_ROOT:-}"
PROC="$ROOT/proc"
SYS="$ROOT/sys"
ETC="$ROOT/etc"
STATE="$ROOT/var/lib/tvbox"
RUN="$ROOT/run"
BOOT="$ROOT/boot/firmware"
[ -d "$BOOT" ] || BOOT="$ROOT/boot"
SAFE_FLAG="$RUN/tvbox-safe-mode"
OUT="$BOOT/tvbox-diag.txt"
LOGS="$BOOT/tvbox-diag-logs.txt"
SHELL_PORT_HEX=1FA1 # 8097, the shell's HTTP API on 127.0.0.1
SSH_PORT_HEX=0016   # 22

MODE="report"
WANT_LOGS=no
for a in "$@"; do
  case "$a" in
    --logs) WANT_LOGS=yes ;;
    --stdout) MODE=stdout ;;
    --brief) MODE=brief ;;
    -h | --help)
      echo "usage: tvbox-diag [--logs] [--stdout | --brief]"
      exit 0
      ;;
    *)
      echo "tvbox-diag: unknown argument: $a" >&2
      exit 2
      ;;
  esac
done
# The printing modes write nothing, so asking for the log dump alongside one of them
# is a contradiction. Refused rather than half-honoured: silently writing a file
# while claiming to write none is worse than saying no.
if [ "$WANT_LOGS" = yes ] && [ "$MODE" != "report" ]; then
  echo "tvbox-diag: --logs writes a file, so it cannot be combined with --$MODE" >&2
  exit 2
fi

# The box user is whoever owns a ~/.tvbox tree. Discovered rather than hardcoded
# or baked in at install time, so one unit file works on a box whose user is not
# "tv" and keeps working if the account is renamed.
BOX_USER=""
BOX_HOME=""
for d in "$ROOT"/home/*; do
  [ -d "$d/.tvbox" ] || continue
  BOX_HOME="$d"
  BOX_USER="$(basename "$d")"
  break
done
[ -n "$BOX_HOME" ] || BOX_HOME="$ROOT/home/tv"
TVBOX_DIR="$BOX_HOME/.tvbox"

# Problems are hoisted above the detail: the person reading this file wants the
# answer, not a tour. They are emitted INTO the report stream behind a marker and
# split back out afterwards, because the report is generated in a subshell and a
# shell variable assigned there would not survive it.
WARN_MARK='@@warn@@'
warn() { echo "$WARN_MARK $1"; }

# --- small helpers, each degrading to "unknown" rather than failing -----------

# Read a whole file, trimmed, NUL bytes stripped (device-tree strings carry one).
slurp() { [ -r "$1" ] && tr -d '\000' < "$1" | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//'; }

# Read one KEY from a KEY=value file. Not sourced: values may hold spaces, '#',
# '$' or '/' with no quoting, and this must never execute what it reads.
conf_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -n1 | tr -d '\r'; }

fmt_dur() {
  s="${1:-0}"
  case "$s" in '' | *[!0-9]*) echo "unknown"; return ;; esac
  d=$((s / 86400))
  h=$(((s % 86400) / 3600))
  m=$(((s % 3600) / 60))
  [ "$d" -gt 0 ] && printf '%dd ' "$d"
  printf '%dh %dm\n' "$h" "$m"
}

# Is anything LISTENING on this hex port? Parsed out of /proc rather than asked of
# ss/curl: it needs no package and answers even when the network stack is broken.
listening() {
  for f in "$PROC/net/tcp" "$PROC/net/tcp6"; do
    [ -r "$f" ] || continue
    awk -v p="$1" 'NR > 1 && $4 == "0A" && $2 ~ ("^[0-9A-Fa-f]*:" p "$") { found = 1 }
                   END { exit !found }' "$f" 2>/dev/null && return 0
  done
  return 1
}

# systemctl is only meaningful on a live system; a missing one must not abort.
unit_state() {
  command -v systemctl > /dev/null 2>&1 || { echo "unknown"; return; }
  systemctl is-active "$1" 2>/dev/null || true
}

mount_opts() { [ -r "$PROC/mounts" ] && awk -v t="$1" '$2 == t { print $4; exit }' "$PROC/mounts"; }

# df -P keeps one record per filesystem on one line whatever the device name's
# length, which the default output does not guarantee.
df_line() { df -P -h "$1" 2>/dev/null | awk 'NR == 2 { print $4 " free of " $2 " (" $5 " used)" }'; }

# Read once, outside the report: two sections need it, and the boot-time run has to
# be able to tell "not up yet" from "broken".
UPSEC="$(cut -d. -f1 < "$PROC/uptime" 2> /dev/null || echo 0)"
case "$UPSEC" in '' | *[!0-9]*) UPSEC=0 ;; esac

# --- the report ---------------------------------------------------------------

RAW="$(
  echo "== box =="
  MODEL="$(slurp "$PROC/device-tree/model")"
  echo "host:         $(slurp "$ETC/hostname") ${MODEL:-unknown model}"
  OS="$(conf_get "$ETC/os-release" PRETTY_NAME | tr -d '"')"
  echo "os:           ${OS:-unknown} / kernel $(uname -sr 2> /dev/null || echo unknown)"
  # The running tvbox is whatever `current` points at, or the dev tree when there
  # is no symlink - the same resolution order run-shell.sh uses to start it.
  VERSION_SRC="$TVBOX_DIR/shell/package.json"
  VERSION_KIND="dev tree"
  if [ -d "$TVBOX_DIR/current/shell" ]; then
    VERSION_SRC="$TVBOX_DIR/current/shell/package.json"
    VERSION_KIND="release $(basename "$(readlink "$TVBOX_DIR/current" 2> /dev/null || echo unknown)")"
  fi
  VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VERSION_SRC" 2> /dev/null | head -n1)"
  echo "tvbox:        ${VERSION:-unknown} ($VERSION_KIND, user ${BOX_USER:-unknown})"
  echo "written:      $(date '+%Y-%m-%d %H:%M:%S %Z' 2> /dev/null || echo unknown), up $(fmt_dur "$UPSEC")"

  echo
  echo "== boot =="
  ATTEMPTS="$(conf_get "$STATE/boot-state" attempts)"
  MAXATT="$(conf_get "$STATE/boot-state" max-attempts)"
  PREV="$(conf_get "$STATE/boot-state" prev-healthy)"
  SMSTATE="$(conf_get "$STATE/boot-state" safe-mode)"
  # Counted, not ordinal: at 0 "attempt 0 of 3" reads like a bug, and what the
  # number actually means is how many starts in a row have missed the launcher.
  if [ -n "$ATTEMPTS" ]; then
    echo "failed boots: $ATTEMPTS of ${MAXATT:-?} in a row engage safe mode"
    echo "last boot:    reached the launcher: ${PREV:-unknown}"
  else
    echo "failed boots: unknown (no $STATE/boot-state - tvbox-safemode has not run)"
  fi
  if [ -f "$SAFE_FLAG" ]; then
    echo "safe mode:    ON. $(slurp "$SAFE_FLAG")"
    echo "              No TV session on purpose. Reboot to try a normal start."
  else
    echo "safe mode:    off${SMSTATE:+ (last decision: $SMSTATE)}"
  fi

  echo
  echo "== session =="
  echo "greetd:       $(unit_state greetd)"
  if listening "$SHELL_PORT_HEX"; then
    echo "shell:        answering on 127.0.0.1:8097"
  elif [ -f "$SAFE_FLAG" ]; then
    echo "shell:        not running (safe mode - expected)"
  elif [ "$UPSEC" -lt 120 ]; then
    # The boot-time run happens while the session is still coming up: greetd, the compositor
    # and Electron all have to start before the port is bound. The timer rewrites
    # this file two minutes in, and by then a working box is serving.
    echo "shell:        not up yet (the box is still starting)"
  else
    echo "shell:        NOT listening on 127.0.0.1:8097"
    warn "the tvbox shell is not serving its API - see tvbox-diag-logs.txt and $TVBOX_DIR/shell.log"
  fi

  echo
  echo "== storage =="
  ROOTFS="$(df_line "$ROOT/")"
  echo "/             ${ROOTFS:-unknown}"
  echo "/boot/firm.   $(df_line "$BOOT")"
  case ",$(mount_opts /)," in
    *,ro,*)
      echo "              root is mounted READ-ONLY"
      warn "the root filesystem is READ-ONLY. ext4 does that after an I/O or space error; nothing on the box can save anything. Reboot to let fsck run, then check for a full disk."
      ;;
  esac
  # A rootfs this small is the un-grown flashed image: it fills up on the first
  # boot and takes the whole box down with it (tvbox-expand-rootfs exists to
  # prevent it, so seeing it here means that unit did not run).
  ROOTKB="$(df -P -k "$ROOT/" 2> /dev/null | awk 'NR == 2 { print $4 }')"
  case "$ROOTKB" in
    '' | *[!0-9]*) ;;
    *) [ "$ROOTKB" -lt 524288 ] && warn "only $((ROOTKB / 1024)) MB free on / - the box cannot write logs, host keys or app data. Check that tvbox-expand-rootfs.service ran." ;;
  esac
  BOOTKB="$(df -P -k "$BOOT" 2> /dev/null | awk 'NR == 2 { print $4 }')"
  case "$BOOTKB" in
    '' | *[!0-9]*) ;;
    *) [ "$BOOTKB" -lt 10240 ] && warn "only $((BOOTKB / 1024)) MB free on the boot partition - a kernel update cannot land." ;;
  esac
  MEMT="$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' "$PROC/meminfo" 2> /dev/null)"
  MEMA="$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' "$PROC/meminfo" 2> /dev/null)"
  echo "memory:       ${MEMA:-?} MB available of ${MEMT:-?} MB"
  TEMP="$(slurp "$SYS/class/thermal/thermal_zone0/temp")"
  case "$TEMP" in
    '' | *[!0-9]*) echo "temp:         unknown" ;;
    *) echo "temp:         $((TEMP / 1000)) C" ;;
  esac
  if command -v vcgencmd > /dev/null 2>&1; then
    THR="$(vcgencmd get_throttled 2> /dev/null | sed 's/.*=//')"
    echo "throttled:    ${THR:-unknown}"
    # Bit 0 is undervoltage NOW, bit 16 is "it happened since boot": either way the
    # power supply is the first thing to suspect, not the software.
    case "$THR" in
      0x0 | '') ;;
      *) warn "the firmware reports throttling ($THR) - suspect the power supply before anything else." ;;
    esac
  fi

  echo
  echo "== network =="
  if command -v ip > /dev/null 2>&1; then
    ip -o -4 addr show scope global 2>/dev/null | awk '{ print "addr:         " $2 " " $4 }'
    ip -o link show 2> /dev/null | awk -F': ' '{ split($3, s, " "); print "link:         " $2 " " s[1] }' | head -n 6
    R="$(ip -o -4 route show default 2> /dev/null | head -n1 | sed 's/[[:space:]]*$//')"
    # The boot-time run happens before DHCP has finished (this is ordered after
    # network.target, deliberately not network-online.target - waiting for the
    # network is exactly what a diagnostic must never do). Calling that a fault
    # would put a false alarm at the top of every boot report; the timer rewrites
    # the file two minutes in, by which time a real box has a route.
    if [ -n "$R" ]; then
      echo "route:        $R"
    elif [ "$UPSEC" -lt 120 ]; then
      echo "route:        none yet (the box is still starting)"
    else
      echo "route:        NO default route"
      warn "no default route - the box has no way off the LAN (no OTA updates, no streaming)."
    fi
  else
    echo "addr:         unknown (no ip command)"
  fi
  if command -v nmcli > /dev/null 2>&1; then
    # The connected network only, "<signal>:<ssid>" once the ACTIVE field is off.
    # Split on the FIRST colon and unescape afterwards: nmcli -t writes a ':' inside
    # a value as '\:', so splitting on every colon truncates any SSID that has one.
    # The signal is digits, so it can never contain the separator itself.
    WIFI="$(nmcli -t -f ACTIVE,SIGNAL,SSID device wifi 2> /dev/null | sed -n 's/^yes://p' | head -n1)"
    if [ -n "$WIFI" ]; then
      echo "wifi:         SSID \"$(printf '%s' "${WIFI#*:}" | sed 's/\\:/:/g')\" signal ${WIFI%%:*}%"
    fi
    echo "nm radio:     $(nmcli radio wifi 2> /dev/null || echo unknown)"
  fi
  NS="$(sed -n 's/^nameserver[[:space:]]*//p' "$ETC/resolv.conf" 2> /dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  echo "dns:          ${NS:-NONE configured}"

  echo
  echo "== ssh =="
  KEYS=0
  for k in "$ETC"/ssh/ssh_host_*_key; do
    [ -f "$k" ] && KEYS=$((KEYS + 1))
  done
  if [ "$KEYS" -gt 0 ]; then
    echo "host keys:    $KEYS present"
  else
    echo "host keys:    MISSING"
    # An image ships without host keys on purpose and generates them on the first
    # boot. When that write fails, sshd answers the TCP connection and closes it
    # with no banner, which reads like a network fault rather than a full disk.
    warn "no SSH host keys - sshd will accept connections and drop them with no banner. Usually a full or read-only root filesystem."
  fi
  echo "sshd:         $(unit_state ssh) / port 22 $(listening "$SSH_PORT_HEX" && echo listening || echo "not listening")"
  AK="$BOX_HOME/.ssh/authorized_keys"
  if [ -f "$AK" ]; then
    echo "authorized:   $(grep -c '^[^#]' "$AK" 2> /dev/null || echo 0) key(s) for ${BOX_USER:-the box user}"
  else
    echo "authorized:   none (no $AK)"
  fi

  echo
  echo "== boot config =="
  CMDLINE="$BOOT/cmdline.txt"
  if [ ! -f "$CMDLINE" ]; then
    echo "cmdline.txt:  MISSING"
    warn "$CMDLINE is missing - the box boots on the firmware's fallback kernel command line."
  elif [ ! -s "$CMDLINE" ]; then
    echo "cmdline.txt:  EMPTY (0 bytes)"
    warn "$CMDLINE is EMPTY - the box boots on the firmware's fallback command line, without the tvbox settings. Restore it from cmdline.txt.bak-tvbox or a FSCK*.REC file, or re-run provision.sh."
  else
    echo "cmdline.txt:  $(wc -c < "$CMDLINE" | tr -d ' ') bytes"
    grep -q 'root=' "$CMDLINE" || warn "$CMDLINE has no root= parameter."
    grep -q 'vc4.force_hotplug=1' "$CMDLINE" ||
      warn "vc4.force_hotplug=1 is not on the kernel command line - with the TV off, the session spins on a CPU core. Re-run provision.sh."
  fi
  # fsck.fat writes orphaned cluster chains here. One next to a truncated file is
  # that file's lost contents, so it is worth pointing at rather than ignoring.
  for r in "$BOOT"/FSCK*.REC; do
    [ -f "$r" ] || continue
    echo "recovered:    $(basename "$r") ($(wc -c < "$r" | tr -d ' ') bytes) - a FAT check moved lost data here"
    warn "$(basename "$r") exists on the boot partition: fsck.fat recovered a lost cluster chain. Something was truncated - compare it with cmdline.txt and config.txt."
  done
  CONF="$BOOT/tvbox.conf"
  if [ -f "$CONF" ]; then
    # Names and set/empty only: this file is world-readable and tvbox.conf holds
    # the WiFi PSK and the account password.
    printf 'tvbox.conf:  '
    for k in HOSTNAME WIFI_SSID WIFI_PASSWORD WIFI_COUNTRY SSH_AUTHORIZED_KEY PASSWORD SUDO SAFE_MODE; do
      V="$(conf_get "$CONF" "$k")"
      [ -n "$V" ] && printf ' %s=set' "$k"
    done
    echo
  else
    echo "tvbox.conf:   not present"
  fi

  echo
  echo "== failed units =="
  if command -v systemctl > /dev/null 2>&1; then
    F="$(systemctl list-units --state=failed --no-legend --plain 2> /dev/null | awk '{ print $1 }' | head -n 15)"
    if [ -n "$F" ]; then
      echo "$F" | sed 's/^/system:       /'
      warn "failed system units: $(echo "$F" | tr '\n' ' ')"
    else
      echo "system:       none"
    fi
    # The input bridges and the flatpak timer are USER units, so they are invisible
    # to a plain root systemctl - and a dead tvbox-cec is exactly the kind of
    # failure someone reads this file to find. Whether the question could be ASKED
    # is reported separately: "none" and "could not ask" are not the same answer,
    # and printing the first for the second would hide the bridges entirely.
    U=""
    UOK=no
    if [ -n "$BOX_USER" ] && command -v runuser > /dev/null 2>&1; then
      UID_N="$(id -u "$BOX_USER" 2> /dev/null)"
      if [ -n "$UID_N" ]; then
        # Take runuser's own exit status, NOT a pipeline's: a pipeline reports the
        # status of its LAST command, and `head` succeeds whether or not the query
        # upstream of it did - which would report "none" for every box that has no
        # user session, the exact case this distinction exists for.
        if RAW_U="$(runuser -u "$BOX_USER" -- env "XDG_RUNTIME_DIR=$RUN/user/$UID_N" \
          systemctl --user list-units --state=failed --no-legend --plain 2> /dev/null)"; then
          UOK=yes
          U="$(printf '%s\n' "$RAW_U" | awk 'NF { print $1 }' | head -n 15)"
        fi
      fi
    fi
    if [ -n "$U" ]; then
      echo "$U" | sed 's/^/user:         /'
      warn "failed user units: $(echo "$U" | tr '\n' ' ')"
    elif [ "$UOK" = yes ]; then
      echo "user:         none"
    else
      echo "user:         could not ask (no session for ${BOX_USER:-the box user}?)"
    fi
  else
    echo "(no systemctl)"
  fi
)"

WARN="$(printf '%s\n' "$RAW" | sed -n "s/^$WARN_MARK /WARNING: /p")"
BODY="$(printf '%s\n' "$RAW" | grep -v "^$WARN_MARK ")"
PROBLEMS="$(printf '%s\n' "$RAW" | grep -c "^$WARN_MARK " || true)"

VERDICT="nothing obviously wrong"
[ "${PROBLEMS:-0}" -gt 0 ] && VERDICT="$PROBLEMS problem(s) found, see the WARNING lines"

REPORT="tvbox diagnostics
Written by tvbox-diag at every boot and every 30 minutes. Overwritten each time.
verdict:      $VERDICT
${WARN:+$WARN
}
$BODY

== if the box will not start ==
1. Read the WARNING lines above; they are the whole point of this file.
2. tvbox-diag-logs.txt next to this file (written in safe mode) has the last
   boot's journal and the shell's own log.
3. SAFE MODE brings the box up with networking and SSH but no TV session, and
   prints this report on the TV. To ask for it, put an empty file named
   tvbox-safe-mode next to this one, or write SAFE_MODE=true into tvbox.conf.
   Delete it again to go back to normal. Three starts in a row that never reach
   the launcher engage it on their own for one boot.
4. SSH needs a key: SSH_AUTHORIZED_KEY=<your public key> in tvbox.conf, and
   SUDO=true if you need root there. Both apply at the next boot.
5. Nothing here needs this box to be working: tvbox.conf and the flag file are
   read at boot, from this partition, on any computer with a card reader."

# The short form is for a TV, read from a sofa. The Linux console on a 1360x768
# panel is 48 rows and the full report is longer, so printing all of it scrolls the
# verdict and the warnings off the top - the only part worth putting on a screen.
# Selected by label rather than by line count so the shape survives edits.
BRIEF="tvbox diagnostics, short form
verdict:      $VERDICT
${WARN:+$WARN
}
$(printf '%s\n' "$BODY" | grep -E '^(host|tvbox|written|failed boots|last boot|safe mode|greetd|shell|memory|addr|route|host keys|sshd|cmdline\.txt|system|user):|^/')

The whole report is on the boot partition as tvbox-diag.txt."

if [ "$MODE" = "brief" ]; then
  printf '%s\n' "$BRIEF"
elif [ "$MODE" = "stdout" ]; then
  printf '%s\n' "$REPORT"
else
  # Never truncate the previous report in place. A FAT file opened for writing and
  # left unflushed by a power cut loses its cluster chain and fsck zeroes it, so
  # the old report would be destroyed by the attempt to write a new one. Write a
  # temp file on the same filesystem, flush, then rename over the target.
  TMP="$BOOT/.tvbox-diag.tmp"
  if ! printf '%s\n' "$REPORT" > "$TMP" 2> /dev/null; then
    rm -f "$TMP" 2> /dev/null
    echo "tvbox-diag: cannot write $TMP (boot partition read-only or full?)" >&2
    exit 1
  fi
  sync
  if ! mv -f "$TMP" "$OUT" 2> /dev/null; then
    rm -f "$TMP" 2> /dev/null
    echo "tvbox-diag: cannot replace $OUT" >&2
    exit 1
  fi
  sync
fi

[ "$WANT_LOGS" = yes ] || exit 0

# The log dump is a separate file: it is big, it is only useful to someone who
# already read the report, and it must not push the report itself off a full
# partition. Each part is bounded.
{
  echo "tvbox logs, written $(date '+%Y-%m-%d %H:%M:%S %Z' 2> /dev/null)"
  echo
  echo "===== previous boot, last 200 lines ====="
  journalctl -b -1 -n 200 --no-pager 2> /dev/null || echo "(no previous boot in the journal - it may be volatile)"
  echo
  echo "===== this boot, errors only, last 200 lines ====="
  journalctl -b 0 -p err -n 200 --no-pager 2> /dev/null || echo "(unavailable)"
  echo
  echo "===== $TVBOX_DIR/shell.log, last 200 lines ====="
  # Truncated by run-shell.sh at every start, so this is the CURRENT session only.
  tail -n 200 "$TVBOX_DIR/shell.log" 2> /dev/null || echo "(no shell.log)"
} 2> /dev/null | head -c 262144 > "$BOOT/.tvbox-diag-logs.tmp" 2> /dev/null || {
  rm -f "$BOOT/.tvbox-diag-logs.tmp" 2> /dev/null
  echo "tvbox-diag: cannot write the log dump" >&2
  exit 1
}
sync
mv -f "$BOOT/.tvbox-diag-logs.tmp" "$LOGS" 2> /dev/null || rm -f "$BOOT/.tvbox-diag-logs.tmp" 2> /dev/null
sync
exit 0
