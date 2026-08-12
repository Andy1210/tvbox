#!/usr/bin/env bash
# tvbox provision - the ONE root step of an install, run once per box:
#
#   sudo bash ~/.tvbox/provision.sh          # (deploy.sh runs this for you)
#
# Everything root-flavoured lives here so the rest of the system never needs
# elevation: deploy syncs files and manages *user* services, app bundles
# install user-space (flatpak --user / url / git), and the shell runs without
# sudo (reboot/poweroff go through the polkit grant below - NOT logind's
# active-session default, which never covered the shell: it has no session).
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

# What revision of the ROOT half this script installs. Bumped by hand when
# provision gains something a box must have - a package, a grant, a unit - and
# read by two things that must agree: scripts/make-release.sh puts it in the feed
# as `systemRevision`, and tvbox-sysupdate refuses to run a release whose
# provision.sh does not carry the number the feed promised.
#
# Bumped by hand and not derived from a hash of this file, because a comment edit
# is not a reason to re-provision a fleet. scripts/provision_revision_check.js
# is the reminder: it fails when the root payload's content moved and this did
# not.
PROVISION_REVISION=1

# Set by tvbox-sysupdate: this run has nobody in front of it. Two things are a
# person's to decide and are skipped in that mode - see where each is used.
UNATTENDED="${TVBOX_UNATTENDED:-0}"

FAIL=0
WARNINGS=0
ok()   { echo "   [ok]   $1"; }
warn() { echo "   [warn] $1"; WARNINGS=$((WARNINGS + 1)); }
bad()  { echo "   [FAIL] $1"; FAIL=1; }

# The last line of a run, and the only thing an unattended caller reads. This
# script exits 0 for a great many partial outcomes - most of its failure branches
# only `warn` - so "exit 0" alone cannot mean "revision N is applied", and
# recording the revision on it would let a release declare a requirement the box
# only half has.
result_line() { echo "PROVISION_RESULT rev=$PROVISION_REVISION bad=$FAIL warn=$WARNINGS"; }
trap result_line EXIT

echo "==> apt baseline"
# apt stderr is let THROUGH (not sent to /dev/null): a failing install must be
# diagnosable. -qq already keeps normal output quiet.
#
# Wait for the dpkg lock rather than failing on it. unattended-upgrades runs on
# its own timer (enabled below), so an unattended provision arriving while it
# holds the lock is an ordinary Tuesday - and on a box with no ssh, "apt was
# busy" would otherwise be a system update that can never succeed.
APT="apt-get -o DPkg::Lock::Timeout=600"
apt_install() { $APT install -y -qq "$@"; }
$APT update -qq || warn "apt update failed (stale package lists?)"
# Hard deps: the box is non-functional without these (Electron, remote, audio,
# the compositor). The lib* ones are what tvbox-wc links against; on a Lite image
# nothing else pulls them in, and the box has no session without them.
# python3-venv + pip: the Fire TV remote IR programmer (Settings -> Peripherals)
# installs bleak into a user-space venv on demand; without these that one
# feature can't set up (everything else is unaffected). dbus-fast ships an
# aarch64 wheel, so no compiler is pulled in by it.
HARD="cec-utils openssl python3 python3-evdev python3-venv python3-pip pipewire pipewire-pulse wireplumber nodejs npm greetd seatd libgbm1 libseat1 libinput10 libxkbcommon0 libwayland-server0 libegl1 libgles2"
apt_install $HARD && ok "core deps ($HARD)" || bad "core apt deps - install manually: $HARD"
# Soft deps: on-demand app-install tooling (flatpak/curl/git) + output config.
# gcc/libc6-dev: the CEC bridge compiles cec/cec_vendor_shim.c on the box (LG
# SIMPLINK vendor identity - see the bridge docstring); without them LG TV
# remotes may not work, other brands are unaffected.
# fonts-dejavu-core: the launcher font stack ends in `sans-serif`; a minimal
# (Lite-based) box has NO system sans font, so Chromium renders blank/tofu -
# one ubiquitous Latin font makes the whole UI legible (kept in sync with the
# image's 00-packages).
# iw: turns WiFi power saving off on the RUNNING radio, so the drop-in below
# doesn't have to wait for a reconnect. Soft on purpose - without it the setting
# still lands, just at the next boot instead of immediately.
# udisks2: the only way to mount a USB stick with no root and no fstab line (the
# polkit grant is below). Soft as well - without it the box browses its own
# folders and says that USB is unavailable, which is also what an OTA-only box
# gets, since OTA can never install an apt package.
SOFT="jq flatpak curl git unzip ca-certificates gcc libc6-dev fonts-dejavu-core iw udisks2"
apt_install $SOFT && ok "extra deps ($SOFT)" || warn "some extra deps missing: $SOFT"

