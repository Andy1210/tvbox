#!/bin/sh
# Install the box's compositor, tvbox-wc (root; called by deploy/provision.sh and
# by the SD-image build).
#
# It is not a distro package and never will be: it is the tvbox's own compositor
# (https://github.com/Andy1210/tvbox-wc), and it exists because a general one
# composites everything into one buffer - at 3840x2160 that is a full-screen GPU
# pass per frame on top of the one the player already does, and a Pi 5 fits one of
# the two. This one hands the film to the display hardware instead.
#
# Two ways in, and which one applies is decided by compositor.version:
#
#   1. the release binary pinned in compositor.version, verified by sha256. This is
#      what a flashed box and a provisioned box get.
#   2. a source tree on the box (TVBOX_WC_SRC, default ~/tvbox-wc), built with
#      cargo. This is the development path.
#
# The two are alternatives, NOT a fallback chain. A box that pins a release gets
# that release or nothing: the source tree lives in the box user's home, so falling
# back to it would let anything running as that user - a user app's plugin.js is
# trusted Node, but only as the box user - choose the binary greetd execs as root
# at every boot, by planting a tree there and waiting for a download to fail.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
DEST=/usr/local/bin/tvbox-wc
BOX_USER="${SUDO_USER:-${TVBOX_USER:-}}"
[ -n "$BOX_USER" ] || BOX_USER=$(id -un)
BOX_HOME=$(getent passwd "$BOX_USER" | cut -d: -f6)
SRC="${TVBOX_WC_SRC:-$BOX_HOME/tvbox-wc}"

say() { echo "  $*"; }

installed_version() {
	[ -x "$DEST" ] || return 1
	"$DEST" --version 2>/dev/null | awk '{print $2}'
}

# 1) The pinned release.
TAG=""
SHA256=""
# Read as data, never sourced: this script runs as root and the file ships into the
# box user's home, where a user-space update (or a compromised app plugin, which
# runs as that user) could rewrite it. Sourcing would make it root's shell script.
if [ -f "$HERE/compositor.version" ]; then
	TAG=$(sed -n 's/^TAG="\([^"]*\)".*/\1/p' "$HERE/compositor.version" | head -1)
	SHA256=$(sed -n 's/^SHA256="\([^"]*\)".*/\1/p' "$HERE/compositor.version" | head -1)
fi
case "$TAG" in
	"") ;;
	*[!A-Za-z0-9._+-]*)
		echo "  compositor.version: not a tag: $TAG" >&2
		exit 1
		;;
	v[0-9]*) ;;
	*)
		echo "  compositor.version: not a tag: $TAG" >&2
		exit 1
		;;
esac
case "$SHA256" in
	"" | *[!0-9a-f]*)
		if [ -n "$SHA256" ]; then
			echo "  compositor.version: not a sha256" >&2
			exit 1
		fi
		;;
esac

if [ -n "$TAG" ] && [ -n "$SHA256" ]; then
	have=$(installed_version || true)
	if [ "$have" = "${TAG#v}" ]; then
		say "tvbox-wc $have already installed"
		exit 0
	fi
	url="https://github.com/Andy1210/tvbox-wc/releases/download/$TAG/tvbox-wc-aarch64"
	tmp=$(mktemp) || exit 1
	if ! curl -fsSL --retry 3 -o "$tmp" "$url"; then
		rm -f "$tmp"
		echo "  could not download $url" >&2
		exit 1
	fi
	got=$(sha256sum "$tmp" | cut -d" " -f1)
	if [ "$got" != "$SHA256" ]; then
		rm -f "$tmp"
		echo "  sha256 mismatch for $url (got $got, want $SHA256)" >&2
		exit 1
	fi
	if ! install -m 755 -o root -g root "$tmp" "$DEST"; then
		rm -f "$tmp"
		echo "  could not install to $DEST" >&2
		exit 1
	fi
	rm -f "$tmp"
	say "tvbox-wc $TAG installed from the release"
	exit 0
fi

# 2) A source tree on the box. Only reached when nothing is pinned.
if [ ! -f "$SRC/Cargo.toml" ]; then
	echo "  nothing pinned in compositor.version and no source tree at $SRC" >&2
	echo "  - the box has no compositor" >&2
	exit 1
fi

command -v cargo >/dev/null 2>&1 || {
	echo "  cargo is not installed - cannot build $SRC" >&2
	exit 1
}

# A 4 GB Pi 5 runs out of memory with a job per core.
say "building tvbox-wc from $SRC (this takes a few minutes)"
if ! su - "$BOX_USER" -c "cd '$SRC' && cargo build --release -j3" >/tmp/tvbox-wc-build.log 2>&1; then
	echo "  build failed - see /tmp/tvbox-wc-build.log" >&2
	tail -20 /tmp/tvbox-wc-build.log >&2
	exit 1
fi

# `install` follows a symlink at the source, and everything under $SRC belongs to
# the box user: a planted target/release/tvbox-wc -> /etc/shadow would be copied
# out as mode 755 root:root by the root that runs this. Refuse anything that is not
# a regular file.
BUILT="$SRC/target/release/tvbox-wc"
if [ -L "$BUILT" ] || [ ! -f "$BUILT" ]; then
	echo "  $BUILT is not a regular file - refusing to install it" >&2
	exit 1
fi
if ! install -m 755 -o root -g root "$BUILT" "$DEST"; then
	echo "  could not install to $DEST" >&2
	exit 1
fi
# The exit status of this script is what provision.sh decides on, and `say` is an
# echo: without this the last word would always be "success".
[ -x "$DEST" ] || {
	echo "  $DEST is not there after installing it" >&2
	exit 1
}
say "tvbox-wc $(installed_version) installed from source"
