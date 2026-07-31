#!/usr/bin/env bash
# tvbox provision - the ONE root step of an install, run once per box:
#
#   sudo bash ~/.tvbox/provision.sh          # (deploy.sh runs this for you)
#
# Everything root-flavoured lives here so the rest of the system never needs
# elevation: deploy syncs files and manages *user* services, app bundles
# install user-space (flatpak --user / url / git), and the shell runs without
# sudo (reboot/poweroff go through logind's active-session polkit grant).
# Idempotent - safe to re-run after an OS upgrade or a tvbox update.
#
# What it does:
#   - installs the apt baseline (Electron/Wayland/CEC/audio tooling; NO app
#     binaries - apps are opt-in via `tvbox deps <id>`)
#   - grants the box user device access via udev + groups (uinput for the CEC
#     remote bridge, cec/video for the CEC adapter) instead of running anything
#     as root
#   - lets NetworkManager be driven from the box user (polkit rule for netdev)
#   - enables user-service lingering so the CEC bridge starts at boot
#   - migrates old installs (root tvbox-cec system unit -> user unit)
set -u

if [ "$(id -u)" -ne 0 ]; then
  echo "provision.sh must run as root:  sudo bash ~/.tvbox/provision.sh" >&2
  exit 1
fi
# The box user = whoever invoked sudo (or pass explicitly: sudo ./provision.sh <user>).
TVBOX_USER="${1:-${SUDO_USER:-}}"
if [ -z "$TVBOX_USER" ] || [ "$TVBOX_USER" = "root" ]; then
  echo "cannot determine the box user - run via sudo from that user, or: sudo bash provision.sh <user>" >&2
  exit 1
fi

FAIL=0
ok()   { echo "   [ok]   $1"; }
warn() { echo "   [warn] $1"; }
bad()  { echo "   [FAIL] $1"; FAIL=1; }

echo "==> apt baseline"
# apt stderr is let THROUGH (not sent to /dev/null): a failing install must be
# diagnosable. -qq already keeps normal output quiet.
apt-get update -qq || warn "apt update failed (stale package lists?)"
# Hard deps: the box is non-functional without these (Electron, remote, audio,
# focus). wlr-randr backs the Settings resolution/refresh picker (shell/display.js);
# wlrctl is the separate wlroots control tool - they are NOT the same binary.
# python3-venv + pip: the Fire TV remote IR programmer (Settings -> Peripherals)
# installs bleak into a user-space venv on demand; without these that one
# feature can't set up (everything else is unaffected). dbus-fast ships an
# aarch64 wheel, so no compiler is pulled in by it.
HARD="cec-utils python3 python3-evdev python3-venv python3-pip wlrctl wlr-randr pipewire pipewire-pulse wireplumber nodejs npm"
apt-get install -y -qq $HARD && ok "core deps ($HARD)" || bad "core apt deps - install manually: $HARD"
# Soft deps: on-demand app-install tooling (flatpak/curl/git) + output config.
# gcc/libc6-dev: the CEC bridge compiles cec/cec_vendor_shim.c on the box (LG
# SIMPLINK vendor identity - see the bridge docstring); without them LG TV
# remotes may not work, other brands are unaffected.
# fonts-dejavu-core: the launcher font stack ends in `sans-serif`; a minimal
# (Lite-based) box has NO system sans font, so Chromium renders blank/tofu -
# one ubiquitous Latin font makes the whole UI legible (kept in sync with the
# image's 00-packages).
# grim: Wayland screenshot tool - not used by the box itself, but lets a dev
# capture the running UI over ssh (`grim ~/shot.png`) to see what's on screen.
# iw: turns WiFi power saving off on the RUNNING radio, so the drop-in below
# doesn't have to wait for a reconnect. Soft on purpose - without it the setting
# still lands, just at the next boot instead of immediately.
SOFT="jq flatpak kanshi curl git unzip ca-certificates gcc libc6-dev swaybg fonts-dejavu-core grim iw"
apt-get install -y -qq $SOFT && ok "extra deps ($SOFT)" || warn "some extra deps missing: $SOFT"