# Shared media stack in the core (kept in sync with image/stage-tvbox): mpv is
# the shared player for Live TV + Plex; libpulse0/libasound2 are the runtime
# libs the Spotify app's downloaded `librespot` binary links against (like Kodi
# ships ffmpeg/system libs in core while addons ship their own binaries).
# librespot itself is NOT installed here - the Spotify app pulls it from the UI
# as a no-root requires.download binary. Other app binaries stay opt-in.
echo "==> media stack (mpv + audio libs)"
apt_install mpv libpulse0 && ok "mpv + libpulse0" || warn "mpv/libpulse0 missing (Live TV/Plex/Spotify need it)"
# ALSA runtime lib for the librespot/mpv audio path. trixie renamed it to
# libasound2t64 (64-bit time_t transition); fall back to the old name for a
# bookworm box. Installed separately so a name miss can't drop mpv/libpulse0.
apt_install libasound2t64 || apt_install libasound2 && ok "libasound2" || warn "libasound2 missing"

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
# A compositor with zero outputs has nothing to pace it, and Electron then spins
# against it: measured ~65% of a core in the compositor alone, ~200% once Electron
# (~35k Wayland roundtrips/s on its main thread) - which is where a box plugged
# in while the TV was off sat until someone turned the TV on. Recovery on the
# TV coming back was clean, so this is purely about never being in that state.
# `vc4.force_hotplug=1`, NOT `video=HDMI-A-1:e`: the latter is what stops vc4
# feeding CEC its physical address on kernels 6.14-6.18 (sharp edge in CLAUDE.md).
# Verified with this on: CEC keeps a real physical address and the remote works.
echo "==> always-on HDMI output (vc4.force_hotplug=1 - the session spins with no output)"
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
if apt_install unattended-upgrades 2>/dev/null; then
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
# bridge reads them straight from hidraw. Grant the `input` group access to just
# those remotes' hidraw nodes (parent HID name is <bus>:0171:<pid>.<n>).
# WRITE as well as read (0660, not 0640): the remote's microphone only streams
# after the host sends it an output report, so the voice satellite has to write to
# the same node - see docs/voice-satellite.md.
SUBSYSTEM=="hidraw", KERNELS=="0005:0171:*", GROUP="input", MODE="0660"
RULES
udevadm control --reload-rules 2>/dev/null && udevadm trigger 2>/dev/null && ok "udev rules" || warn "udev reload failed (rules apply on reboot)"
# plugdev is the group the polkit rule below grants removable media to. Raspberry
# Pi OS already puts its first user in it; a box built another way may not have it
# at all, so it is created rather than assumed.
getent group plugdev >/dev/null || groupadd plugdev
usermod -aG input,video,plugdev "$TVBOX_USER" && ok "$TVBOX_USER in input+video+plugdev groups" || bad "usermod failed"

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

