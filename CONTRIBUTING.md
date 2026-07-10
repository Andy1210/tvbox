# Contributing to tvbox

Thanks for helping! tvbox is a FireTV-style TV box for the Raspberry Pi 5 -
a fullscreen web launcher + native `mpv` playback, driven entirely by the TV
remote over HDMI-CEC.

## The fastest way to contribute: an app

Most contributions don't need to touch shell or launcher code at all. Apps are
**self-contained packages** (a manifest plus, where needed, a `web/` UI and a
host `plugin.js`) that live in the
**[tvbox-apps registry](https://github.com/Andy1210/tvbox-apps)**, not in this
repo. The full authoring guide - package layout, manifest reference, the web UI
via `@tvbox/app-sdk`, the host plugin API - is
**[AUTHORING.md](https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md)**
in that registry; the manifest field reference is
**[docs/app-manifest.md](docs/app-manifest.md)** and the JSON Schema is
[docs/app-manifest.schema.json](docs/app-manifest.schema.json). Validate a
manifest with:

```sh
npx ajv-cli validate -s docs/app-manifest.schema.json -d my-app/manifest.json --spec=draft2020
```

Test it privately by dropping the package into `~/.tvbox/apps/<id>/` (or a bare
`~/.tvbox/apps/<id>.json` manifest) on your box - it appears on HOME live, no
restart. To publish for everyone, open a PR against the
[tvbox-apps registry](https://github.com/Andy1210/tvbox-apps) per its
AUTHORING.md; merge review is the trust boundary.

## Dev setup

- **Launcher** (React/TS/Vite): `cd launcher && npm install && npm run dev`.
  The dev server runs without a shell (static fallback app list).
  Before a PR: `npm run typecheck && npm test && npm run build`.
- **Shell** (Electron): `cd shell && npm install && npm start` (expects a
  Wayland session; on a dev machine most features degrade gracefully).
- **On a Pi**: `./deploy/deploy.sh <pi-ssh-host>` - idempotent, safe to re-run.

## Ground rules

- **i18n**: no hardcoded UI strings in the launcher - add keys to _both_
  `launcher/src/locales/en.json` and `hu.json` (a test fails on drift). New
  languages: add `src/locales/<id>.json` + register it in `src/lib/i18n.tsx`.
- **No root at runtime**: root is confined to `deploy/provision.sh` (one-time)
  and `tvbox deps` apt installs. Don't add `sudo` calls to the shell - if a
  feature seems to need one, it needs a udev/polkit grant in provision instead.
- **Capabilities are the boundary**: an app gets only the preload surfaces its
  manifest declares. Never widen a default.
- **Degrade, don't crash**: a missing binary/config greys a tile or shows a
  message; nothing should crash-loop on an unconfigured box.
- Match the style around you; comments explain _why_, not _what_.

## PRs

Keep them focused. Describe the TV/remote you tested with for CEC-related
changes (CEC quirks are very TV-specific). CI must pass: launcher
typecheck/tests/build, shell syntax, manifest schema, shellcheck.

## License

MIT - by contributing you agree your work is MIT-licensed too.
