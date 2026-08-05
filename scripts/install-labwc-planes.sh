#!/bin/sh
# Build + install a labwc that can put a fullscreen video on a display plane
# (root; called by deploy/provision.sh and by the SD-image build).
#
# Why this is not a distro package: a Wayland compositor composites everything
# into one buffer, and at 3840x2160 that is a full-screen GPU pass per frame on
# top of the one the player already does. A Pi 5 fits one of the two. The display
# hardware can compose the same scene for free - vc4 offers 48 overlay planes
# with alpha blending - but nothing in the wlroots stack asks it to. Ten patches
# do, and they are not in any release yet:
#
#   wlroots-0001  wlroots decides opacity from an allowlist of formats that names
#                 four of the 58 YCbCr formats it knows. P030 - what this hardware
#                 decodes 10-bit video into - is not one of them, so a video
#                 buffer reads as possibly-translucent and can never scan out.
#                 Adds that one format rather than inverting the rule: an unknown
#                 format must read as translucent, or a YUV format with alpha
#                 added later would silently have its alpha stripped.
#   wlroots-0002  the libliftoff interface never set the colour-management
#                 connector properties, and the guard that noticed rejected EVERY
#                 commit carrying an image description. This is the one that made
#                 the rest unreachable.
#   wlroots-0003  nothing publishes whether a backend can display output layers
#                 at all, so a compositor pays a frame with a missing surface to
#                 find out. Answered next to the timeline capability.
#   wlroots-0004  wlr_scene never drives output layers, so a surface above a
#                 fullscreen video forces the whole output through the renderer.
#   wlroots-0005  libliftoff searches plane assignments against a 1 ms deadline
#                 and reports none when it expires; the search is cached, so it
#                 can afford the time it needs.
#   wlroots-0006  the composition fallback is armed even when it is not needed,
#                 and on hardware with one plane at zpos 0 it takes the plane the
#                 video needs.
#   wlroots-0007  the liftoff interface refuses a commit whose cursor layer got
#                 no plane - including a MODESET, whose primary buffer is the
#                 empty one wlroots attaches for it. A resolution change then
#                 fails outright.
#   wlroots-0008  a compositor will not put an output in an HDR colour space
#                 unless the renderer reports an output colour transform. GLES2
#                 transforms nothing, but where the display engine composes
#                 there is nothing on the path to transform. (input_color_transform
#                 stays false: that one advertises wp_color_manager_v1, and a
#                 client that sees it renders wider and comes out washed out.)
#   wlroots-0009  direct scan-out compares the buffer's colour space with the
#                 output's, and without that protocol every buffer reads as
#                 sRGB - so an HDR output would refuse the very video it is for.
#                 Scan out on the compositor's policy instead: the output is
#                 only put in a colour space while content in it is playing.
#   labwc-0001    a failed render-format probe leaves the format at the last
#                 candidate it tried, and no swapchain can be created for it
#                 afterwards - the output stops drawing entirely.
#
# Measured on a Pi 5 with a 4K HEVC film and the Plex UI over it: the compositor's
# GPU time goes from 67% to 0% and dropped frames from ~17/s to none.
#
# Safe to re-run: it no-ops when the installed build already matches the pinned
# sources and this exact patch set. /usr/local is outside apt, so
# unattended-upgrades will never touch this copy - re-run the script to move on.
#
# NOT run by OTA, which can never install packages. An OTA-only box keeps the
# distro labwc and composites as before; the session wrapper (deploy/tvbox-
# compositor) picks whichever is actually installed.
set -eu

# wlroots 0.20 needs libxkbcommon >= 1.8, and Debian trixie ships 1.7.0, so this
# is part of the build rather than a dependency that can be installed. It lands in
# /usr/local like everything else here, which means every binary on the box links
# it - libxkbcommon keeps its soname across these releases, and the distro labwc
# this falls back to runs fine against it, but it is a system-wide change and not
# a private one.
XKBCOMMON_REF="${XKBCOMMON_REF:-xkbcommon-1.8.1}"
XKBCOMMON_COMMIT="${XKBCOMMON_COMMIT:-b3465081878e80ca6c11fe35c81787ec374ec15a}"
WLROOTS_REF="${WLROOTS_REF:-0.20.2}"
WLROOTS_COMMIT="${WLROOTS_COMMIT:-d783533489e1f75d6886c2ab5c5960090ef268f8}"
LABWC_REF="${LABWC_REF:-0.20.0}"
LABWC_COMMIT="${LABWC_COMMIT:-d5b5b765c7907a21a61081da6e3e1f38dbe17ff8}"

PREFIX=/usr/local
STAMP="$PREFIX/share/tvbox/labwc-planes.stamp"
# infra.list lands every shipped file flat next to this script (~/.tvbox/), so the
# patches are found by name rather than by directory.
HERE=$(cd "$(dirname "$0")" && pwd)

patches() {
  # Applied in name order; the numbering above is the order they must go in.
  find "$HERE" -maxdepth 1 -name "$1-0*.patch" 2>/dev/null | sort
}

WLROOTS_PATCHES=$(patches wlroots)
LABWC_PATCHES=$(patches labwc)
if [ -z "$WLROOTS_PATCHES" ] || [ -z "$LABWC_PATCHES" ]; then
  echo "labwc plane offload: patches missing next to $0 - nothing to do" >&2
  exit 0