echo "==> polkit: reboot / shut down from the power menu (no sudo needed)"
# The power menu ran on an assumption that was never true here: that logind's own
# "an active local session may shut down" default covers the shell. It does not -
# Electron moves its main process into its own systemd app scope, so the seat's
# session does not contain it and polkit sees a subject with no session at all,
# exactly as for udisks below. Without this rule the menu worked only where the
# opt-in passwordless sudo was granted, and on every other box it did something
# worse than fail: systemctl asked polkit interactively, spawned pkttyagent to
# read a terminal, and the SIGTTIN that follows stopped the whole process group -
# the shell AND its respawn loop - leaving a box that looks bricked.
cat > /etc/polkit-1/rules.d/54-tvbox-power.rules <<'RULES'
// tvbox: let the box user reboot and shut the box down from the power menu.
// Two actions, named exactly. `halt` stays out (it stops the machine without
// cutting power, indistinguishable from a hang on a headless box). The
// -multiple-sessions / -ignore-inhibit variants stay out too - note that logind
// picks ONE action rather than falling back, so with a second uid's session or a
// block-mode inhibitor the menu is denied, not delayed. Narrow, and now visible on
// screen instead of silent.
// Matches on the GROUP because the shell has no logind session - Electron moves
// its main process into its own app scope, so subject.active is false for it.
// `video` is a device-access group, not "whoever drives the screen": every member
// can also power the box off over SSH unauthenticated, which is the price of a
// grant that works on a flashed box too.
// KEEP IN SYNC with image/stage-tvbox/01-tvbox/conf/54-tvbox-power.rules.
polkit.addRule(function (action, subject) {
  if (
    (action.id === "org.freedesktop.login1.reboot" || action.id === "org.freedesktop.login1.power-off") &&
    subject.isInGroup("video")
  ) {
    return polkit.Result.YES;
  }
});
RULES
ok "polkit rule (video -> reboot/power-off)"

echo "==> polkit: mounting a USB stick from the box user (local media on the TV)"
# The desktop default would already allow this - udisks grants `filesystem-mount`
# to an ACTIVE local session - but the shell is not one: Electron moves its main
# process into its own systemd app scope, which takes it out of the seat's logind
# session, and polkit then sees a subject with no session at all. Measured on a Pi
# 5: pkcheck says "authorization requires authentication" for the shell's pid and
# yes for the compositor's, in the same session.
#
# ONE action, the one the shell calls. The box's own SD card is a "system internal"
# device to udisks and answers to `filesystem-mount-system`, which is deliberately
# absent - so nothing this rule allows can mount the partitions the box runs from.
# Nor is anything else granted for the sake of symmetry: `power-off-drive` would cut
# power to a USB SSD a Pi can BOOT from, and unmounting a mount the shell made
# itself needs no action at all (udisks authorises the uid that mounted it), so
# `filesystem-unmount-others` - the one action a desktop session does not get either
# - stays out too.
cat > /etc/polkit-1/rules.d/50-tvbox-udisks.rules <<'RULES'
// tvbox: allow plugdev users to mount REMOVABLE media (USB sticks).
// Internal disks are not covered: that is filesystem-mount-system, not this.
// Nothing else is granted either - power-off-drive would cut power to a USB SSD a
// Pi can boot from, and unmounting a mount the shell made itself needs no action.
// KEEP IN SYNC with image/stage-tvbox/01-tvbox/conf/50-tvbox-udisks.rules.
polkit.addRule(function (action, subject) {
  if (subject.isInGroup("plugdev") && action.id === "org.freedesktop.udisks2.filesystem-mount") {
    return polkit.Result.YES;
  }
});
RULES
ok "polkit rule (plugdev -> udisks2 filesystem-mount)"

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

echo "==> Keyboard layout (root apply of the Settings pick at every boot)"
# The Settings pick reaches localectl too, but that is all it does on this image:
# Raspberry Pi OS ships a drop-in making /etc/X11/xorg.conf.d read-only for
# systemd-localed ("we don't use it"), and localed then logs
#   Failed to write X11 keyboard layout, ignoring: Read-only file system
# and persists NOTHING - so the layout is back to the image default at the next
# boot. This writes the file the OS actually reads, and re-tells localed, so the
# pick survives. Mirrors tvbox-wifi-country - KEEP IN SYNC (image 00-run.sh).
cat > /usr/local/sbin/tvbox-keymap <<KMEOF
#!/bin/sh
# tvbox: apply the keyboard layout picked in Settings (root - /etc/default).
KB=\$(sed -n 's/.*"layout"[[:space:]]*:[[:space:]]*"\([a-z0-9,_-]\{1,32\}\)".*/\1/p' /home/$TVBOX_USER/.tvbox/config.json 2>/dev/null | head -n1)
[ -n "\$KB" ] || exit 0 # nothing picked -> leave the OS setting alone
[ -f /etc/default/keyboard ] || exit 0
# In place, so every other field (model, variant, options, BACKSPACE) is left
# exactly as the image had it.
sed -i "s/^XKBLAYOUT=.*/XKBLAYOUT=\"\$KB\"/" /etc/default/keyboard
# And tell the running localed, so Settings reads back what was picked rather
# than what the file said before this ran.
command -v localectl >/dev/null && localectl set-x11-keymap "\$KB" >/dev/null 2>&1
exit 0
KMEOF
chmod 755 /usr/local/sbin/tvbox-keymap
cat > /etc/systemd/system/tvbox-keymap.service <<KMEOF
[Unit]
Description=tvbox: apply the keyboard layout picked in Settings
After=systemd-localed.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=-/usr/local/sbin/tvbox-keymap

