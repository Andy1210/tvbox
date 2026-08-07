#!/bin/bash -e
# stage-tvbox / 01-tvbox - put tvbox into the image. Mirrors what deploy.sh +
# provision.sh do over SSH, but into the pi-gen chroot (don't run provision.sh
# here - it's written for a live system: udevadm, loginctl, systemctl --now).
#
#   files/  is assembled by CI (.github/workflows/image.yml) or by hand for a
#           local build: shell/ WITH launcher-dist built + the deploy/ infra
#           files (run-shell.sh, tvbox CLI, CEC bridge, units, provision.sh).
#   conf/   committed system config - KEEP IN SYNC with deploy/provision.sh
#           (udev/polkit rules, unattended-upgrades: same content as its heredocs).
USER_HOME="/home/${FIRST_USER_NAME}"

# 1) the tvbox tree
install -d "${ROOTFS_DIR}${USER_HOME}/.tvbox"
cp -r files/shell "${ROOTFS_DIR}${USER_HOME}/.tvbox/"
# A fresh image starts with an EMPTY home - no apps installed. Apps are added
# from the registry via HOME -> "Get more apps" (the Kodi model).
# Infra files: files/ was assembled from deploy/infra.list by copy-infra.sh
# (build-image.sh locally, image.yml in CI) - install EVERYTHING in it rather
# than a hand-kept name list, so a new infra.list entry can't silently skip
# flashed images (the v1.1.0 drift class: dev deploy + OTA had the BT-remote
# bridge, the image didn't). Exec bits mirror the old explicit lines: the two
# direct executables + the python bridges/helpers 755, the rest (units,
# provision.sh, cec_vendor_shim.c source) 644.
for f in files/*; do
  [ -d "$f" ] && continue # shell/ - copied above
  case "$(basename "$f")" in
    *.sh | tvbox | *.py) mode=755 ;;
    *) mode=644 ;;
  esac
  install -m "$mode" "$f" "${ROOTFS_DIR}${USER_HOME}/.tvbox/"
done

# 2) device access + polkit + OS auto-updates (no auto-reboot) - see conf/
install -m 644 conf/99-tvbox.rules "${ROOTFS_DIR}/etc/udev/rules.d/"
install -m 644 conf/50-tvbox-networkmanager.rules conf/51-tvbox-locale.rules conf/50-tvbox-udisks.rules \
  "${ROOTFS_DIR}/etc/polkit-1/rules.d/"
install -m 644 conf/20auto-upgrades conf/52tvbox-unattended-upgrades "${ROOTFS_DIR}/etc/apt/apt.conf.d/"
# logind: a BT remote's Power button reaches the box as KEY_POWER; without this
# drop-in logind would power the whole box off (default HandlePowerKey=poweroff)
# before the remote bridge can act on it. Same content deploy/provision.sh
# writes - KEEP IN SYNC (conf/10-tvbox-logind.conf).
install -d "${ROOTFS_DIR}/etc/systemd/logind.conf.d"
install -m 644 conf/10-tvbox-logind.conf "${ROOTFS_DIR}/etc/systemd/logind.conf.d/10-tvbox.conf"

# 2b) WiFi usable on a fresh boot with NO ethernet and NO keyboard. This image
#     has no first-boot config hook (custom.toml is NOT processed - see
#     docs/sd-image.md), so a WiFi-only box can't be preseeded and can't
#     self-heal over OTA (no network yet) - it must come up WiFi-ready.
#     The real blocker (confirmed on a real flash) is that Raspberry Pi OS ships
#     NetworkManager with the WiFi RADIO OFF (WirelessEnabled=false); a plain
#     `rfkill unblock` does NOT flip that, so nmcli never scans. And the Pi's
#     brcmfmac is a self-managed regulatory device that ignores the cmdline
#     regdom - the country has to be set the way the driver honours it. So do
#     exactly what raspi-config/Imager do:
#       - persist WirelessEnabled=true in NetworkManager.state (radio on at boot),
#       - set the regdom on the cmdline (belt for non-self-managed adapters),
#       - and at boot run Raspberry Pi's own `do_wifi_country` (country + nmcli
#         radio on + rfkill unblock + rfkill state), self-healing every boot.
#     Then the owner just picks a network from the TV (Settings → Network).
#     Note WHY the radio-off blocker exists: pi-gen writes WirelessEnabled=false
#     only as the `elif` of `[ -v WPA_COUNTRY ]` (stage2/02-net-tweaks/01-run.sh),
#     so with WPA_COUNTRY set in image/config that branch is skipped and stage2
#     applies the country itself. The steps above are kept anyway - they are what
#     re-applies the OWNER's choice on every boot, which a build-time value cannot.
#     The region is settable at three levels, weakest first: WPA_COUNTRY in
#     image/config (build), WIFI_COUNTRY= in the boot partition's tvbox.conf (flash,
#     per box), and Settings → Wi-Fi → Wi-Fi country on the TV, which persists to
#     ~/.tvbox/config.json and wins. WPA_COUNTRY is read here rather than a tvbox
#     variable of our own because pi-gen EXPORTS it: this script is run as a child
#     process (`./00-run.sh`), so it only ever sees exported variables, and pi-gen
#     exports just its own documented set.
WIFI_COUNTRY="${WPA_COUNTRY:-HU}"
# Exactly two ASCII letters or fall back - this value is interpolated BOTH into
# cmdline.txt (where a space would smuggle in extra kernel parameters) and into
# the root applier generated below (where an unquoted heredoc would let shell
# metacharacters run at boot). Reject rather than repair: stripping junk out of
# "D1E" would silently pick DE, and a wrong regulatory region is the exact fault
# this is meant to prevent.
case "$WIFI_COUNTRY" in
  [A-Za-z][A-Za-z]) WIFI_COUNTRY=$(printf '%s' "$WIFI_COUNTRY" | tr '[:lower:]' '[:upper:]') ;;
  *) WIFI_COUNTRY=HU ;;
esac
CMDLINE="${ROOTFS_DIR}/boot/firmware/cmdline.txt"
[ -f "$CMDLINE" ] || CMDLINE="${ROOTFS_DIR}/boot/cmdline.txt"
if [ -f "$CMDLINE" ] && ! grep -q ieee80211_regdom "$CMDLINE"; then
  # cmdline.txt must stay a single space-separated line - append to line 1 only
  sed -i "1s|\$| cfg80211.ieee80211_regdom=${WIFI_COUNTRY}|" "$CMDLINE"
fi
# Always give the compositor an output, even with the TV off or unplugged.
# A session with zero outputs has nothing to pace it: measured on a Pi 5, one
# started with no sink burns ~65% of a core in the compositor alone and ~200%
# once Electron joins in (its main thread does ~35k Wayland roundtrips/s), which
# is what a box plugged in while the TV is off used to sit at until the TV came
# on. force_hotplug makes vc4 ignore HPD so an output always exists.
# NOTE: this is `vc4.force_hotplug=1`, NOT `video=HDMI-A-1:e` - the latter is
# what kills CEC on kernels 6.14-6.18 (see the sharp edge in CLAUDE.md).
# Verified on an LG set: CEC keeps a real physical address (2.0.0.0) with this on.
# Normalise EVERY `vc4.force_hotplug` occurrence to =1: a `=0` inherited from a
# base image must be corrected rather than read as "already set", and with two
# occurrences the kernel honours the LAST one. KEEP IN SYNC with provision.sh.
if [ -f "$CMDLINE" ]; then
  CUR=$(cat "$CMDLINE")
  WANT=$(printf '%s' "$CUR" | sed -E 's/(^| )vc4\.force_hotplug=[^ ]*/\1vc4.force_hotplug=1/g')
  case "$WANT" in *vc4.force_hotplug=1*) ;; *) WANT="$WANT vc4.force_hotplug=1" ;; esac
  [ "$WANT" = "$CUR" ] || printf '%s\n' "$WANT" > "$CMDLINE"