fi

# The stamp is what makes this idempotent, and it has to cover the patches as
# well as the refs: editing a patch without moving a tag must still rebuild.
# Word splitting on the two patch lists is deliberate throughout: they are
# newline-separated paths this script generated itself.
# shellcheck disable=SC2086
WANT=$({ echo "$XKBCOMMON_COMMIT $WLROOTS_COMMIT $LABWC_COMMIT"; cat $WLROOTS_PATCHES $LABWC_PATCHES; } |
  sha256sum | cut -d" " -f1)
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ] && [ -x "$PREFIX/bin/labwc" ]; then
  echo "labwc plane offload already installed ($WANT) - nothing to do"
  exit 0
fi

echo "==> building wlroots $WLROOTS_REF + labwc $LABWC_REF with plane offload"

# meson/ninja plus the two stacks' build dependencies. libliftoff, libsfdo and
# libdisplay-info are all packaged - only the patched wlroots/labwc are not.
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  git meson ninja-build pkg-config \
  libwayland-dev wayland-protocols libdrm-dev libgbm-dev libegl-dev libgles-dev \
  libinput-dev libxkbcommon-dev libpixman-1-dev libseat-dev libudev-dev \
  libdisplay-info-dev libliftoff-dev hwdata \
  libxcb1-dev libxcb-composite0-dev libxcb-render0-dev libxcb-res0-dev \
  libxcb-ewmh-dev libxcb-icccm4-dev libxcb-errors-dev \
  libcairo2-dev libpango1.0-dev librsvg2-dev libsfdo-dev libpng-dev \
  bison libxml2-dev

SRC=$(mktemp -d)
# INT/TERM too: dash does not run an EXIT trap on a signal, and this build takes
# many minutes - a Ctrl-C would otherwise leak the tree.
trap 'rm -rf "$SRC"' EXIT INT TERM

fetch() { # repo ref commit dir
  # A tag is mutable and this builds and installs as root, so the commit decides.
  git clone --quiet --depth 1 --branch "$2" "$1" "$SRC/$4"
  got=$(cd "$SRC/$4" && git rev-parse HEAD)
  if [ "$got" != "$3" ]; then
    echo "$4 $2 is $got, expected $3 - refusing to build" >&2
    exit 1
  fi
}

apply() { # dir patches...
  dir=$1; shift
  for p in "$@"; do
    ( cd "$dir" && git apply --whitespace=nowarn "$p" ) || {
      echo "failed to apply $(basename "$p") - refusing to install a half-patched build" >&2
      exit 1
    }
  done
}

# Only when the distro's is too old: replacing a working system library is not
# something to do for the sake of tidiness.
have_xkb=$(pkg-config --modversion xkbcommon 2>/dev/null || echo 0)
if [ "$(printf "1.8.0\n%s\n" "$have_xkb" | sort -V | head -1)" != "1.8.0" ]; then
  echo "==> libxkbcommon $have_xkb is older than 1.8 - building $XKBCOMMON_REF"
  fetch https://github.com/xkbcommon/libxkbcommon.git \
    "$XKBCOMMON_REF" "$XKBCOMMON_COMMIT" xkbcommon
  meson setup "$SRC/xkbcommon/build" "$SRC/xkbcommon" \
    --prefix="$PREFIX" --libdir="lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)" \
    --buildtype=release -Denable-docs=false -Denable-wayland=false \
    -Denable-x11=false -Denable-xkbregistry=false
  ninja -C "$SRC/xkbcommon/build"
  ninja -C "$SRC/xkbcommon/build" install
  ldconfig
fi

fetch https://gitlab.freedesktop.org/wlroots/wlroots.git \
  "$WLROOTS_REF" "$WLROOTS_COMMIT" wlroots
apply "$SRC/wlroots" $WLROOTS_PATCHES
meson setup "$SRC/wlroots/build" "$SRC/wlroots" \
  --prefix="$PREFIX" --libdir="lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)" \
  --buildtype=release -Dexamples=false
ninja -C "$SRC/wlroots/build"
ninja -C "$SRC/wlroots/build" install
ldconfig

fetch https://github.com/labwc/labwc.git "$LABWC_REF" "$LABWC_COMMIT" labwc
apply "$SRC/labwc" $LABWC_PATCHES
# --wrap-mode=nofallback is load-bearing: without it meson quietly builds labwc's
# own wlroots subproject, and the compositor that comes out has none of the above.
PKG_CONFIG_PATH="$PREFIX/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)/pkgconfig" \
meson setup "$SRC/labwc/build" "$SRC/labwc" \
  --prefix="$PREFIX" --libdir="lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)" \
  --buildtype=release --wrap-mode=nofallback
ninja -C "$SRC/labwc/build"
ninja -C "$SRC/labwc/build" install
ldconfig

# The stamp is written last, so an interrupted build is retried rather than
# mistaken for a finished one - and the session wrapper reads it to decide
# whether this box has a compositor that can offload at all.
install -d "$(dirname "$STAMP")"
printf "%s" "$WANT" > "$STAMP"

echo "labwc plane offload installed: $("$PREFIX/bin/labwc" --version | head -1)"