[Install]
WantedBy=multi-user.target
KMEOF
systemctl daemon-reload 2>/dev/null || true
systemctl enable tvbox-keymap.service >/dev/null 2>&1 && ok "keymap unit" || warn "keymap unit enable failed"
/usr/local/sbin/tvbox-keymap && ok "keymap applied" || warn "keymap apply failed"

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

echo "==> screen mirroring (Wi-Fi Display sink)"
# Creating a Wi-Fi Direct group needs root - wpa_supplicant, an address on the
# group interface, DHCP on port 67 - and root at runtime is exactly what nothing
# in the shell may have. So the privileged part is this helper plus a unit, and
# the shell reaches it the same way it reaches everything else root owns: a
# polkit grant for a group it is in, never sudo.
#
# The unit is deliberately NOT enabled. A group owner beacons continuously and
# holds a radio this board shares with Bluetooth, so it is armed on request and
# given back afterwards.
# Both halves or neither. Installing the helper without the unit leaves a box
# that says mirroring is available and cannot start it - and a polkit rule
# granting access to a unit that is not there.
if [ -f "$HERE/tvbox-miracast" ] && [ -f "$HERE/tvbox-miracast.service" ] &&
  install -m 755 -o root -g root "$HERE/tvbox-miracast" /usr/local/sbin/tvbox-miracast &&
  install -m 644 "$HERE/tvbox-miracast.service" /etc/systemd/system/tvbox-miracast.service; then
  # ONE unit, three verbs, one group. Not a blanket manage-units grant: that
  # would hand the box user every service on the machine, including the ones
  # that bring the session up.
  cat > /etc/polkit-1/rules.d/52-tvbox-miracast.rules <<'RULES'
// tvbox: let the box user arm and disarm screen mirroring.
// Only this unit and only start/stop/restart - a general manage-units grant
// would cover greetd, NetworkManager and everything else besides.
// The shell has no logind session (Electron moves its main process into its own
// app scope), so this matches on the GROUP, not on subject.active.
polkit.addRule(function (action, subject) {
  if (
    action.id === "org.freedesktop.systemd1.manage-units" &&
    action.lookup("unit") === "tvbox-miracast.service" &&
    ["start", "stop", "restart"].indexOf(action.lookup("verb")) >= 0 &&
    subject.isInGroup("netdev")
  ) {
    return polkit.Result.YES;
  }
});
RULES
  systemctl daemon-reload 2>/dev/null || true
  # wpa_supplicant's control socket is group netdev, which is what lets the shell
  # re-open the WPS push button without root. On Raspberry Pi OS the box user is
  # already in netdev; say so rather than assume it.
  if id -nG "$TVBOX_USER" 2>/dev/null | tr ' ' '\n' | grep -qx netdev; then
    ok "screen mirroring installed (tvbox-miracast, armed on request)"
  else
    # A group added here does not reach the RUNNING session, and this one is not
    # optional: without netdev the shell cannot open the pairing button, so a
    # phone would find the box, ask to pair, and be answered by nothing at all.
    usermod -aG netdev "$TVBOX_USER" 2>/dev/null &&
      warn "screen mirroring installed; $TVBOX_USER added to netdev - REBOOT before mirroring will pair" ||
      warn "screen mirroring installed but $TVBOX_USER is not in netdev - it will not be able to pair"
  fi
else
  warn "tvbox-miracast helper or unit missing - screen mirroring unavailable"
fi