fi

# NM ships the WiFi radio off - turn it on persistently so the very first boot
# scans (before/without the boot service even running).
NMSTATE="${ROOTFS_DIR}/var/lib/NetworkManager/NetworkManager.state"
if [ -f "$NMSTATE" ] && grep -q '^WirelessEnabled=' "$NMSTATE"; then
  sed -i 's/^WirelessEnabled=.*/WirelessEnabled=true/' "$NMSTATE"
fi
# WiFi power saving off. NM defaults it ON and the Pi's brcmfmac honours it hard:
# with PSM on, rate control collapses to the 802.11b floor even at a -54 dBm
# signal. Measured on a Pi 5 at 2.4GHz/HT20, same AP, PSM on -> off: TX rate
# 5.5-7.2 -> 72.2 Mbit/s, a 30MB transfer >120s -> 10.6s, LAN ping avg/max
# 18.7/209 -> 5.2/29.5 ms, 6.7% -> 0% loss. It matters twice on a Pi: WiFi and
# Bluetooth share one antenna, so airtime wasted on retries is airtime a
# gamepad's HID reports don't get. A drop-in, not a per-connection value, so it
# also covers networks added later. KEEP IN SYNC with deploy/provision.sh.
install -d "${ROOTFS_DIR}/etc/NetworkManager/conf.d"
cat > "${ROOTFS_DIR}/etc/NetworkManager/conf.d/10-tvbox-wifi.conf" <<'NMCONF'
# tvbox: never power-save the WiFi radio (2 = disable). See deploy/provision.sh.
[connection]
wifi.powersave=2
NMCONF
# Root-side country apply, weakest source last: the Settings pick (shell config,
# rootless) wins, then whatever is ALREADY set, then the image default. Falling
# back to what is already set is what keeps this from stomping a country chosen
# some other way - `WIFI_COUNTRY=` in tvbox.conf is applied by tvbox-firstboot,
# and running unconditionally with the image default would undo it every boot.
# A separate script because systemd ExecStart would need $$-escaping for the
# shell substitutions.
cat > "${ROOTFS_DIR}/usr/local/sbin/tvbox-wifi-country" <<EOF
#!/bin/sh
# tvbox: apply the Wi-Fi regulatory country (root - do_wifi_country needs it).
CC=\$(sed -n 's/.*"country"[[:space:]]*:[[:space:]]*"\([A-Za-z][A-Za-z]\)".*/\1/p' /home/${FIRST_USER_NAME}/.tvbox/config.json 2>/dev/null | head -n1)
[ -n "\$CC" ] || CC=\$(/usr/bin/raspi-config nonint get_wifi_country 2>/dev/null | tr -cd 'A-Za-z' | cut -c1-2)
exec /usr/bin/raspi-config nonint do_wifi_country "\${CC:-${WIFI_COUNTRY}}"
EOF
chmod 755 "${ROOTFS_DIR}/usr/local/sbin/tvbox-wifi-country"