# Shared media stack in the core (kept in sync with image/stage-tvbox): mpv is
# the shared player for Live TV + Plex; libpulse0/libasound2 are the runtime
# libs the Spotify app's downloaded `librespot` binary links against (like Kodi
# ships ffmpeg/system libs in core while addons ship their own binaries).
# librespot itself is NOT installed here - the Spotify app pulls it from the UI
# as a no-root requires.download binary. Other app binaries stay opt-in.
echo "==> media stack (mpv + audio libs)"
apt-get install -y -qq mpv libpulse0 && ok "mpv + libpulse0" || warn "mpv/libpulse0 missing (Live TV/Plex/Spotify need it)"
# ALSA runtime lib for the librespot/mpv audio path. trixie renamed it to
# libasound2t64 (64-bit time_t transition); fall back to the old name for a
# bookworm box. Installed separately so a name miss can't drop mpv/libpulse0.
apt-get install -y -qq libasound2t64 || apt-get install -y -qq libasound2 && ok "libasound2" || warn "libasound2 missing"

# libcec >= 8 (built from source - no distro ships it yet). Gives cec-client
# --vendor-id, so the LG SIMPLINK identity no longer needs the LD_PRELOAD shim.
# Optional: if the build fails the bridge just keeps using the shim.
echo "==> libcec >= 8 (native --vendor-id, replaces the CEC vendor shim)"
# infra.list lands every shipped file flat next to this script (~/.tvbox/).
LIBCEC_SH="$(cd "$(dirname "$0")" && pwd)/install-libcec8.sh"
if [ -f "$LIBCEC_SH" ]; then
  sh "$LIBCEC_SH" && ok "libcec >= 8" || warn "libcec 8 build failed - the CEC bridge keeps using the vendor shim"
else
  warn "install-libcec8.sh missing - skipping (CEC bridge will use the vendor shim)"
fi

# Always give the compositor an output, even with the TV off or unplugged.
# labwc (0.9.8/wlroots 0.19) BUSY-LOOPS with zero outputs: a session started with
# no sink measured ~65% of a core in labwc alone, ~200% once Electron joined in
# (~35k Wayland roundtrips/s on its main thread) - which is where a box plugged
# in while the TV was off sat until someone turned the TV on. Recovery on the
# TV coming back was clean, so this is purely about never being in that state.
# `vc4.force_hotplug=1`, NOT `video=HDMI-A-1:e`: the latter is what stops vc4
# feeding CEC its physical address on kernels 6.14-6.18 (sharp edge in CLAUDE.md).
# Verified with this on: CEC keeps a real physical address and the remote works.
echo "==> always-on HDMI output (vc4.force_hotplug=1 - labwc spins with no output)"
# KEEP IN SYNC with image/stage-tvbox/01-tvbox/00-run.sh, which does the same to
# the image's cmdline.txt. Normalise EVERY occurrence, not just the first: a
# cmdline carrying both `vc4.force_hotplug=1` and a later `=0` would otherwise
# keep the =0, and the kernel honours the LAST occurrence - so we would report
# success and still boot without it. Build the wanted line, then write only when
# it differs, which keeps this idempotent and leaves the file alone when correct.
CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
# Replace, never truncate in place. `> file` on the FAT boot partition allocates
# the new chain before the directory entry is flushed, so a power cut between the
# two leaves the file with a size of zero and its contents orphaned into a
# FSCK*.REC by the next fsck.fat - and the box then boots on the firmware's
# fallback command line, without root=PARTUUID, the regulatory domain, or
# force_hotplug, none of which is visible from a running system.
write_cmdline() {
  TMPC="$CMDLINE.tvbox-new"
  if ! printf '%s\n' "$1" > "$TMPC" 2>/dev/null; then
    rm -f "$TMPC" 2>/dev/null
    return 1
  fi
  sync
  if ! mv -f "$TMPC" "$CMDLINE" 2>/dev/null; then
    rm -f "$TMPC" 2>/dev/null
    return 1
  fi
  sync
}
if [ ! -f "$CMDLINE" ]; then
  warn "no cmdline.txt found - skipping (a box booted with the TV off will spin)"