echo "==> built-in radios as a setting (config.txt, applied by a root unit)"
# Turning the Pi's OWN wifi or Bluetooth off is a boot-config change, so it is
# root's - and a USB dongle is only worth having once the built-in radio is out of
# the antenna's way (they share one on this chip). Same both-halves-or-neither rule
# as mirroring: a helper without its unit leaves a Settings switch that cannot work,
# and a polkit grant for a unit that is not there.
if [ -f "$HERE/tvbox-radio" ] && [ -f "$HERE/tvbox-radio@.service" ] &&
  install -m 755 -o root -g root "$HERE/tvbox-radio" /usr/local/sbin/tvbox-radio &&
  install -m 644 -o root -g root "$HERE/tvbox-radio@.service" /etc/systemd/system/tvbox-radio@.service; then
  # The ACTION is the instance name, so the grant names all four instances rather
  # than a prefix - `tvbox-radio@anything.service` would be a wider door than this
  # needs, and the script would reject it anyway.
  cat > /etc/polkit-1/rules.d/53-tvbox-radio.rules <<'RULES'
// tvbox: let the box user turn the built-in wifi/Bluetooth off and back on.
// Four exact instances and only `start` - the unit is a oneshot, and a prefix
// match or a general manage-units grant would cover far more than this needs.
// Matches on the GROUP: the shell has no logind session (Electron moves its main
// process into its own app scope), so subject.active is false for it.
polkit.addRule(function (action, subject) {
  var units = [
    "tvbox-radio@bt-off.service",
    "tvbox-radio@bt-on.service",
    "tvbox-radio@wifi-off.service",
    "tvbox-radio@wifi-on.service",
  ];
  if (
    action.id === "org.freedesktop.systemd1.manage-units" &&
    units.indexOf(action.lookup("unit")) >= 0 &&
    action.lookup("verb") === "start" &&
    subject.isInGroup("netdev")
  ) {
    return polkit.Result.YES;
  }
});
RULES
  systemctl daemon-reload 2>/dev/null || true
  # The grant above matches on netdev, so membership is what decides whether the
  # switch works at all - and a box whose mirroring block took its `else` branch
  # never got it. Reporting success without checking leaves a healthy-looking
  # toggle that answers "Access denied" on every press, with the reason in a
  # journal the box user cannot read.
  if id -nG "$TVBOX_USER" 2>/dev/null | tr ' ' '\n' | grep -qx netdev; then
    ok "built-in radio switch installed (tvbox-radio)"
  else
    usermod -aG netdev "$TVBOX_USER" 2>/dev/null &&
      warn "built-in radio switch installed; $TVBOX_USER added to netdev - REBOOT before it can apply a change" ||
      warn "built-in radio switch installed but $TVBOX_USER is not in netdev - it will not be able to apply a change"
  fi
else
  warn "tvbox-radio helper or unit missing - the built-in radio switch is unavailable"
fi