cat > "${ROOTFS_DIR}/etc/systemd/system/tvbox-wifi-unblock.service" <<'EOF'
[Unit]
Description=tvbox: enable + localise WiFi on a fresh box (radio on, country set, rfkill cleared)
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
# `-` prefixes: a failing step must not block the others. do_wifi_country is
# Raspberry Pi's own routine (sets the driver-honoured country + `nmcli radio
# wifi on` when NM is active + clears rfkill); the retry loop is a belt for the
# case where NM isn't "active" yet when the unit runs.
ExecStart=-/usr/sbin/rfkill unblock wifi
ExecStart=-/usr/local/sbin/tvbox-wifi-country
ExecStart=-/bin/sh -c 'for i in 1 2 3 4 5; do nmcli radio wifi on && exit 0; sleep 2; done; exit 0'
# do_wifi_country rewrites /boot/firmware/cmdline.txt with an unconditional sed -i,
# so this unit rewrites the kernel command line on the FAT partition at EVERY boot.
# On vfat a rename can reach the disk before the data it points at, and a box cut
# off before writeback then boots with a zero-byte cmdline.txt - seen on a real box,
# with the lost text orphaned into a FSCK*.REC. Flushing straight away shrinks that
# window to milliseconds. KEEP IN SYNC with deploy/provision.sh.
ExecStartPost=-/bin/sync

[Install]
WantedBy=multi-user.target
EOF
install -d "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants"
ln -sf ../tvbox-wifi-unblock.service \
  "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/tvbox-wifi-unblock.service"

# 2b-ii) Bluetooth ERTM toggle. Off by default (the kernel default, ERTM on). It
#     exists because some gamepads - Xbox ones especially - handle L2CAP Enhanced
#     Retransmission Mode badly and drop or repeat HID reports; a lost button-
#     RELEASE report reads as a stuck button. NOT on unconditionally: ERTM is the
#     layer's own error recovery and disabling it is global, so it can make other
#     links (audio) worse. KEEP IN SYNC with deploy/provision.sh.
cat > "${ROOTFS_DIR}/usr/local/sbin/tvbox-bt-ertm" <<EOF
#!/bin/sh
# tvbox: apply the Bluetooth ERTM setting (root - modprobe.d + live module param).
ON=\$(sed -n 's/.*"disableErtm"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' /home/${FIRST_USER_NAME}/.tvbox/config.json 2>/dev/null | head -n1)
[ "\$ON" = "true" ] && V=1 || V=0
# For the next boot: the bluetooth module is loaded long before this unit runs.
printf 'options bluetooth disable_ertm=%s\n' "\$V" > /etc/modprobe.d/tvbox-bluetooth.conf
# And live, so starting this unit by hand applies to links made from now on
# (the parameter is only consulted when an L2CAP connection is set up).
P=/sys/module/bluetooth/parameters/disable_ertm
[ -w "\$P" ] && printf '%s\n' "\$V" > "\$P"
exit 0
EOF
chmod 755 "${ROOTFS_DIR}/usr/local/sbin/tvbox-bt-ertm"

cat > "${ROOTFS_DIR}/etc/systemd/system/tvbox-bt-ertm.service" <<'EOF'
[Unit]
Description=tvbox: apply the Bluetooth ERTM setting picked in Settings
After=bluetooth.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=-/usr/local/sbin/tvbox-bt-ertm

[Install]
WantedBy=multi-user.target
EOF
ln -sf ../tvbox-bt-ertm.service \
  "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/tvbox-bt-ertm.service"