else
  # An empty cmdline.txt is that truncation, already happened. Restore our own
  # backup rather than editing nothing onto nothing: the box is booting on the
  # firmware fallback until this is fixed.
  if [ ! -s "$CMDLINE" ] && [ -s "$CMDLINE.bak-tvbox" ]; then
    if write_cmdline "$(cat "$CMDLINE.bak-tvbox")"; then
      ok "$CMDLINE was EMPTY - restored from cmdline.txt.bak-tvbox"
    else
      warn "$CMDLINE is EMPTY and could not be restored from cmdline.txt.bak-tvbox"
    fi
  elif [ ! -s "$CMDLINE" ]; then
    warn "$CMDLINE is EMPTY and there is no backup - the box boots on the firmware fallback"
  fi
  for REC in "$(dirname "$CMDLINE")"/FSCK*.REC; do
    [ -f "$REC" ] || continue
    warn "$(basename "$REC") on the boot partition: fsck.fat recovered a lost cluster chain, so something there was truncated - compare it with cmdline.txt and config.txt"
  done
  CUR=$(cat "$CMDLINE")
  WANT=$(printf '%s' "$CUR" | sed -E 's/(^| )vc4\.force_hotplug=[^ ]*/\1vc4.force_hotplug=1/g')
  case "$WANT" in *vc4.force_hotplug=1*) ;; *) WANT="$WANT vc4.force_hotplug=1" ;; esac
  if [ "$WANT" = "$CUR" ]; then
    ok "vc4.force_hotplug=1 already set"
  elif [ ! -f "$CMDLINE.bak-tvbox" ] && ! cp "$CMDLINE" "$CMDLINE.bak-tvbox"; then
    # Never edit the boot cmdline without a way back.
    warn "could not back up $CMDLINE - leaving it unchanged"
  elif write_cmdline "$WANT"; then
    ok "vc4.force_hotplug=1 set (takes effect on the next boot)"
  else
    warn "could not edit $CMDLINE"
  fi
fi

echo "==> OS auto-updates (unattended-upgrades: install yes, reboot NEVER)"
# A living-room box must patch itself without anyone SSH-ing in - but it must
# also never reboot on its own (a reboot mid-movie is the opposite of an
# appliance). So: security updates from Debian + everything from the Raspberry
# Pi OS archive install automatically in the background; when one of them
# wants a reboot (/var/run/reboot-required), the SHELL shows a gentle
# "restart recommended" hint in Settings and the user reboots from the power
# menu whenever convenient.
if apt-get install -y -qq unattended-upgrades 2>/dev/null; then
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
  cat > /etc/apt/apt.conf.d/52tvbox-unattended-upgrades <<'CONF'
// tvbox: auto-install Debian security + Raspberry Pi OS updates; NEVER reboot
// on our own (the tvbox shell surfaces /var/run/reboot-required in Settings).
Unattended-Upgrade::Origins-Pattern {
        "origin=Debian,codename=${distro_codename},label=Debian-Security";
        "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
        "origin=Raspberry Pi Foundation,codename=${distro_codename}";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer 2>/dev/null
  ok "unattended-upgrades (no auto-reboot; Settings shows when a reboot helps)"
else
  warn "unattended-upgrades install failed - OS updates stay manual"
fi

echo "==> device access (udev + groups) - so the CEC bridge runs as $TVBOX_USER, not root"
# uinput is root-only by default; hand it to the `input` group. The CEC adapter
# (/dev/cec*) is covered too in case the distro's rules don't already grant it
# to `video`.
cat > /etc/udev/rules.d/99-tvbox.rules <<'RULES'
# tvbox: let the box user's CEC->uinput remote bridge run without root
KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
SUBSYSTEM=="cec", GROUP="video", MODE="0660"
# Fire TV / Alexa remotes (Amazon VID 0x0171): their app buttons (Netflix/Prime/
# ...) arrive as a vendor HID report the kernel maps to no key, so the remote
# bridge reads them straight from hidraw. Grant the `input` group read on just
# those remotes' hidraw nodes (parent HID name is <bus>:0171:<pid>.<n>).
SUBSYSTEM=="hidraw", KERNELS=="0005:0171:*", GROUP="input", MODE="0640"
RULES
udevadm control --reload-rules 2>/dev/null && udevadm trigger 2>/dev/null && ok "udev rules" || warn "udev reload failed (rules apply on reboot)"
usermod -aG input,video "$TVBOX_USER" && ok "$TVBOX_USER in input+video groups" || bad "usermod failed"

echo "==> logind: a remote's Power button must never power the box off"
# A BT remote's Power button reaches the box over BT as KEY_POWER. Left to
# logind (default HandlePowerKey=poweroff) it would shut the whole box down -
# especially in the brief window before the input bridge grabs a just-woken
# remote. The remote bridge decides what Power does (TV off over CEC, optionally
# the box too); logind must stay out of it.
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/10-tvbox.conf <<'LOGIND'
[Login]
HandlePowerKey=ignore
HandlePowerKeyLongPress=ignore
LOGIND
systemctl reload systemd-logind 2>/dev/null && ok "logind power-key ignored" || warn "logind reload failed (applies on reboot)"

echo "==> polkit: NetworkManager from the box user (WiFi settings UI)"
# Debian grants active local sessions most NM actions already; this covers the
# gaps (and headless/SSH debugging) for members of netdev - the group Raspberry
# Pi OS puts its first user in.
cat > /etc/polkit-1/rules.d/50-tvbox-networkmanager.rules <<'RULES'
// tvbox: allow netdev users to manage connections (WiFi settings on the TV)
polkit.addRule(function(action, subject) {
    if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 &&
        subject.isInGroup("netdev")) {
        return polkit.Result.YES;
    }
});
RULES
ok "polkit rule (netdev -> NetworkManager)"