echo "==> system update (the root half a release cannot install by itself)"
# An OTA release is user-space, so a version needing an apt package, a grant or a
# root unit could only ever arrive by re-flash - and an end-user box has no ssh.
# tvbox-sysupdate is the narrow root half that closes that: the shell asks, and
# the script fetches a SIGNED feed, verifies it against a key pinned here, and
# runs the release's own provision.sh out of a root-only directory. It never
# execs anything from the box user's home, which is the invariant that stops a
# user app's plugin.js from becoming root at the next boot.
# Both halves or neither, like mirroring and the radio: a helper without its unit
# leaves a Settings button that cannot work and a polkit grant pointing at
# nothing.
if [ -f "$HERE/tvbox-sysupdate" ] && [ -f "$HERE/tvbox-sysupdate.service" ] &&
  install -m 755 -o root -g root "$HERE/tvbox-sysupdate" /usr/local/sbin/tvbox-sysupdate &&
  install -m 644 -o root -g root "$HERE/tvbox-sysupdate.service" /etc/systemd/system/tvbox-sysupdate.service; then
  install -d -m 755 -o root -g root /etc/tvbox /etc/tvbox/release-keys.d /var/lib/tvbox
  if [ -f "$HERE/54-tvbox-sysupdate.rules" ]; then
    install -m 644 -o root -g root "$HERE/54-tvbox-sysupdate.rules" \
      /etc/polkit-1/rules.d/54-tvbox-sysupdate.rules
  else
    warn "54-tvbox-sysupdate.rules missing - the box user cannot ask for a system update"
  fi

  # The feed URL is the operator's, so an existing file is never overwritten -
  # a box pointed at a self-hosted feed keeps it across updates. TVBOX_USER is
  # rewritten every time: it is this run's answer, and the name provision grants
  # things to must not be able to drift from it.
  if [ ! -f /etc/tvbox/sysupdate.conf ] && [ -f "$HERE/sysupdate.conf" ]; then
    install -m 644 -o root -g root "$HERE/sysupdate.conf" /etc/tvbox/sysupdate.conf
  fi
  if [ -f /etc/tvbox/sysupdate.conf ]; then
    sed -i -E "s@^TVBOX_USER=.*@TVBOX_USER=$TVBOX_USER@" /etc/tvbox/sysupdate.conf
    grep -q "^TVBOX_USER=" /etc/tvbox/sysupdate.conf || printf 'TVBOX_USER=%s\n' "$TVBOX_USER" >> /etc/tvbox/sysupdate.conf
  else
    warn "no /etc/tvbox/sysupdate.conf - system updates will not know where to look"
  fi

  # The pinned release key is root's trust anchor for everything the applier will
  # ever run, so it is installed ONCE and never silently replaced.
  #
  # The subtlety is where this script itself came from. `sudo bash
  # ~/.tvbox/provision.sh` runs out of the box user's home, and every OTA
  # refreshes that directory - so on that path the key beside this script is only
  # as trustworthy as the box. Root trusting ~/.tvbox for the length of one
  # human-driven run is how provision has always worked; PINNING a key from there
  # would turn one compromise into a standing channel. So a key is taken from a
  # user-writable directory only when the caller says the tree is theirs
  # (deploy.sh does, from a developer's own checkout).
  KEY_DST=/etc/tvbox/release-keys.d/tvbox-release.pem
  if [ -f "$KEY_DST" ]; then
    if [ -f "$HERE/release-key.pem" ] && ! cmp -s "$HERE/release-key.pem" "$KEY_DST"; then
      warn "a DIFFERENT release key ships with this tree - keeping the pinned one (TVBOX_ROTATE_KEY=1 to replace)"
      if [ "${TVBOX_ROTATE_KEY:-0}" = 1 ]; then
        install -m 644 -o root -g root "$HERE/release-key.pem" "$KEY_DST" &&
          ok "release key rotated on request"
      fi
    else
      ok "release key already pinned"
    fi
  elif [ ! -f "$HERE/release-key.pem" ]; then
    warn "no release-key.pem in $HERE - system updates cannot verify a feed"
  else
    # Root-owned and not writable by group or other, or the caller vouching for
    # the tree. Written out rather than chained, because `A || B && C` groups as
    # `(A || B) && C` in sh and would then refuse exactly the deploy.sh case.
    KEY_TRUSTED=0
    [ "${TVBOX_TRUST_LOCAL_KEY:-0}" = 1 ] && KEY_TRUSTED=1
    if [ "$KEY_TRUSTED" = 0 ] && [ "$(stat -c %u "$HERE" 2>/dev/null)" = 0 ] &&
      [ -z "$(find "$HERE" -maxdepth 0 -perm /022 2>/dev/null)" ]; then
      KEY_TRUSTED=1
    fi
    if [ "$KEY_TRUSTED" = 1 ]; then
      install -m 644 -o root -g root "$HERE/release-key.pem" "$KEY_DST" &&
        ok "release key pinned ($KEY_DST)" ||
        warn "could not pin the release key"
    else
      warn "$HERE is writable by the box user - not pinning a release key from it (TVBOX_TRUST_LOCAL_KEY=1 to accept)"
    fi
  fi

  systemctl daemon-reload 2>/dev/null || true
  # The grant matches netdev, the same group mirroring and the radio switch use.
  if id -nG "$TVBOX_USER" 2>/dev/null | tr ' ' '\n' | grep -qx netdev; then
    ok "system updates installed (tvbox-sysupdate, on request)"
  else
    usermod -aG netdev "$TVBOX_USER" 2>/dev/null &&
      warn "system updates installed; $TVBOX_USER added to netdev - REBOOT before the button will work" ||
      warn "system updates installed but $TVBOX_USER is not in netdev - the button will be denied"
  fi
