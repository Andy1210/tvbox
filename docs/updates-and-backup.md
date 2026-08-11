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
(Settings → System → Software update). Install = download tarball → sha256 verify →
extract to `versions/<v>` → reuse `node_modules` via hardlinks when the
lockfile is unchanged (else `npm ci`) → write `update/pending` → flip
`current` → restart the shell. `run-shell.sh` counts boot attempts while
`pending` exists; the launcher's first successful page load **commits** the
update (markers cleared, infra files synced, old versions pruned - the
previous one is kept). Three failed boots flip `current` back and record
`update/failed`.

**A release can demand what an update cannot install.** OTA is user-space by
design, so a version that needs something root put there - the compositor, the
session greetd starts, an apt package - must not install itself into a box that
has not been re-provisioned. The feed says so with an optional
`requires: ["compositor"]`, and a box that cannot satisfy it never offers the
update: Settings shows "needs the box to be set up again" instead of pretending
to be up to date. Unknown requirement names count as unmet, so an older shell
that has never heard of a requirement refuses rather than guesses. Requirements
live in `REQUIREMENTS` in [shell/updater.js](../shell/updater.js).

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

## Flatpak-backed apps (RetroArch, Plex)

Some apps are not only a package from the registry - they depend on a flatpak, in
one of two ways:

| how                                                            | example                    | what "update" means                                            |
| -------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------- |
| `requires.flatpak` - the app RUNS it                           | RetroArch (a `native` app) | updating the flatpak IS updating the app                       |
| `install.source.flatpak` - its web bundle is EXTRACTED from it | Plex                       | the flatpak moves, then the extracted copy has to be refreshed |

Three things move them:

- **`tvbox-flatpak-update.timer`** (nightly, 03:30 + jitter) runs
  `flatpak update --user` for every ref. This is the normal path and needs no
  interaction.
- **The store's update button.** Settings → Apps → App Store → the app: alongside the
  registry version it shows the flatpak's own version and offers to update it now.
  That runs `tvbox flatpak-update <id>` out of process (a flatpak is hundreds of
  MB) and reports whether anything actually changed - decided by the ref's commit
  before and after, since a rebuild can ship new files under the same version.
- **The bundle refresh.** An extracted bundle is a copy, so it does not follow the
  flatpak. What a bundle came from is recorded in
  `~/.tvbox/apps-data/.sources/<id>.json`; when the flatpak's commit no longer
  matches, the shell re-extracts it (`tvbox install <id> --force`) two minutes
  after boot and every six hours, only while the box is idle. A manual flatpak
  update does it immediately, in the same action.

`tvbox flatpak-update <id>` and `tvbox install <id> --force` are the CLI
equivalents of the last two.

## OS updates - install everything, reboot nothing

`provision.sh` configures `unattended-upgrades` with Debian security + the
Raspberry Pi OS archive as origins and **`Automatic-Reboot "false"`** - a TV
box must never restart itself mid-movie. When an update wants a reboot
(`/var/run/reboot-required`), Settings → System → Software update shows a hint and a
"Restart now" button (logind polkit, no root); the timing is always the
user's. Major OS jumps (Debian release upgrades) are intentionally NOT
in-place: back up to your phone, re-flash the SD image, restore.

## Backup & restore (phone, QR)

Settings → System → Backup. Same pairing
infrastructure as the IPTV/wallpaper phone pages (code-gated LAN server on
:8099, 5-min TTL). The phone page does both directions:

- **Save**: set a password → downloads `tvbox-<host>-<date>.tvbackup`
  (scrypt → AES-256-GCM; the file holds IPTV/Spotify/MQTT credentials and the
  parental PIN hash, so it is never written unencrypted).
- **Restore**: pick the file + password → the shell replaces `config.json`,
  rewrites the user app manifests (validated), restores each app's own storage
  and the Spotify tokens, parks the launcher's localStorage snapshot (locale,
  app order, onboarding) and restarts; the launcher applies the snapshot on boot
  and reloads. The apps themselves come back afterwards - see below.