echo "==> WiFi power saving off (a mains-powered box only pays its latency cost)"
# NM defaults wifi.powersave to enabled, and the Pi's brcmfmac honours it hard:
# with PSM on, rate control collapses to the 802.11b floor even at -54 dBm.
# Measured on a Pi 5 at 2.4GHz/HT20, same AP and signal, PSM on -> off:
# TX rate 5.5-7.2 -> 72.2 Mbit/s, 30MB transfer >120s -> 10.6s, LAN ping
# avg/max 18.7/209 -> 5.2/29.5 ms, jitter 25.7 -> 3.9 ms, 6.7% -> 0% loss.
# A drop-in (not per-connection) so it also covers networks added later; a
# profile left at "0 (default)" takes this value on its next activation.
# It matters twice over on a Pi: WiFi and Bluetooth share one antenna, so the
# airtime PSM wastes on retries is airtime the gamepad's HID reports don't get.
mkdir -p /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/10-tvbox-wifi.conf <<'NMCONF'
# tvbox: never power-save the WiFi radio (2 = disable). See deploy/provision.sh.
[connection]
wifi.powersave=2
NMCONF
ok "wifi.powersave=2 drop-in"
# The drop-in only takes hold when a connection is next activated, and this box
# may be provisioned OVER that connection - bouncing it would kill the SSH
# session mid-provision (and a WiFi-only box has no second route). `iw set
# power_save off` changes the running radio with no disassociation, so apply it
# straight to every wireless interface and let the drop-in cover future boots.
systemctl reload NetworkManager 2>/dev/null || true
# Glob the cfg80211 marker rather than listing /sys/class/net: it selects exactly
# the wireless interfaces, and cfg80211 is what `iw` talks to anyway.
for PHYLINK in /sys/class/net/*/phy80211; do
  [ -e "$PHYLINK" ] || continue # no wireless interface at all - the glob stayed literal
  IFACE=$(basename "$(dirname "$PHYLINK")")
  iw dev "$IFACE" set power_save off 2>/dev/null &&
    ok "power save off on $IFACE (live, no reconnect)" ||
    warn "could not turn power save OFF on $IFACE now (applies on the next connect)"
done

# Timezone, keyboard layout and hostname from the box user (first-boot wizard +
# Settings). set-timezone is already allowed for an active local session;
# set-keyboard / set-locale / hostname1 require admin auth by default, so grant
# them to an active session or netdev (headless/SSH). Kept in sync with
# conf/51-tvbox-locale.rules.
cat > /etc/polkit-1/rules.d/51-tvbox-locale.rules <<'RULES'
// tvbox: allow the box user to set timezone, keyboard layout and hostname
polkit.addRule(function(action, subject) {
    if ((action.id == "org.freedesktop.locale1.set-keyboard" ||
         action.id == "org.freedesktop.locale1.set-locale" ||
         action.id == "org.freedesktop.timedate1.set-timezone" ||
         action.id == "org.freedesktop.hostname1.set-hostname" ||
         action.id == "org.freedesktop.hostname1.set-static-hostname") &&
        (subject.active || subject.isInGroup("netdev"))) {
        return polkit.Result.YES;
    }
});
RULES
ok "polkit rule (timezone + keymap + hostname)"

echo "==> Wi-Fi regulatory country (root apply of the Settings pick at every boot)"
# The shell stores wifi.country in ~/.tvbox/config.json (rootless); this
# root-side oneshot applies it at boot via raspi-config. Mirrors the SD
# image's tvbox-wifi-unblock.service - KEEP IN SYNC (image 00-run.sh).
cat > /usr/local/sbin/tvbox-wifi-country <<WCEOF
#!/bin/sh
# tvbox: apply the Wi-Fi regulatory country (root - do_wifi_country needs it).
CC=\$(sed -n 's/.*"country"[[:space:]]*:[[:space:]]*"\([A-Za-z][A-Za-z]\)".*/\1/p' /home/$TVBOX_USER/.tvbox/config.json 2>/dev/null | head -n1)
[ -n "\$CC" ] || exit 0 # nothing picked -> leave the OS setting alone
command -v raspi-config >/dev/null || exit 0
exec raspi-config nonint do_wifi_country "\$CC"
WCEOF
chmod 755 /usr/local/sbin/tvbox-wifi-country
cat > /etc/systemd/system/tvbox-wifi-country.service <<WCEOF
[Unit]
Description=tvbox: apply the Wi-Fi regulatory country picked in Settings
After=NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=-/usr/local/sbin/tvbox-wifi-country
# raspi-config's do_wifi_country rewrites /boot/firmware/cmdline.txt with an
# unconditional sed -i, so this unit rewrites the kernel command line on the FAT
# partition at EVERY boot. On vfat a rename can reach the disk before the data it
# points at, and a box cut off before writeback then boots with a zero-byte
# cmdline.txt - found on a real box, with the lost text orphaned into a FSCK*.REC.
# Flushing straight away shrinks that window from the writeback delay to
# milliseconds. KEEP IN SYNC with image/stage-tvbox/01-tvbox/00-run.sh.
ExecStartPost=-/bin/sync

