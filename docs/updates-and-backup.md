# Updates & backup

Three independent mechanisms keep a deployed box current and recoverable -
none of them ever reboots or interrupts playback on its own:

| Layer        | Mechanism                                                                                   | Files                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| tvbox itself | OTA self-update: versioned releases + `current` symlink flip, crash-count rollback          | [shell/updater.js](../shell/updater.js), [deploy/run-shell.sh](../deploy/run-shell.sh) |
| OS packages  | `unattended-upgrades` (install yes, **reboot never**) + a Settings hint when a reboot helps | [deploy/provision.sh](../deploy/provision.sh)                                          |
| App bundles  | nightly `flatpak update --user` timer                                                       | [deploy/tvbox-flatpak-update.timer](../deploy/tvbox-flatpak-update.timer)              |

Plus **backup/restore**: the box's settings as a password-encrypted file on
your phone ([shell/backup.js](../shell/backup.js)).

## OTA self-update (the tvbox software)

Everything is user-space (hard rule #1 - no root at runtime):

```text
~/.tvbox/
  shell/                 dev tree (deploy.sh target) - runs when `current` is absent
  versions/<v>/          one extracted release: shell/ + infra/ + manifest.json
  current -> versions/<v>   the active release (symlink)
  update/pending         "<prev> <new>" - written at flip, cleared by the first
                         healthy boot (commit); >3 boot attempts = rollback
  update/failed          a rollback happened (shown in Settings until retried)
  update/last            {from,to,at} of the last successful update
```

**Flow:** the shell checks a static feed (`update.json`) daily and on demand
(Settings → System & updates). Install = download tarball → sha256 verify →
extract to `versions/<v>` → reuse `node_modules` via hardlinks when the
lockfile is unchanged (else `npm ci`) → write `update/pending` → flip
`current` → restart the shell. `run-shell.sh` counts boot attempts while
`pending` exists; the launcher's first successful page load **commits** the
update (markers cleared, infra files synced, old versions pruned - the
previous one is kept). Three failed boots flip `current` back and record
`update/failed`.

**Auto-update** is ON by default (Settings toggle): applies between 03:00 and
06:00, only when nothing is playing (no mpv, no remote app, last now-playing
isn't `playing`) and never a version that already rolled back once.

**Infra files** (run-shell.sh, CEC bridge, systemd user units, `tvbox` CLI)
ship in the tarball's `infra/` and are installed only _after_ the new shell
booted healthy - a broken release can never replace the rollback machinery.
`provision.sh` changes still need a manual `sudo bash ~/.tvbox/provision.sh`
(mention it in the release notes when a release needs one).

**Feed** (`update.json`):

```json
{
  "feedVersion": 1,
  "version": "1.2.0",
  "url": "https://github.com/Andy1210/tvbox/releases/download/v1.2.0/tvbox-shell-1.2.0.tar.gz",
  "sha256": "…",
  "notes": { "en": "…", "hu": "…" }
}
```

Default feed URL: `https://github.com/Andy1210/tvbox/releases/latest/download/update.json`.
Self-host override on the box: `~/.tvbox/config.json` →
`{"update": {"feed": "http://<lan-host>/update.json"}}` (plain http allowed on
RFC1918/LAN only). `{"update": {"auto": false}}` disables auto-apply.

**Publishing a release:**

```sh
# 1. bump shell/package.json "version"  2. add the CHANGELOG.md section
# 3. commit  4. tag + push:
git tag v1.2.0 && git push origin v1.2.0
# release.yml packs + uploads update.json + tarball, then dispatches
# sd-image.yml, which attaches tvbox-v1.2.0.img.xz (~1.5 h later).
# Manual/LAN alternative:
./scripts/make-release.sh --out dist --base-url http://<lan-host>
```

**Dev deploys win over OTA:** `deploy.sh` deletes the `current` symlink, so a
box you rsync to runs the dev tree again (release dirs stay for the next OTA).
CLI on the box: `tvbox update [--check]`.

## OS updates - install everything, reboot nothing

`provision.sh` configures `unattended-upgrades` with Debian security + the
Raspberry Pi OS archive as origins and **`Automatic-Reboot "false"`** - a TV
box must never restart itself mid-movie. When an update wants a reboot
(`/var/run/reboot-required`), Settings → System & updates shows a hint and a
"Restart now" button (logind polkit, no root); the timing is always the
user's. Major OS jumps (Debian release upgrades) are intentionally NOT
in-place: back up to your phone, re-flash the SD image, restore.

## Backup & restore (phone, QR)

Settings → System & updates → "Backup / restore on phone (QR)". Same pairing
infrastructure as the IPTV/wallpaper phone pages (code-gated LAN server on
:8099, 5-min TTL). The phone page does both directions:

- **Save**: set a password → downloads `tvbox-<host>-<date>.tvbackup`
  (scrypt → AES-256-GCM; the file holds IPTV/Spotify/MQTT credentials and the
  parental PIN hash, so it is never written unencrypted).
- **Restore**: pick the file + password → the shell replaces `config.json`,
  rewrites the user app manifests (validated), restores Spotify tokens, parks
  the launcher's localStorage snapshot (locale, app order, onboarding) and
  restarts; the launcher applies the snapshot on boot and reloads.

Included: `config.json`, `~/.tvbox/apps/*.json`, Spotify account tokens,
launcher localStorage. NOT included (by design): app bundles/binaries
(reinstall via tile / `tvbox deps`), ambient wallpapers, web-app logins
(Plex/YouTube cookies live in per-app Electron partitions). Headless twin:
`tvbox backup <file> --password <pw>` / `tvbox restore <file> --password <pw>`.