# 2b-iii) Grow the rootfs to fill the card on the first boot. THIS IMAGE CANNOT
#     SHIP WITHOUT IT. pi-gen sizes the root partition to the stage's own contents
#     plus ROOT_SIZE * 0.2 + 200 MB, and the init= hook that normally expands it on
#     first boot is not installed here - DISABLE_FIRST_BOOT_USER_RENAME=1 makes
#     pi-gen skip it (see docs/sd-image.md). Measured on the v1.18.0 image: a
#     3.49 GiB rootfs with 0.34 GiB free, half of that reserved for root, so 174 MB
#     for everything else, on any size card, forever.
#     What that actually did on a fresh flash: the box filled up on its first boot
#     and ext4 aborted the filesystem ("failed to convert unwritten extents to
#     written extents", remount read-only) - and the damage read like three
#     unrelated bugs. ssh-keygen could not write the host keys pi-gen deletes on
#     purpose, so sshd accepted TCP and closed with no banner; the shell could not
#     write, so it crash-looped behind a black screen with the SD LED going
#     constantly; and the box was unreachable by any route at once.
#     Idempotent, so it also grows a rootfs later moved to a bigger card.
cat > "${ROOTFS_DIR}/usr/local/sbin/tvbox-expand-rootfs" <<'XSEOF'
#!/bin/sh
# tvbox: grow the root partition + filesystem to fill the card. Idempotent - it
# runs at every boot and does nothing once there is no spare tail worth taking.
PART=$(findmnt -no SOURCE / 2>/dev/null) || exit 0
case "$PART" in /dev/*) ;; *) exit 0 ;; esac       # not a plain block device
NAME=$(basename "$PART")
NUM=$(printf '%s' "$NAME" | grep -o '[0-9]*$')
[ -n "$NUM" ] || exit 0
PK=$(lsblk -no pkname "$PART" 2>/dev/null | head -n1)
[ -n "$PK" ] || exit 0
DISK="/dev/$PK"
[ -b "$DISK" ] || exit 0
# Refuse unless root is the LAST partition - growing any other would run into its
# neighbour.
if [ "$(lsblk -lno NAME "$DISK" | tail -n1)" != "$NAME" ]; then
  echo "tvbox-expand-rootfs: $PART is not the last partition on $DISK - leaving it alone"
  exit 0
fi
DISK_SZ=$(blockdev --getsz "$DISK" 2>/dev/null) || exit 0
START=$(cat "/sys/class/block/$NAME/start" 2>/dev/null) || exit 0
PART_SZ=$(blockdev --getsz "$PART" 2>/dev/null) || exit 0
SPARE=$((DISK_SZ - START - PART_SZ))
# 64 MiB in 512-byte sectors: below that it is already grown, which is what makes
# this safe to run unconditionally.
[ "$SPARE" -ge 131072 ] || exit 0
echo "tvbox-expand-rootfs: growing $PART by $((SPARE / 2048)) MiB to fill $DISK"
# sfdisk rewrites only the last partition's size and keeps its start sector; the
# kernel cannot re-read the table while root is mounted, hence partx -u.
if ! echo ", +" | sfdisk -N "$NUM" --force "$DISK"; then
  echo "tvbox-expand-rootfs: sfdisk failed - filesystem left untouched" >&2
  exit 0
fi
partx -u "$DISK" 2>/dev/null || true
# ext4 grows online, so the mounted root needs neither a reboot nor an fsck.
if resize2fs "$PART"; then
  echo "tvbox-expand-rootfs: done - $(df -h / | awk 'NR==2{print $4" free of "$2}')"
else
  echo "tvbox-expand-rootfs: resize2fs failed - the partition grew, the fs did not" >&2
fi
exit 0
XSEOF
chmod 755 "${ROOTFS_DIR}/usr/local/sbin/tvbox-expand-rootfs"

cat > "${ROOTFS_DIR}/etc/systemd/system/tvbox-expand-rootfs.service" <<'EOF'
[Unit]
Description=tvbox: grow the root filesystem to fill the card
# Same shape as Raspberry Pi's own regenerate_ssh_host_keys.service: very early,
# root already read-write, and BEFORE everything that needs somewhere to write -
# including the host-key generation whose failure is how this bug first showed up.
#
# Before=systemd-growfs-root.service is the load-bearing one. The base image DOES
# ship a first-boot resize - rpi-resize.service - but it is a shim: ExecStart is
# /usr/bin/true and the work is delegated to systemd-growfs-root, which grows the
# FILESYSTEM to fit its partition and never touches the partition table. Growing
# the partition is the job of the init= firstboot hook, which pi-gen does not
# install when DISABLE_FIRST_BOOT_USER_RENAME=1 - so growfs expands a 3.6 GB
# filesystem to fill a 3.6 GB partition and achieves nothing. Ordering ahead of it
# makes the two cooperate: we widen the partition, growfs then has real room to
# grow into (our own resize2fs stays as a belt for when growfs is not pulled in).
DefaultDependencies=no
After=systemd-remount-fs.service
Before=systemd-growfs-root.service tvbox-firstboot.service ssh.service sshd-keygen.service regenerate_ssh_host_keys.service
Conflicts=shutdown.target
Before=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/tvbox-expand-rootfs

[Install]
WantedBy=sysinit.target
EOF
install -d "${ROOTFS_DIR}/etc/systemd/system/sysinit.target.wants"
ln -sf ../tvbox-expand-rootfs.service \
  "${ROOTFS_DIR}/etc/systemd/system/sysinit.target.wants/tvbox-expand-rootfs.service"

# 2b-iv) Out-of-band diagnostics + safe mode. A flashed box is exactly the case
#     these exist for: no SSH key until tvbox.conf is read, no screen until the
#     session starts, and nothing to ask if the first boot goes wrong. tvbox-diag
#     writes a plain-text report onto THIS partition, which the firmware, the box
#     and any laptop can all read; tvbox-safemode brings the box up with networking
#     and sshd but no session, either on request (tvbox-safe-mode / SAFE_MODE=true
#     here on the boot partition) or after three starts that never reach the
#     launcher. Both are shipped as real files via deploy/infra.list and installed
#     from ~/.tvbox/ - same files deploy/provision.sh installs, so there is no
#     second copy of the logic to keep in sync, and CI unit-tests them.
install -m 755 "${ROOTFS_DIR}${USER_HOME}/.tvbox/tvbox-diag.sh" "${ROOTFS_DIR}/usr/local/sbin/tvbox-diag"
install -m 755 "${ROOTFS_DIR}${USER_HOME}/.tvbox/tvbox-safemode.sh" "${ROOTFS_DIR}/usr/local/sbin/tvbox-safemode"
for u in tvbox-diag.service tvbox-diag.timer tvbox-safemode.service tvbox-safemode-screen.service; do
  install -m 644 "${ROOTFS_DIR}${USER_HOME}/.tvbox/$u" "${ROOTFS_DIR}/etc/systemd/system/$u"
done
install -d "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants"
ln -sf ../tvbox-safemode.service \
  "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/tvbox-safemode.service"
ln -sf ../tvbox-safemode-screen.service \
  "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/tvbox-safemode-screen.service"
ln -sf ../tvbox-diag.service \
  "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/tvbox-diag.service"
install -d "${ROOTFS_DIR}/etc/systemd/system/timers.target.wants"
ln -sf ../tvbox-diag.timer \
  "${ROOTFS_DIR}/etc/systemd/system/timers.target.wants/tvbox-diag.timer"
# Safe mode on the session side: one condition on greetd, as a drop-in so a greetd
# package update cannot undo it.
install -d "${ROOTFS_DIR}/etc/systemd/system/greetd.service.d"
install -m 644 "${ROOTFS_DIR}${USER_HOME}/.tvbox/greetd-tvbox-safemode.conf" \
  "${ROOTFS_DIR}/etc/systemd/system/greetd.service.d/10-tvbox-safemode.conf"
# The ceiling on how long a crashing app's core dump may hold the box. Root, like
# the unit it patches; session.sh carries the user-space half.
install -d "${ROOTFS_DIR}/etc/systemd/system/systemd-coredump@.service.d"
install -m 644 "${ROOTFS_DIR}${USER_HOME}/.tvbox/coredump-tvbox-runtimemax.conf" \
  "${ROOTFS_DIR}/etc/systemd/system/systemd-coredump@.service.d/10-tvbox-runtime-max.conf"

# 2c) Headless provisioning WITHOUT custom.toml (which this image can't process).
#     The account password is locked, so there's no way into a fresh box until
#     an SSH key is present. First-boot config is driven by ONE file on the boot
#     (FAT) partition - tvbox.conf (KEY=value, editable on any OS; there's a
#     click-together generator under docs/config/) - applied every boot by
#     tvbox-firstboot:
#       HOSTNAME=  WIFI_SSID=/WIFI_PASSWORD=  WIFI_COUNTRY=  SUDO=true  PASSWORD=
#       SSH_AUTHORIZED_KEY=
#     SAFE_MODE=true in the same file is read by tvbox-safemode (2b-iv), not here.
#     Legacy standalone files (authorized_keys, tvbox-wifi.conf) still work.
#     Runs every boot, idempotent; the config may stay on the card.

# Default hostname: RPi OS Lite ships "raspberrypi"; several boxes would collide
# on the LAN. Ship "tvbox"; tvbox-firstboot overrides it per box from tvbox.conf.
echo "tvbox" > "${ROOTFS_DIR}/etc/hostname"
if grep -q '^127.0.1.1' "${ROOTFS_DIR}/etc/hosts" 2>/dev/null; then
  sed -i 's/^127.0.1.1.*/127.0.1.1\ttvbox/' "${ROOTFS_DIR}/etc/hosts"