[Install]
WantedBy=multi-user.target
WCEOF
systemctl daemon-reload 2>/dev/null || true
systemctl enable tvbox-wifi-country.service >/dev/null 2>&1 && ok "wifi country unit" || warn "wifi country unit enable failed"
# apply immediately too - provision runs as root anyway
/usr/local/sbin/tvbox-wifi-country && ok "wifi country applied" || warn "wifi country apply failed (raspi-config missing?)"

echo "==> Bluetooth ERTM toggle (root apply of the Settings pick at every boot)"
# Off by default (the kernel default, ERTM on). It exists because some gamepads -
# Xbox ones especially - handle L2CAP Enhanced Retransmission Mode badly and drop
# or repeat HID reports; a lost button-RELEASE report reads as a stuck button.
# Not on unconditionally: ERTM is the layer's own error recovery and turning it
# off is global, so it can make other links (audio) worse. Same shape as the wifi
# country - the shell stores bluetooth.disableErtm rootlessly, this applies it.
# KEEP IN SYNC with image/stage-tvbox/01-tvbox/00-run.sh.
cat > /usr/local/sbin/tvbox-bt-ertm <<BTEOF
#!/bin/sh
# tvbox: apply the Bluetooth ERTM setting (root - modprobe.d + live module param).
ON=\$(sed -n 's/.*"disableErtm"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' /home/$TVBOX_USER/.tvbox/config.json 2>/dev/null | head -n1)
[ "\$ON" = "true" ] && V=1 || V=0
# For the next boot: the bluetooth module is loaded long before this unit runs.
printf 'options bluetooth disable_ertm=%s\n' "\$V" > /etc/modprobe.d/tvbox-bluetooth.conf
# And live, so starting this unit by hand applies to links made from now on
# (the parameter is only consulted when an L2CAP connection is set up).
P=/sys/module/bluetooth/parameters/disable_ertm
[ -w "\$P" ] && printf '%s\n' "\$V" > "\$P"
exit 0
BTEOF
chmod 755 /usr/local/sbin/tvbox-bt-ertm
cat > /etc/systemd/system/tvbox-bt-ertm.service <<'BTEOF'
[Unit]
Description=tvbox: apply the Bluetooth ERTM setting picked in Settings
After=bluetooth.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=-/usr/local/sbin/tvbox-bt-ertm