else
  warn "tvbox-sysupdate helper or unit missing - system updates unavailable"
fi

# A core dump is written by a root unit, so its time limit is root's to set. The
# session's own coredump_filter (session.sh) is what keeps dumps small; this is
# the ceiling for when it cannot, so the box can never be held for minutes by an
# app that crashed. Reasons in the file itself.
if [ -f "$HERE/coredump-tvbox-runtimemax.conf" ]; then
  install -d /etc/systemd/system/systemd-coredump@.service.d
  if install -m 644 "$HERE/coredump-tvbox-runtimemax.conf" \
    /etc/systemd/system/systemd-coredump@.service.d/10-tvbox-runtime-max.conf; then
    # The file being in place is not the same as the running manager knowing about
    # it, and the difference matters here: without the reload the next crash still
    # dumps under the old 5-minute limit.
    if systemctl daemon-reload 2>/dev/null; then
      ok "core dump time limit (20s) installed"
    else
      warn "core dump time limit written but daemon-reload failed; it applies at the next boot"
    fi
  else
    warn "could not install the core dump time limit"
  fi
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
if [ "$UNATTENDED" = 1 ]; then
  # This block reads its answer off the boot partition, and a system update runs
  # whenever the box user asks for one. Granting or revoking passwordless sudo is
  # an admin's decision made at the box, so it stays on the paths a person
  # drives: deploy.sh, a re-flash, or tvbox-firstboot. Today the boot partition
  # is root-owned and the box user cannot remount it writable (the udisks grant
  # is filesystem-mount only, deliberately not filesystem-mount-system) - this
  # keeps that from being the only thing standing between a Settings button and
  # a root shell.
  ok "sudo grant left as it is (unattended run)"
elif [ "$SUDO_CONF" = "true" ] || [ "$SUDO_CONF" = "1" ] || [ "$SUDO_CONF" = "yes" ] || [ -f "$BOOTP/tvbox-sudo" ]; then
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

# The box's own compositor. A general one composites the whole screen into one
# buffer, which at 4K is a GPU pass the Pi cannot afford next to the player's own;
# tvbox-wc puts the film on a display plane and the shell's translucent UI on an
# overlay above it, and does no per-frame GPU work while a film plays.
echo "==> compositor (tvbox-wc)"
if [ "$UNATTENDED" = 1 ]; then
  # A system update installs a release's ROOT half before that release's shell
  # has run once, and the OTA that follows can still roll the shell back after
  # three failed boots. There is no matching way back for the compositor: greetd
  # execs it directly, so a bumped tvbox-wc that verifies but does not run on
  # this box is a black screen with the rollback already spent - and the shell
  # drives modes, HDR, focus and typing over its socket with no version
  # negotiation at all (compositor.js `available()` is a stat).
  # So a compositor bump stays a re-flash or a deploy.sh run until the session
  # can fall back to the previous binary.
  ok "compositor left as it is (unattended run)"
elif [ -f "$HERE/install-compositor.sh" ]; then
  sh "$HERE/install-compositor.sh" && ok "tvbox-wc" \
    || bad "compositor install failed - the box will have no session"
else
  bad "install-compositor.sh missing - the box will have no session"
fi
# Everything below this line replaces the box's session, and none of it may run
# unless there is something to replace it WITH. A provision that could not install
# the compositor (no network, an unpublished tag, a failed build) would otherwise
# point greetd at a binary that is not there and purge the one that is - a box that
# survives until its next reboot and then boots to nothing.
# "Something to replace it with" means a binary that runs, not a file that exists:
# a failed install (no network, an unpublished tag) leaves whatever was there
# before, which may be nothing but a truncated download from an earlier attempt.
HAVE_COMPOSITOR=no
[ -x /usr/local/bin/tvbox-wc ] && /usr/local/bin/tvbox-wc --version >/dev/null 2>&1 && HAVE_COMPOSITOR=yes