else
  printf '127.0.1.1\ttvbox\n' >> "${ROOTFS_DIR}/etc/hosts"
fi

cat > "${ROOTFS_DIR}/usr/local/sbin/tvbox-firstboot" <<'FIRSTBOOT'
#!/bin/sh
# tvbox headless provisioning from the boot partition (see stage-tvbox 00-run.sh).
# Everything is driven by ONE optional file: tvbox.conf (KEY=value, '#' comments),
# dropped on the boot (FAT) partition, editable on any OS. Runs every boot,
# idempotent. The legacy single-purpose files (authorized_keys, tvbox-wifi.conf,
# tvbox-sudo) are still honoured as fallbacks.
BOOT=/boot/firmware
[ -d "$BOOT" ] || BOOT=/boot
CONF="$BOOT/tvbox.conf"

# Read one KEY from tvbox.conf: everything after the first '=' on the first
# matching line, CR stripped. NOT sourced - a value may contain spaces, '#',
# '$', '/' etc. (e.g. a WiFi password or an SSH key) with no quoting and no code
# execution.
conf_get() { [ -f "$CONF" ] && sed -n "s/^$1=//p" "$CONF" | head -n1 | tr -d '\r'; }

# --- SSH: authorised key for the (locked-by-default) tv account ---
KEY=$(conf_get SSH_AUTHORIZED_KEY)
if [ -n "$KEY" ]; then
  install -d -m 700 -o tv -g tv /home/tv/.ssh
  printf '%s\n' "$KEY" > /home/tv/.ssh/authorized_keys
  chown tv:tv /home/tv/.ssh/authorized_keys && chmod 600 /home/tv/.ssh/authorized_keys
