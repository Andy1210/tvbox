#!/usr/bin/env bash
# tvbox release packer - builds the launcher and produces the two OTA artifacts
# the box's updater consumes (shell/updater.js):
#
#   tvbox-shell-<version>.tar.gz   shell/ (launcher-dist built, no node_modules)
#                                  + infra/ (run-shell.sh, CEC bridge, units…)
#                                  + manifest.json {version, builtAt, git}
#   update.json                    the feed: {feedVersion, version, url, sha256, notes}
#
# Version = shell/package.json "version" - bump it there, then run this.
# CI (.github/workflows/release.yml) runs this on a v* tag and uploads both
# files as release assets; the box's default feed URL points at
# releases/latest/download/update.json. Self-hosting (LAN test loop): run it
# locally, serve the out dir over http, set config.json {"update":{"feed":
# "http://<host>/update.json"}} on the box.
#
# Release notes come from CHANGELOG.md (the current version's `### hu` /
# `### en` blocks - that's what the TV shows before installing); the
# --notes-* flags override it.
#
#   ./scripts/make-release.sh [--out DIR] [--base-url URL] [--skip-build]
#                             [--notes-en "…"] [--notes-hu "…"]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"    # tvbox/scripts
TVBOX="$(dirname "$HERE")"               # tvbox/

OUT="$TVBOX/dist"
BASE_URL=""
SKIP_BUILD=0
NOTES_EN=""
NOTES_HU=""
SIGN_KEY="${TVBOX_RELEASE_KEY_FILE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --notes-en) NOTES_EN="$2"; shift 2 ;;
    --notes-hu) NOTES_HU="$2"; shift 2 ;;
    --sign-key) SIGN_KEY="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# What revision of the ROOT half this tree's provision.sh installs. Read as DATA
# (anchored, digits only, never sourced) for the same reason install-compositor.sh
# parses compositor.version rather than dotting it in.
PROVISION_REVISION="$(sed -n 's/^PROVISION_REVISION=\([0-9]\{1,6\}\)$/\1/p' "$TVBOX/deploy/provision.sh" | head -1)"
[ -n "$PROVISION_REVISION" ] || { echo "no PROVISION_REVISION in deploy/provision.sh" >&2; exit 1; }

# The root payload must not have moved without the revision moving with it, or a
# box would satisfy `system:N` while missing what N added.
node "$HERE/provision_revision_check.js" || exit 1

VERSION="$(node -p "require('$TVBOX/shell/package.json').version")"
[ -n "$VERSION" ] || { echo "no version in shell/package.json" >&2; exit 1; }
# The tarball URL the feed points at. Default matches release.yml's assets.
[ -n "$BASE_URL" ] || BASE_URL="https://github.com/Andy1210/tvbox/releases/download/v$VERSION"
TARBALL="tvbox-shell-$VERSION.tar.gz"

if [ "$SKIP_BUILD" = 0 ]; then
  echo "==> building launcher -> shell/launcher-dist"
  ( cd "$TVBOX/launcher" && npm run build >/dev/null )
