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
SOFT="jq flatpak kanshi curl git unzip ca-certificates gcc libc6-dev swaybg fonts-dejavu-core grim"
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

[Install]
WantedBy=multi-user.target
WCEOF
systemctl daemon-reload 2>/dev/null || true
systemctl enable tvbox-wifi-country.service >/dev/null 2>&1 && ok "wifi country unit" || warn "wifi country unit enable failed"
# apply immediately too - provision runs as root anyway
/usr/local/sbin/tvbox-wifi-country && ok "wifi country applied" || warn "wifi country apply failed (raspi-config missing?)"

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