elif [ -f "$BOOT/authorized_keys" ]; then          # legacy standalone file (allows many keys)
  install -d -m 700 -o tv -g tv /home/tv/.ssh
  install -m 600 -o tv -g tv "$BOOT/authorized_keys" /home/tv/.ssh/authorized_keys
fi

# --- Account password (optional): unlock tv for password login (console/SSH).
# Absent = the account stays locked (key-only). Set-only: removing it later does
# NOT re-lock (we never surprise-lock a box). ---
PASSWORD=$(conf_get PASSWORD)
if [ -n "$PASSWORD" ]; then
  printf 'tv:%s\n' "$PASSWORD" | chpasswd 2>/dev/null && passwd -u tv >/dev/null 2>&1
fi

# --- Power-user sudo: SUDO=true grants the tv account passwordless sudo (for an
# SSH admin). Default (absent/false) = no sudo at all, a hardened kiosk. NOPASSWD
# is the only option when the account is locked (mirrors Raspberry Pi OS's
# 010_pi-nopasswd); the tvbox shell stays rootless regardless (hard rule #1) -
# this is a human affordance only. Toggles both ways every boot. ---
SUDO=$(conf_get SUDO)
SUDOERS=/etc/sudoers.d/010-tvbox
if [ "$SUDO" = "true" ] || [ "$SUDO" = "1" ] || [ "$SUDO" = "yes" ] || [ -f "$BOOT/tvbox-sudo" ]; then
  printf 'tv ALL=(ALL) NOPASSWD: ALL\n' > "$SUDOERS.tmp"
  if visudo -cf "$SUDOERS.tmp" >/dev/null 2>&1; then
    chmod 440 "$SUDOERS.tmp" && mv "$SUDOERS.tmp" "$SUDOERS"
  else
    rm -f "$SUDOERS.tmp"
  fi
elif [ -f "$SUDOERS" ]; then
  rm -f "$SUDOERS"
fi

# --- Hostname: name this box (several would otherwise all be "tvbox" and clash
# on the LAN). Sanitised to a valid label; applied only on a real change. ---
NAME=$(conf_get HOSTNAME | tr -cd 'A-Za-z0-9-' | cut -c1-63 | sed 's/^-*//; s/-*$//')
if [ -n "$NAME" ] && [ "$NAME" != "$(cat /etc/hostname 2>/dev/null)" ]; then
  hostnamectl set-hostname "$NAME" 2>/dev/null || { printf '%s\n' "$NAME" > /etc/hostname; hostname "$NAME"; }
  if grep -q '^127.0.1.1' /etc/hosts 2>/dev/null; then
    sed -i "s/^127.0.1.1.*/127.0.1.1\t$NAME/" /etc/hosts
  else
    printf '127.0.1.1\t%s\n' "$NAME" >> /etc/hosts
  fi
fi

# --- WiFi regulatory country: WIFI_COUNTRY=DE in tvbox.conf. The radio will not
# transmit on a channel its regulatory domain does not allow, so a box flashed
# for another region has to be able to say so BEFORE it ever associates - which
# is why this is here and not only in Settings. Precedence, weakest first:
# the image's build-time bootstrap default, then this, then the Settings pick
# (~/.tvbox/config.json, applied by tvbox-wifi-country at every boot). ---
# Rejected, not repaired: filtering junk out of "D1E" would hand back DE, and
# quietly picking a DIFFERENT valid region is worse than ignoring the typo.
CC=$(conf_get WIFI_COUNTRY | tr -d '[:space:]')
case "$CC" in
  [A-Za-z][A-Za-z]) CC=$(printf '%s' "$CC" | tr '[:lower:]' '[:upper:]') ;;
  *) CC= ;;
esac
if [ -n "$CC" ] && command -v raspi-config >/dev/null 2>&1; then
  # do_wifi_country also validates against iso3166.tab and returns 1 on a code
  # that is well-formed but not a real country, leaving the setting alone.
  raspi-config nonint do_wifi_country "$CC" >/dev/null 2>&1 || true
fi

# --- WiFi: auto-connect for an ethernet-less box (else set it up from the TV:
# Settings -> Network). From tvbox.conf WIFI_SSID/WIFI_PASSWORD, or the legacy
# tvbox-wifi.conf (SSID=/PSK=). Written once; edit/remove the NM file to change. ---
SSID=$(conf_get WIFI_SSID)
PSK=$(conf_get WIFI_PASSWORD)
if [ -z "$SSID" ] && [ -f "$BOOT/tvbox-wifi.conf" ]; then
  SSID=; PSK=
  . "$BOOT/tvbox-wifi.conf" 2>/dev/null || true    # legacy: sources SSID=/PSK=
fi
KF=/etc/NetworkManager/system-connections/tvbox-preseed.nmconnection
if [ -n "$SSID" ] && [ ! -f "$KF" ]; then
  if [ -n "$PSK" ]; then SEC="[wifi-security]
key-mgmt=wpa-psk
psk=$PSK"; else SEC=""; fi
  cat > "$KF" <<EOF2