Included: `config.json`, `~/.tvbox/apps/*.json`, `~/.tvbox/appdata/*.json` (the
`storage` capability's per-app data), Spotify account tokens, launcher
localStorage, and the **list of installed app ids**. NOT included (by design):
ambient wallpapers and web-app logins (Plex/YouTube cookies live in per-app
Electron partitions). Headless twin: `tvbox backup <file>` / `tvbox restore
<file>`, which take the password from `TVBOX_BACKUP_PASSWORD`, from stdin with
`--password-stdin`, or by asking on a terminal with the echo off. Never from the
command line: any user on the box can read one out of `/proc` while it runs.

> **A clone gets the launcher's settings, not the apps' identities.** The
> localStorage snapshot is one store shared by the launcher and every local
> app (they are all one origin, and one of them is mounted at its root), so a
> CLONE restore replays only the `tvbox.`-prefixed keys. It is gated on the
> clone choice you make on the source box, because a re-flash and a clone both
> arrive with a fresh machine id and the target cannot tell them apart - and a
> re-flash has to come back verbatim. (The machine id is still read, but it can
> only ever say "this is the same install", never "this is a different box".) An app on the
> second box then finds nothing under its own key and mints or asks for its
> own. Without this, two boxes restored from one backup registered as a
> SINGLE Plex player, and the second box carried the first one's media login.

### Restore is a reconciliation, not a file copy

What a settings file cannot carry is everything large: a registry app's own
package (`plugin.js` + `web/…`), the flatpaks it runs, the sha256-pinned
binaries under `~/.tvbox/bin`, the web bundle extracted out of a flatpak. So the
backup carries the app **ids** and the box re-acquires the rest by itself
([shell/reconcile.js](../shell/reconcile.js)).

A restore writes a desired state to `~/.tvbox/reconcile.json`; the boot after the
restart reads it and works towards it, in this order and only while the box is
idle:

1. **app** - install from the registry anything the box doesn't have
   (`store.install`), because nothing about an app's needs is knowable before
   its manifest is on the box;
2. **deps** - its no-root deps: `requires.download` binaries and
   `requires.flatpak` apps (`tvbox deps <id> --download-only`). An **apt-only**
   dep is deliberately never planned - reconciliation stays rootless like the
   rest of the shell, and a step that always fails helps nobody;
3. **bundle** - re-extract a web-client bundle that isn't there
   (`tvbox install <id>`).

The launcher shows this as a progress card (`RestoreWatcher`, fed by
`GET /tvbox/api/reconcile/status`) so an empty HOME after a restore reads as
"downloading" rather than "broken". A `service` app's plugin is hot-loaded when
its step lands, so nothing restarts at the end.

Failures don't stop the run - each step is independent - and a failed run keeps the
desired state for up to **3 attempts** (the boot check plus two re-checks 15 min
apart), so a box restored while the registry was unreachable finishes once the
network is back. After that it stops asking.

An **interrupted** run is not a failed one and costs nothing: if the box stops
being idle mid-run (someone launched something on the box they just restored) the
remaining steps are skipped and the next tick picks them up, with the retry budget
untouched. Counting an interruption as a failure is how three ordinary evenings
would have thrown the desired state away for good.

To drive it by hand:
`tvbox reconcile` (the recorded desired state) or `tvbox reconcile --all` (every
installed app - useful outside a restore, e.g. a box whose bundles were wiped).

### An app's own files travel too

An app can declare files of its own that a backup should carry
(`backup` in its manifest - see [app-manifest.md](app-manifest.md)); the shell
knows nothing about any particular app. Two roots, both derived from the manifest
**on the restoring box**, never from the file:

- `backup.paths` - relative paths under the app's flatpak data dir
  (`~/.var/app/<ref>/`, when `backup.flatpak` names a ref the app already
  depends on) or its own bundle dir. Files or directories; symlinks are not
  followed.
- `backup.state` - sidecar files the app's plugin keeps directly in `~/.tvbox/`.
  Each name must be prefixed **`<id>-`** _and_ not be one of the shell's own
  sidecars (`RESERVED_STATE_FILES` in install.js). Both halves are needed: an app
  id is only constrained to `[a-z0-9_-]`, so a manifest calling itself `config`
  would otherwise match `config.json` - the file holding the box's credentials and
  the parental PIN hash.

Bounded, because the file travels through a phone: **8 MB total, 4 MB per file,
400 files**. Declaration order is priority order - what doesn't fit is named in
the log, never silently dropped. So save files and settings, not ROMs, cover art
or save states. Those go the other two ways: over the
[file server](file-server.md) from a computer, or - between two boxes - with
[app sharing](app-sharing.md), which is what an app's `shares` declaration is for.

App files are placed in passes: an app whose manifest came back with the config
gets them immediately, an app fetched from the registry gets them when its
reconciliation step lands.

## Setting up a second box from this one

Same phone page, one extra choice. The **save** card asks what the file is for:

- **This box** - an ordinary backup. A restore puts everything back verbatim,
  which is what a re-flashed box needs.
- **Another box** - a clone seed (`clone: true` in the payload, and `-clone-` in
  the file name). A restore re-derives the fields that identify a box rather than
  describe its setup.

The choice is made on the SOURCE box on purpose. The target cannot tell a
re-flash from a clone - both have a fresh machine id, and before setup the same
default hostname - and each wrong guess costs something: copying the identity
gives two boxes one MQTT topic segment (so each acts on the other's commands and
overwrites its now-playing) and one Spotify Connect name; re-deriving it on a
re-flash silently renames a box's Home Assistant entities.

What counts as identity lives in one place,
[shell/identity.js](../shell/identity.js): `mqtt.deviceId` and
`spotify.deviceName`. Both are **derived from the hostname** when unset, so a box
that never configured them is never ambiguous either. A clone re-derives a field
only when it still holds the source box's identity - a name the owner typed
themselves is a choice and survives.

The restore card also takes an optional **name for this box**, applied (via
`hostnamectl`, the polkit grant provision installs) BEFORE the config lands, so
the new box derives its identity from the name you just gave it. Leave it empty
and a clone onto a box with the same hostname still gets a unique identity - the
first four hex digits of its machine id are appended (`raspberrypi-9f3c`), which
is ugly but not shared; renaming the box in Settings re-derives it properly.

Still per-box and deliberately not carried: the hostname itself (unless asked
for), Wi-Fi credentials (NetworkManager's, not ours), and the paired Bluetooth
devices.
