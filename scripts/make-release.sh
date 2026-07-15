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
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --notes-en) NOTES_EN="$2"; shift 2 ;;
    --notes-hu) NOTES_HU="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

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
  fs.writeFileSync('$OUT/update.json', JSON.stringify({
    feedVersion: 1,
    version: '$VERSION',
    url: '$BASE_URL/$TARBALL',
    sha256: '$SHA256',
    publishedAt: new Date().toISOString(),
    ...(Object.keys(notes).length ? { notes } : {}),
  }, null, 2) + '\n');
"

echo "==> $OUT/$TARBALL"
echo "==> $OUT/update.json  (version $VERSION, sha256 $SHA256)"