[connection]
id=tvbox-preseed
type=wifi
autoconnect=true
[wifi]
mode=infrastructure
ssid=$SSID
$SEC
[ipv4]
method=auto
[ipv6]
method=auto
EOF2
  chmod 600 "$KF"
  nmcli con reload 2>/dev/null || true
fi

# --- Secret hygiene: once PASSWORD / WIFI_PASSWORD have been CONSUMED above,
# blank ONLY those two value lines in tvbox.conf so the plaintext secrets don't
# linger indefinitely on the FAT boot partition (world/tv-readable, so any app
# plugin can read them). Everything else (HOSTNAME, SUDO, WIFI_SSID,
# SSH_AUTHORIZED_KEY) is preserved, so the documented "the config may stay on
# the card" re-run behaviour is unchanged: PASSWORD is set-only (already applied
# via chpasswd; a blank value just no-ops next boot) and WIFI_PASSWORD is only
# blanked once the NM keyfile exists (the WiFi block above is write-once and
# no-ops while $KF is present), so we never strip a PSK that was not actually
# written into a connection. Atomic rewrite via a temp file on the same
# partition; any failure leaves the original untouched. ---
SCRUB_WIFI=""
[ -f "$KF" ] && SCRUB_WIFI="s/^WIFI_PASSWORD=.*/WIFI_PASSWORD=/"
if [ -f "$CONF" ] && grep -Eq '^(PASSWORD|WIFI_PASSWORD)=.' "$CONF"; then
  TMP="$CONF.tvbox-scrub.$$"
  if sed "s/^PASSWORD=.*/PASSWORD=/; $SCRUB_WIFI" "$CONF" > "$TMP" 2>/dev/null && [ -s "$TMP" ]; then
    mv -f "$TMP" "$CONF"
  else
    rm -f "$TMP"
  fi
fi
FIRSTBOOT
chmod 755 "${ROOTFS_DIR}/usr/local/sbin/tvbox-firstboot"
cat > "${ROOTFS_DIR}/etc/systemd/system/tvbox-firstboot.service" <<'EOF'
[Unit]
Description=tvbox: headless provisioning from the boot partition (SSH key, WiFi)
After=NetworkManager.service tvbox-wifi-unblock.service
Wants=NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/tvbox-firstboot

[Install]
WantedBy=multi-user.target
EOF
ln -sf ../tvbox-firstboot.service \
  "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/tvbox-firstboot.service"

# 2d) Default keyboard layout = US (Raspberry Pi OS Lite defaults to gb). Written
#     to /etc/default/keyboard, which the session + the console read at login; the setup
#     wizard / Settings can change it later (localectl set-x11-keymap via the
#     locale1 polkit grant above).
cat > "${ROOTFS_DIR}/etc/default/keyboard" <<'EOF'
XKBMODEL="pc105"
XKBLAYOUT="us"
XKBVARIANT=""
XKBOPTIONS=""
BACKSPACE="guess"
EOF

# 3) boot straight into the compositor as the box user (greetd autologin, kiosk -
#    no desktop, no login prompt; the account password can stay locked). greetd
#    starts tvbox-wc, which starts the session (tvbox-session -> session.sh).
install -d "${ROOTFS_DIR}/etc/greetd"
cat > "${ROOTFS_DIR}/etc/greetd/config.toml" <<EOF
[terminal]
vt = 7

[default_session]
command = "tvbox-wc -- /usr/local/bin/tvbox-session"
user = "${FIRST_USER_NAME}"
EOF

# 4) user lingering so the CEC bridge user unit starts at boot (loginctl
#    enable-linger can't run in a chroot - the flag file is its whole effect)
install -d "${ROOTFS_DIR}/var/lib/systemd/linger"
touch "${ROOTFS_DIR}/var/lib/systemd/linger/${FIRST_USER_NAME}"

on_chroot <<CHROOT
set -e
# plugdev carries the udisks polkit grant (mounting a USB stick). It is not a
# group every base image has, and usermod on a missing one would end the build.
getent group plugdev >/dev/null || groupadd plugdev
usermod -aG input,video,netdev,plugdev ${FIRST_USER_NAME}
chown -R ${FIRST_USER_NAME}:${FIRST_USER_NAME} ${USER_HOME}/.tvbox

# libcec >= 8: gives cec-client --vendor-id, so the CEC bridge does not need the
# LD_PRELOAD vendor shim for LG SIMPLINK. No distro packages 8.x yet, so it is
# built from source (pinned commit) - here rather than in provision.sh's path,
# because a flashed box never runs provision. Slow under qemu but it is the only
# channel that can add a system library. Non-fatal: a box without it just keeps
# using the shim.
sh ${USER_HOME}/.tvbox/install-libcec8.sh || echo "WARN: libcec 8 build failed - the CEC bridge will use the vendor shim"

# The base image is Raspberry Pi OS Lite, so it should carry no compositor at all -
# but a Lite that ever gained one, or a stage that pulls one in as a dependency,
# would leave the box with two and greetd able to start either. Belt: purge them
# by name. Harmless when they were never there.
apt-get purge -y -qq labwc wlrctl wlr-randr kanshi swaybg grim >/dev/null 2>&1 || true
apt-get autoremove -y --purge -qq >/dev/null 2>&1 || true
rm -rf /etc/xdg/labwc