[Install]
WantedBy=multi-user.target
BTEOF
systemctl daemon-reload 2>/dev/null || true
systemctl enable tvbox-bt-ertm.service >/dev/null 2>&1 && ok "bluetooth ERTM unit" || warn "bluetooth ERTM unit enable failed"
/usr/local/sbin/tvbox-bt-ertm && ok "bluetooth ERTM applied" || warn "bluetooth ERTM apply failed"

echo "==> root filesystem grows to fill the card (flashed images ship it nearly full)"
# A flashed image sizes its rootfs to its own contents plus pi-gen's margin and
# this image installs no first-boot resize hook, so without this a fresh box has
# ~174 MB of usable space on any size card - measured on v1.18.0 - and fills up on
# its first boot. ext4 then aborts the filesystem and remounts read-only, which
# does NOT look like a full disk: ssh-keygen cannot write host keys so sshd
# accepts connections and closes them with no banner, and the shell cannot write
# so it crash-loops behind a black screen. Idempotent, so it also covers a card
# swapped for a bigger one. KEEP IN SYNC with image/stage-tvbox/01-tvbox/00-run.sh.
# Quoted heredoc: nothing here is substituted at provision time, and it keeps the
# script's own $ and backtick-free comments intact.
cat > /usr/local/sbin/tvbox-expand-rootfs <<'XSEOF'
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
chmod 755 /usr/local/sbin/tvbox-expand-rootfs
if [ -x /usr/local/sbin/tvbox-expand-rootfs ]; then
  cat > /etc/systemd/system/tvbox-expand-rootfs.service <<'XREOF'
[Unit]
Description=tvbox: grow the root filesystem to fill the card
# Same shape as Raspberry Pi's own regenerate_ssh_host_keys.service: very early,
# root already read-write, and BEFORE the things that need somewhere to write.
# Before=systemd-growfs-root.service matters: the base image's rpi-resize.service
# delegates to growfs, which grows the FILESYSTEM to its partition and never
# repartitions - so it no-ops on an image whose partition was never widened.
# Going first means growfs has real room to grow into.
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
XREOF
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable tvbox-expand-rootfs.service >/dev/null 2>&1 && ok "expand-rootfs unit" || warn "expand-rootfs unit enable failed"
  # run it now too - a no-op on an already-expanded box
  /usr/local/sbin/tvbox-expand-rootfs && ok "root filesystem checked" || warn "expand-rootfs run failed"
fi

echo "==> out-of-band diagnostics + safe mode (a report on the boot partition, and a way in)"
# A box that cannot start is a box that cannot be asked anything: the screen, the
# network and sshd all went down together the one time it happened. The FAT boot
# partition is the only medium the firmware, this box and any laptop can all read,
# so the report goes there, and safe mode is what brings the box up far enough to
# be asked. Both are root: the boot partition mounts fmask=0022 and greetd is a
# system unit. The shell stays rootless (hard rule #1) - its only part in this is
# a marker file in its own home (shell/boothealth.js).
#
# Real files installed from ~/.tvbox/, not heredocs generated here: they also have
# to reach flashed images (image/stage-tvbox installs the same files) and they are
# unit-tested in CI, which a heredoc cannot be. An OTA release refreshes the copies
# in ~/.tvbox/ but cannot install them here, so a box that only ever updates over
# OTA keeps the version it was provisioned with until the next provision.
HERE="$(cd "$(dirname "$0")" && pwd)"
DIAG_OK=1
for PAIR in tvbox-diag.sh:tvbox-diag tvbox-safemode.sh:tvbox-safemode; do
  SRC="$HERE/${PAIR%%:*}"
  DST="/usr/local/sbin/${PAIR##*:}"
  if [ ! -f "$SRC" ]; then
    warn "$(basename "$SRC") missing - skipping (diagnostics unavailable)"
    DIAG_OK=0
  elif ! install -m 755 -o root -g root "$SRC" "$DST"; then
    warn "could not install $DST"
    DIAG_OK=0
  fi