fi
[ -d "$TVBOX/shell/launcher-dist" ] || { echo "shell/launcher-dist missing - build the launcher first" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> staging release $VERSION"
rsync -a --exclude node_modules --exclude apps-data --exclude '*.log' \
  --exclude electron-web-client "$TVBOX/shell" "$STAGE/"
# infra/ comes from the ONE shared list (deploy/infra.list) via copy-infra.sh,
# so the OTA tarball can never drift from the SD image / dev deploy (this is how
# remote_input_bridge.py + tvbox-remote.service + cursor_idle_hide.py finally
# reach OTA boxes). Fail-closed: a missing infra file aborts the release.
"$HERE/copy-infra.sh" "$STAGE/infra"
GIT_SHA="$(git -C "$TVBOX" rev-parse --short HEAD 2>/dev/null || echo unknown)"
node -e "
  const fs = require('fs');
  fs.writeFileSync('$STAGE/manifest.json', JSON.stringify({
    version: '$VERSION', builtAt: new Date().toISOString(), git: '$GIT_SHA',
  }, null, 2) + '\n');
"

mkdir -p "$OUT"
tar -czf "$OUT/$TARBALL" -C "$STAGE" shell infra manifest.json
SHA256="$(sha256sum "$OUT/$TARBALL" | cut -d' ' -f1)"

NOTES_EN="$NOTES_EN" NOTES_HU="$NOTES_HU" node -e "
  const fs = require('fs');
  // Notes: explicit --notes-* wins; otherwise lift the '## $VERSION' section's
  // '### hu' / '### en' blocks out of CHANGELOG.md.
  const notes = {};
  if (process.env.NOTES_EN) notes.en = process.env.NOTES_EN;
  if (process.env.NOTES_HU) notes.hu = process.env.NOTES_HU;
  if (!notes.en || !notes.hu) {
    let md = '';
    try { md = fs.readFileSync('$TVBOX/CHANGELOG.md', 'utf8'); } catch (e) { /* no changelog */ }
    const sec = md.split(/^## /m).find((s) => s.split('\n')[0].trim() === '$VERSION');
    if (sec) {
      for (const block of sec.split(/^### /m).slice(1)) {
        const lang = block.split('\n')[0].trim();
        const text = block.split('\n').slice(1).join('\n').trim();
        if ((lang === 'en' || lang === 'hu') && text && !notes[lang]) notes[lang] = text;
      }
    }
    if (!notes.en && !notes.hu) console.warn('warning: no CHANGELOG.md section for $VERSION - the TV will show no release notes');
  }
  // What the box must already have for this release to be installable. It is
  // declared in shell/package.json, because that is the thing being released -
  // a release whose shell needs the compositor says so from the same file that
  // says which version it is. The box refuses anything it cannot satisfy
  // (REQUIREMENTS in shell/updater.js), which is how an OTA-only box is kept off
  // a release that needs something only a re-flash can install.
  // Absent means no requirements; anything else has to be a list of names. An ||
  // default would read false, 0 and the empty string as absent too, and the release
  // would then be offered to a box that cannot satisfy what it silently dropped.
  const pkg = JSON.parse(fs.readFileSync('$TVBOX/shell/package.json', 'utf8'));
  const requires = pkg.tvboxRequires === undefined || pkg.tvboxRequires === null ? [] : pkg.tvboxRequires;
  if (!Array.isArray(requires) || requires.some((r) => typeof r !== 'string' || !r.trim())) {
    console.error('tvboxRequires must be a list of requirement names');
    process.exit(1);
  }
  // A release may not ask for a root revision this tree does not carry: the box
  // cross-checks the staged provision.sh against what the feed announced and
  // refuses the pair, so this would ship a release nothing could ever install.
  const rev = $PROVISION_REVISION;
  for (const r of requires) {
    const m = /^system:(\d{1,6})\$/.exec(r);
    if (m && Number(m[1]) > rev) {
      console.error('tvboxRequires asks for system:' + m[1] + ' but deploy/provision.sh is revision ' + rev);
      process.exit(1);
    }
  }
  if (!requires.some((r) => /^system:/.test(r))) {
    console.warn('note: this release declares no system: requirement, so a box will not run its root half (deploy/provision.sh is revision ' + rev + ')');
  }
  fs.writeFileSync('$OUT/update.json', JSON.stringify({
    feedVersion: 1,
    version: '$VERSION',
    url: '$BASE_URL/$TARBALL',
    sha256: '$SHA256',
    publishedAt: new Date().toISOString(),
    // What this release's provision.sh would install. Informational for the UI;
    // what actually GATES the shell install is a system: entry in requires.
    // tvbox-sysupdate refuses a release whose staged provision.sh does not carry
    // this number, which catches a feed built from a different tree.
    systemRevision: rev,
    ...(requires.length ? { requires } : {}),
    ...(Object.keys(notes).length ? { notes } : {}),
  }, null, 2) + '\n');
"

# The feed is signed HERE, over the bytes just written, and never regenerated
# afterwards: it carries a publishedAt, so re-running this script produces
# different bytes and any signature made from a second run would never verify.
#
# Only the ROOT half needs the signature - tvbox-sysupdate refuses a feed it
# cannot verify against a key pinned in /etc. The shell's own OTA still installs
# from an unsigned feed (a self-hosted LAN test loop has no key), so an unsigned
# release is a release whose root half can never run, not a broken one.
if [ -n "$SIGN_KEY" ]; then
  [ -f "$SIGN_KEY" ] || { echo "signing key not found: $SIGN_KEY" >&2; exit 1; }
  openssl pkeyutl -sign -inkey "$SIGN_KEY" -rawin -in "$OUT/update.json" -out "$OUT/update.json.sig.bin"
  openssl base64 -A -in "$OUT/update.json.sig.bin" -out "$OUT/update.json.sig"
  rm -f "$OUT/update.json.sig.bin"
  # Verify what we are about to publish with the PUBLIC key the boxes carry, not
  # with the private one: a mismatched pair produces a feed that every box in the
  # field rejects, and there is no way to notice that from here otherwise.
  if [ -f "$TVBOX/deploy/release-key.pem" ]; then
    openssl base64 -d -A -in "$OUT/update.json.sig" -out "$OUT/.sigcheck"
    openssl pkeyutl -verify -pubin -inkey "$TVBOX/deploy/release-key.pem" -rawin \
      -in "$OUT/update.json" -sigfile "$OUT/.sigcheck" >/dev/null \
      || { rm -f "$OUT/.sigcheck"; echo "the signature does not verify against deploy/release-key.pem - wrong signing key?" >&2; exit 1; }
    rm -f "$OUT/.sigcheck"
  fi
  echo "==> $OUT/update.json.sig  (signed, system updates enabled)"
else
  rm -f "$OUT/update.json.sig"
  echo "warning: no signing key (--sign-key / TVBOX_RELEASE_KEY_FILE) - this feed is UNSIGNED," >&2
  echo "         so boxes will install the shell but refuse its root half." >&2
fi

echo "==> $OUT/$TARBALL"
echo "==> $OUT/update.json  (version $VERSION, sha256 $SHA256)"
