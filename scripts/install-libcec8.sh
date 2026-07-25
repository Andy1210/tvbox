#!/bin/sh
# Build + install libcec >= 8 from source (root; called by deploy/provision.sh).
# No distro ships it yet - Debian trixie and the RPi archive are on 7.x - but v8
# adds `cec-client --vendor-id`, which replaces the LD_PRELOAD vendor shim the
# CEC bridge otherwise needs for LG SIMPLINK.
#
# No-ops when the cec-client already on PATH understands --vendor-id, so it is
# safe to re-run. Run by deploy/provision.sh (dev deploys) and by the SD-image
# build inside the pi-gen chroot (image/stage-tvbox/01-tvbox/00-run.sh). NOT by
# OTA, which can never install packages - an OTA-only box keeps the shim, which
# still works. See the bridge docstring.
#
# /usr/local is outside apt, so unattended-upgrades will never patch this copy:
# re-run the script to move to a newer libcec.
set -eu

# Pinned commit, not just the tag: a tag is mutable, and this builds and installs
# as root. LIBCEC_REF/LIBCEC_COMMIT can override for a newer release.
REF="${LIBCEC_REF:-libcec-8.1.0}"
COMMIT="${LIBCEC_COMMIT:-e2e51d1f5196273a119a90f57d8c545d4253731c}"
PREFIX=/usr/local
CLIENT="$PREFIX/bin/cec-client"

if command -v cec-client >/dev/null 2>&1 && cec-client --help 2>&1 | grep -q -- "--vendor-id"; then
  echo "libcec already supports --vendor-id - nothing to do"
  exit 0
fi

# v8 dropped the p8-platform dependency; cmake + libudev + libxrandr is all it needs.
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cmake g++ libudev-dev libxrandr-dev git

SRC=$(mktemp -d)
# INT/TERM too: dash does not run an EXIT trap on a signal, and this build takes
# minutes - a Ctrl-C would otherwise leak the tree.
trap 'rm -rf "$SRC"' EXIT INT TERM

# stderr is deliberately NOT swallowed - a failing clone/build must be diagnosable.
git clone --depth 1 --branch "$REF" https://github.com/Pulse-Eight/libcec "$SRC/libcec" >/dev/null
GOT=$(cd "$SRC/libcec" && git rev-parse HEAD)
if [ "$GOT" != "$COMMIT" ]; then
  echo "libcec $REF is $GOT, expected $COMMIT - refusing to build (tag moved?)" >&2
  exit 1
fi

mkdir -p "$SRC/libcec/build"
cd "$SRC/libcec/build"
# HAVE_LINUX_API is OFF by default and is the one that matters here: without it
# the build has no /dev/cec* backend and cec-client reports "no serial port
# given. trying autodetect: FAILED" on the Pi.
cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DHAVE_LINUX_API=1 .. >/dev/null
make -j"$(nproc)" >/dev/null
make install >/dev/null
# Keep the record of what landed in /usr/local - the build tree (and with it the
# only uninstall list) is deleted by the trap moments from now.
if [ -f install_manifest.txt ]; then
  mkdir -p "$PREFIX/share/tvbox"
  cp install_manifest.txt "$PREFIX/share/tvbox/libcec-install-manifest.txt"
fi
ldconfig

# Verify by ABSOLUTE PATH, not via PATH lookup: this script runs under dash from
# provision.sh, the guard above already executed /usr/bin/cec-client, and dash
# caches that hash - a bare `cec-client` here would re-run the OLD binary and
# report failure on the very run that succeeded.
if "$CLIENT" --help 2>&1 | grep -q -- "--vendor-id"; then
  echo "libcec $REF installed to $PREFIX (--vendor-id available)"
else
  echo "WARNING: libcec built but $CLIENT has no --vendor-id" >&2
  exit 1
fi
# /usr/local/bin precedes /usr/bin in the default and systemd PATH, so the new
# client shadows the distro's libcec7 one without removing the package.
hash -r 2>/dev/null || true # drop the cached /usr/bin/cec-client before asking PATH
if [ "$(command -v cec-client || true)" != "$CLIENT" ]; then
  echo "WARNING: PATH still resolves cec-client to $(command -v cec-client) - the bridge may keep using the shim" >&2
fi