done
if [ "$DIAG_OK" = 1 ]; then
  for U in tvbox-diag.service tvbox-diag.timer tvbox-safemode.service tvbox-safemode-screen.service; do
    [ -f "$HERE/$U" ] && install -m 644 "$HERE/$U" "/etc/systemd/system/$U"
  done
  # Safe mode on the session side is one condition on greetd. A drop-in rather than
  # an edited unit so a greetd package update cannot undo it; harmless on a box
  # whose session comes up some other way, which run-shell.sh covers instead.
  if [ -f "$HERE/greetd-tvbox-safemode.conf" ]; then
    install -d /etc/systemd/system/greetd.service.d
    install -m 644 "$HERE/greetd-tvbox-safemode.conf" \
      /etc/systemd/system/greetd.service.d/10-tvbox-safemode.conf
  fi
  systemctl daemon-reload 2>/dev/null || true
  if systemctl enable tvbox-safemode.service tvbox-safemode-screen.service \
    tvbox-diag.service tvbox-diag.timer >/dev/null 2>&1; then
    ok "tvbox-safemode + tvbox-diag units enabled"
  else
    warn "could not enable the diagnostics/safe-mode units"
  fi
  # Write the first report now: it is the file someone reads when the box has
  # stopped answering, so it should exist before the first thing goes wrong.
  # tvbox-safemode is deliberately NOT started here - it would clear the running
  # session's healthy marker and count this boot as a failed start. The timer IS,
  # so the report keeps up to date on a box that is not rebooted for weeks
  # (`enable` alone only takes effect at the next boot).
  /usr/local/sbin/tvbox-diag && ok "wrote the boot-partition report (tvbox-diag.txt)" ||
    warn "could not write the report (boot partition full or read-only?)"
  systemctl start tvbox-diag.timer >/dev/null 2>&1 && ok "diagnostics refresh timer running" ||
    warn "could not start tvbox-diag.timer (it will start at the next boot)"
fi

echo "==> user-service lingering (CEC bridge starts at boot, before login)"
loginctl enable-linger "$TVBOX_USER" 2>/dev/null && ok "linger enabled for $TVBOX_USER" || warn "enable-linger failed"

echo "==> migrate old installs (root CEC unit -> user unit; /usr/local symlink -> ~/.local/bin)"
if [ -f /etc/systemd/system/tvbox-cec.service ]; then
  systemctl disable --now tvbox-cec.service 2>/dev/null
  rm -f /etc/systemd/system/tvbox-cec.service
  systemctl daemon-reload
  ok "removed legacy root tvbox-cec system unit (replaced by the user unit)"
fi
# Remove ONLY a stale/foreign CEC command node (e.g. the old root-owned FIFO):
# a live FIFO owned by the box user belongs to a running bridge, and this script
# claims to be safe to re-run, so don't unlink it out from under the bridge (it
# self-heals a replaced node anyway). A standalone `sudo bash provision.sh`
# re-run thus no longer disrupts CEC.
CECFIFO=/tmp/tvbox-cec-cmd
if [ -e "$CECFIFO" ]; then
  CECOWNER="$(stat -c '%U' "$CECFIFO" 2>/dev/null || echo)"
  if [ ! -p "$CECFIFO" ] || [ "$CECOWNER" != "$TVBOX_USER" ]; then
    rm -f "$CECFIFO" 2>/dev/null || true
    ok "removed stale/foreign /tmp/tvbox-cec-cmd (the user bridge recreates it)"
  fi
fi
if [ -L /usr/local/bin/tvbox ]; then
  rm -f /usr/local/bin/tvbox
  ok "removed legacy /usr/local/bin/tvbox symlink (CLI now lives in ~/.local/bin)"
fi
# Retire the pre-1.0 unconditional NOPASSWD:ALL drop-in - sudo is now opt-in
# (below), and nothing at runtime requires root.
if [ -f /etc/sudoers.d/tvbox ] && grep -q "NOPASSWD:ALL" /etc/sudoers.d/tvbox 2>/dev/null; then
  rm -f /etc/sudoers.d/tvbox
  ok "removed legacy NOPASSWD:ALL sudoers drop-in (superseded by the opt-in grant)"