# The compositor. A general one composites the whole screen into a single buffer,
# which at 4K is a GPU pass the Pi cannot afford next to the player's own; tvbox-wc
# puts the film on a display plane and the shell's translucent UI on an overlay
# above it. Same reasoning as libcec above: a flashed box never runs provision, and
# only this channel can install under /usr/local.
#
# FATAL on purpose. There is no fallback compositor any more, so an image that
# cannot install this one boots to nothing.
install -m 755 ${USER_HOME}/.tvbox/tvbox-session /usr/local/bin/tvbox-session
sh ${USER_HOME}/.tvbox/install-compositor.sh

# NB: librespot (Spotify Connect) is NOT preinstalled - it's a per-app
# requires.download binary the Spotify app installs from the UI, no root
# (Kodi binary-addon style). NOTE: this on_chroot heredoc is UNQUOTED so the
# FIRST_USER_NAME / USER_HOME variables expand at build time - keep backticks
# and command substitution OUT of these comments, or the build shell runs them.
# No markdown-style backtick quoting in ANY comment down to the CHROOT
# terminator - not even around the word backtick, as this line demonstrates.
# The symptom is misleading: the build shell attributes the failure to the line
# the heredoc OPENS on, so you get "00-run.sh: line <opener>: foo: command not
# found" for a command that appears nowhere near it.
# The image only ships the shared media stack it
# needs: mpv + the runtime libs libpulse0/libasound2 (via 00-packages), like
# Kodi's core provides ffmpeg/system libs while addons ship their own binaries.

# The random build-time FIRST_USER_PASS (see image/config) must never ship
# usable: lock the account. greetd autologin doesn't authenticate, and a
# Raspberry Pi Imager password preseed (userconf) replaces the hash anyway.
passwd -l ${FIRST_USER_NAME}

# Electron npm install INSIDE the arm64 chroot - a host-side install would
# fetch the x86_64 Electron binary. Slowest custom step (~200 MB download).
# npm ci (not npm install) for a reproducible tree: shell/ ships a committed
# package-lock.json and node_modules is excluded from the copied tree, so ci
# installs exactly the locked versions.
# The npm WARN EBADENGINE lines this prints are expected and not a failure:
# trixie packages node 20, Electron 43 asks for >= 22.12 in its own engines
# field, and npm warns but installs. It is advisory for Electron's install
# tooling - the shell itself runs on the Node that Electron BUNDLES (22.x), and
# only the tvbox CLI (shell/cli.js, "#!/usr/bin/env node") uses the system one.
su - ${FIRST_USER_NAME} -c 'cd ~/.tvbox/shell && npm ci --no-audit --no-fund'
# Electron 43 has no postinstall hook any more - the binary download moved to
# its own install-electron bin - so npm ci alone leaves node_modules/electron
# with no dist/. electron's index.js would then fetch it at the FIRST LAUNCH
# instead: a silent ~110 MB download on a freshly flashed box that may not have
# a network yet, inside the window the shell's boot watchdog counts. This is
# that download, done where a failure stops the build; it exits 0 when the
# binary is already in place.
# (No backticks in this comment - see the heredoc note above.)
su - ${FIRST_USER_NAME} -c 'cd ~/.tvbox/shell && node node_modules/electron/install.js'

# tvbox CLI on PATH
su - ${FIRST_USER_NAME} -c 'mkdir -p ~/.local/bin && ln -sf ~/.tvbox/tvbox ~/.local/bin/tvbox'

# user units: systemctl --user can't run in a chroot - "enable" by creating
# the WantedBy symlinks directly (CEC bridge + remote-input bridge + gamepad shim
# + nightly flatpak-update timer)
su - ${FIRST_USER_NAME} -c '
  mkdir -p ~/.config/systemd/user/default.target.wants ~/.config/systemd/user/timers.target.wants
  cp ~/.tvbox/tvbox-cec.service ~/.tvbox/tvbox-remote.service ~/.tvbox/tvbox-gamepad.service ~/.tvbox/tvbox-flatpak-update.service ~/.tvbox/tvbox-flatpak-update.timer ~/.config/systemd/user/
  ln -sf ../tvbox-cec.service ~/.config/systemd/user/default.target.wants/tvbox-cec.service
  ln -sf ../tvbox-remote.service ~/.config/systemd/user/default.target.wants/tvbox-remote.service
  ln -sf ../tvbox-gamepad.service ~/.config/systemd/user/default.target.wants/tvbox-gamepad.service
  ln -sf ../tvbox-flatpak-update.timer ~/.config/systemd/user/timers.target.wants/tvbox-flatpak-update.timer'

# flathub user remote (network works in the chroot; harmless to skip - the deploy
# path re-adds it too). The session script itself needs nothing here: it ships as
# an infra file and the copier above already made it executable.
su - ${FIRST_USER_NAME} -c 'flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo || true'

# kiosk session manager; graphical.target so greetd actually starts at boot
systemctl enable greetd
systemctl set-default graphical.target
CHROOT