# greetd starts the compositor, which starts the session. The wrapper is root-owned
# so this config never has to change; what it runs (~/.tvbox/session.sh) is
# user-space and therefore OTA-updatable.
if [ "$HAVE_COMPOSITOR" = no ]; then
  warn "no compositor installed - leaving the session as it is"
elif [ -f "$HERE/tvbox-session" ] && install -m 755 -o root -g root \
    "$HERE/tvbox-session" /usr/local/bin/tvbox-session; then
  # A Lite install has greetd's own default config (or none at all), which starts
  # a text greeter, and a box that never had our session has nothing to rewrite.
  # Write one rather than reporting success over a config that points elsewhere.
  if [ ! -f /etc/greetd/config.toml ] || ! grep -q "^command = " /etc/greetd/config.toml; then
    install -d /etc/greetd
    cat > /etc/greetd/config.toml <<GREETD
[terminal]
vt = 7

[default_session]
command = "tvbox-wc -- /usr/local/bin/tvbox-session"
user = "$TVBOX_USER"
GREETD
    systemctl enable greetd >/dev/null 2>&1 || true
  fi
  if [ -f /etc/greetd/config.toml ]; then
    # Only the shapes a previous version of THIS project wrote, anchored to the
    # whole value. A pattern that matched any command line merely containing
    # "labwc" would also rewrite a greeter someone set up themselves - e.g.
    # `command = "labwc -C /etc/greetd -c labwc-gtkgreet"` - and leave the box with
    # no way to log in but ours.
    sed -i -E 's@^command = "(/usr(/local)?/bin/)?(labwc|tvbox-compositor)"@command = "tvbox-wc -- /usr/local/bin/tvbox-session"@' \
      /etc/greetd/config.toml
    sed -i -E 's@^command = "tvbox-wc( --.*)?"@command = "tvbox-wc -- /usr/local/bin/tvbox-session"@' \
      /etc/greetd/config.toml
  fi
  if grep -q '^command = "tvbox-wc' /etc/greetd/config.toml 2>/dev/null; then
    ok "session (greetd -> tvbox-wc -> tvbox-session)"
  else
    # Somebody else's greeter, left alone on purpose - but then this box does not
    # start our session, and saying [ok] here would hide that.
    warn "greetd starts something else - $(grep '^command = ' /etc/greetd/config.toml 2>/dev/null | head -1)"
  fi
else
  bad "tvbox-session missing - greetd has nothing to start"
fi

# Retire the compositor this box may have been provisioned with, packages and all.
# Leaving them installed is not neutral: greetd could be pointed back at labwc by
# any later edit, the patched build under /usr/local sits ahead of the distro one
# on PATH forever, and the box would carry two compositors' worth of attack
# surface for one that runs. There is exactly one compositor here now.
#
# Purge is safe on this baseline (checked: the six are leaves, and libwlroots goes
# with labwc as an orphan) and it is deliberately NOT fatal - an apt that cannot
# reach the network must not fail a provision whose real work is already done.
echo "==> retiring labwc (one compositor on this box, not two)"
if [ "$HAVE_COMPOSITOR" = no ]; then
  warn "no compositor installed - keeping labwc, the box still needs a session"
else
for stale in /usr/local/bin/labwc /usr/local/bin/tvbox-compositor \
    /usr/local/share/tvbox/labwc-planes.stamp; do
  [ -e "$stale" ] && rm -rf "$stale"
done
rm -rf /usr/local/lib/aarch64-linux-gnu/libwlroots* /etc/xdg/labwc
DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq \
  labwc wlrctl wlr-randr kanshi swaybg grim >/dev/null 2>&1 \
  && DEBIAN_FRONTEND=noninteractive apt-get autoremove -y --purge -qq >/dev/null 2>&1 \
  && ok "labwc and its tools purged" \
  || warn "could not purge the old compositor packages - nothing starts them either way"
fi

echo
if [ "$FAIL" = 0 ]; then
  echo "==> provision OK. Group changes need a reboot to reach the user session."
else
  echo "==> provision FAILED on one or more hard steps (see [FAIL] above) - fix and re-run."
fi
exit $FAIL