fi

# Power-user sudo (opt-in via the boot-partition tvbox.conf, exactly like SSH).
# If tvbox.conf has SUDO=true (or the legacy empty `tvbox-sudo` marker is
# present), grant the box user passwordless sudo so an admin over SSH can do root
# work; otherwise make sure no such grant lingers. NOPASSWD is the only option
# (the account is password-locked, so plain sudo can't prompt) - this mirrors
# Raspberry Pi OS's own 010_pi-nopasswd default. The tvbox shell stays rootless
# (hard rule #1); nothing at runtime calls sudo - this is a HUMAN affordance
# only. The image's tvbox-firstboot applies the identical rule on a flashed box.
echo "==> power-user sudo (opt-in via boot-partition tvbox.conf SUDO=true)"
BOOTP=/boot/firmware; [ -d "$BOOTP" ] || BOOTP=/boot
SUDO_CONF="$(sed -n 's/^SUDO=//p' "$BOOTP/tvbox.conf" 2>/dev/null | head -n1 | tr -d '\r')"
if [ "$SUDO_CONF" = "true" ] || [ "$SUDO_CONF" = "1" ] || [ "$SUDO_CONF" = "yes" ] || [ -f "$BOOTP/tvbox-sudo" ]; then
  printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$TVBOX_USER" > /etc/sudoers.d/010-tvbox.tmp
  if visudo -cf /etc/sudoers.d/010-tvbox.tmp >/dev/null 2>&1; then
    chmod 440 /etc/sudoers.d/010-tvbox.tmp && mv /etc/sudoers.d/010-tvbox.tmp /etc/sudoers.d/010-tvbox
    ok "passwordless sudo for $TVBOX_USER (tvbox.conf SUDO)"
  else
    rm -f /etc/sudoers.d/010-tvbox.tmp; warn "sudoers validation failed - sudo not enabled"
  fi
elif [ -f /etc/sudoers.d/010-tvbox ]; then
  rm -f /etc/sudoers.d/010-tvbox; ok "revoked passwordless sudo (no SUDO=true)"
else
  ok "no sudo grant (set SUDO=true in the boot partition's tvbox.conf to enable)"
fi

# tvbox is a kiosk: the Electron shell owns the whole screen. The stock system
# labwc session (/etc/xdg/labwc/autostart) launches the Pi desktop - the panel
# (wf-panel-pi) and the file-manager that draws the wallpaper + desktop icons
# (pcmanfm-pi), both under lwrespawn (so they respawn if merely killed). Those
# flash behind the shell whenever it restarts (e.g. after an app install). Stop
# them at the SOURCE: replace the system autostart so they never start. The tvbox
# user autostart (~/.config/labwc/autostart) runs kanshi, audio, a solid-black
# background (swaybg), and the shell; lxsession-xdg-autostart still runs session
# agents. Idempotent; the original is backed up once.
echo "==> kiosk session (no Pi desktop: panel / wallpaper / icons never start)"
mkdir -p /etc/xdg/labwc
if [ -f /etc/xdg/labwc/autostart ] && [ ! -f /etc/xdg/labwc/autostart.pre-tvbox ]; then
  cp /etc/xdg/labwc/autostart /etc/xdg/labwc/autostart.pre-tvbox
fi
cat > /etc/xdg/labwc/autostart <<'LABWCSYS'
# tvbox kiosk - the Pi desktop (panel + file-manager/wallpaper/desktop-icons) is
# intentionally NOT started; the tvbox shell owns the screen. See the box user's
# ~/.config/labwc/autostart (kanshi, audio, black background, the Electron shell).
/usr/bin/lxsession-xdg-autostart
LABWCSYS
ok "kiosk labwc session (desktop chrome disabled)"

echo
if [ "$FAIL" = 0 ]; then
  echo "==> provision OK. Group changes need a reboot to reach the user session."
else
  echo "==> provision FAILED on one or more hard steps (see [FAIL] above) - fix and re-run."
fi
exit $FAIL
