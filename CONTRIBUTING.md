# Contributing to tvbox

Thanks for helping! tvbox is a FireTV-style TV box for the Raspberry Pi 5 -
a fullscreen web launcher + native `mpv` playback, driven entirely by the TV
remote over HDMI-CEC.

## The fastest way to contribute: an app

Most contributions don't need to touch shell or launcher code at all. An app
is a single JSON manifest - see **[docs/app-manifest.md](docs/app-manifest.md)**
for the reference and walkthrough, and validate with:

```sh
npx ajv-cli validate -s docs/app-manifest.schema.json -d shell/apps/my-app.json --spec=draft2020
```

Test it by dropping it into `~/.tvbox/apps/` on your box (appears live), then
PR it into `shell/apps/` if it's broadly useful.

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
