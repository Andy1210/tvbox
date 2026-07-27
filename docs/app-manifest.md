# Writing an app

A tvbox app is a **package** in the [tvbox-apps registry](https://github.com/Andy1210/tvbox-apps):
a manifest plus (optionally) its own host `plugin.js` and `web/` UI - the Kodi
model. This page is the manifest field-by-field reference (companion to the
machine-readable [`app-manifest.schema.json`](app-manifest.schema.json), which
editors validate against and CI enforces).

> **The full authoring guide** - package layout, the web UI (`@tvbox/app-sdk`),
> the host plugin API, dependencies + the platform baseline, hosting a
> download-dep binary, versioning - lives in the registry repo:
> **[tvbox-apps/AUTHORING.md](https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md)**.

## Where manifests live

| Path                               | Who                                                       |
| ---------------------------------- | --------------------------------------------------------- |
| `~/.tvbox/apps/<id>.json`          | a manifest-only app (remote site, or bundle-recipe)       |
| `~/.tvbox/apps/<id>/manifest.json` | a package app that also ships files (`plugin.js`, `web/`) |

Apps live under `~/.tvbox/apps/` (installed from the registry) - there's no
in-shell first-party slot; the shell ships only the SDK. They **survive deploys**
and appear on the HOME screen **live** - the shell re-reads manifests on every
app-list fetch, so a dropped-in manifest appears immediately. The exceptions are
`service` plugins and the shell restart they imply (see below).

Validate yours locally before dropping it on the box:

```sh
npx ajv-cli validate -s docs/app-manifest.schema.json -d my-app.json --spec=draft2020
```

## The four app shapes

**1. Remote site** (simplest - YouTube is this): the shell opens the URL in an
isolated, hardened window (context isolation + sandbox on, no Node, navigation
locked to `origins`, popups denied).

```jsonc
{
  "id": "jellyfin",
  "manifestVersion": 1,
  "name": "Jellyfin",
  "type": "webclient",
  "status": "ready",
  "accent": "#00a4dc",
  "icon": "<svg viewBox='0 0 24 24'>…</svg>",
  "tagline": { "en": "Movies & TV", "hu": "Filmek és sorozatok" },
  "runtime": {
    "serve": "remote",
    "url": "http://jellyfin.local:8096", // http is OK for LAN hosts; public sites must be https
    "capabilities": ["nav"],
  },
}
```

For a self-hosted service whose URL differs per box, use `"urlConfig":
"jellyfin"` instead of `url` - the shell then reads `{ "jellyfin": { "baseUrl":
… } }` from `~/.tvbox/config.json` and the tile stays greyed ("needs setup")
until it's set.

**2. Static bundle** (Plex is this): `install` describes where the web client
comes from (flatpak / url tarball / git - all user-space, no root), the shell
serves it locally and can composite `mpv` video behind it. This is the shape
for a 10-foot web UI that needs a real video player.

**3. Package app with its own UI** (Live TV, Spotify): `serve: "local"` - the app
ships a built `web/` bundle (a standalone Vite app consuming `@tvbox/app-sdk`) plus
an optional host `plugin.js` (`service`), all in its `apps/<id>/` package. The
shell serves the bundle at `/<id>/` in the main window with the full `window.tvbox`
SDK. This is the shape for a rich 10-foot UI. See
[tvbox-apps/AUTHORING.md](https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md).

**4. Native app** (RetroArch is this): `type: "native"` - not a web app at all.
The app draws its own full-screen Wayland window and the shell launches and
supervises it, hiding its own windows while it runs. Use this only when the thing
you want already exists as a desktop program and re-implementing its UI as a web
app would be absurd.

```jsonc
{
  "id": "retroarch",
  "manifestVersion": 1,
  "name": "RetroArch",
  "type": "native",
  "status": "ready",
  "service": "retroarch", // a plugin, because a native app has no page to configure
  "pairing": [{ "kind": "roms", "label": { "en": "Upload games", "hu": "Játékok feltöltése" } }],
  "requires": { "flatpak": ["org.libretro.RetroArch"] }, // --user install, no root
  "runtime": {
    "native": { "flatpak": "org.libretro.RetroArch", "args": ["--fullscreen"] },
    "capabilities": [], // a native app has no renderer of ours, so no bridges
  },
}
```

How the shell launches it, how the Home button still works, and why killing a
flatpak app is not simply killing what you spawned: **[native-apps.md](native-apps.md)**.

## Field reference

Top level:

| Field             | Req | What                                                                               |
| ----------------- | --- | ---------------------------------------------------------------------------------- |
| `id`              | ✔   | `[a-z0-9_-]+`. Tile focus key, `apps-data/<id>` bundle dir, URL mount.             |
| `manifestVersion` |     | Format version; omitted = `1`. The shell skips versions it doesn't know.           |
| `name`, `tagline` | ✔ / | A string, or a `{ "<locale>": … }` map.                                            |
| `type`            | ✔   | `webclient` (a web package) \| `native` (its own full-screen window).              |
| `status`          | ✔   | `ready` \| `coming_soon` (teaser tile, not launchable).                            |
| `accent`          |     | Tile accent, **hex only** - anything else is dropped (it's interpolated into CSS). |
| `icon`            |     | Inline SVG. Rendered sandboxed (`<img>` data: URI) - it can't run script.          |
| `service`         |     | Shell-side plugin (below).                                                         |
| `version`         |     | Your app's version, informational.                                                 |
| `pairing`         |     | Phone actions the app offers (below).                                              |

`requires` - dependencies; a missing binary greys the tile with "needs X",
nothing crash-loops:

| Field            | What                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin`            | Binaries that must resolve on PATH (`~/.tvbox/bin` is on PATH).                                                                                                                                                                                    |
| `flatpak`        | **No-root install** of flathub app ids (`flatpak install --user`), so a missing one is installable from the UI like `download`. The box's own arch is used, and the install is retried: an app plus its runtime is a large pull that can time out. |
| `download`       | **No-root install** for `tvbox deps`: per-arch (`arm64`/`x64`) `{ url, sha256, extract? }`, verified and placed in `~/.tvbox/bin`. Prefer this whenever upstream ships static binaries.                                                            |
| `apt`            | Debian packages for `tvbox deps` - the one step that asks for sudo. Names are validated against Debian package-name policy.                                                                                                                        |
| `aptRepo`        | **Forbidden** in the registry - a third-party root APT source is risky and avoidable. Ship a `download` binary instead. (CI rejects it.)                                                                                                           |
| `disableService` | System services to disable after the apt install (when the shell supervises the daemon itself).                                                                                                                                                    |

`install` - the bundle recipe for `type: webclient` + `serve: static` (runs
user-space from the UI or `tvbox install <id>`):

| Field                             | What                                                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.type`                     | `flatpak` (ref installed `--user` from flathub) \| `url` (.tar.gz/.zip) \| `git` (shallow clone).                                                                                                                                            |
| `source.sha256` / `source.commit` | Optional but recommended pins: `url` sources may carry the archive's sha256 (verified before extraction); `git` sources a full commit sha (checked out after clone). `url`/`git` sources must be https, or plain http to a private/LAN host. |
| `extract`                         | Subpath inside the source that holds the web client.                                                                                                                                                                                         |
| `patch`                           | `[{ "op": "strip-script", "match": … }]` - remove `<script>` tags matching a substring from the entry HTML (e.g. Plex's Qt-only qwebchannel loader).                                                                                         |

`runtime` - how it's served and what it may touch:

| Field                 | What                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native`              | `type: native` only: `{ flatpak }` or `{ bin }`, plus `args`. Validated at manifest load AND at launch, with no shell involved. See [native-apps.md](native-apps.md).                                                                              |
| `serve`               | `local` (own web/ bundle at /<id>/) \| `static` (legacy root bundle) \| `remote` (live site).                                                                                                                                                      |
| `url` / `urlConfig`   | remote: literal URL, or the config section holding `baseUrl`.                                                                                                                                                                                      |
| `origins`             | remote: allowed hostnames (+subdomains). Defaults to the URL's host.                                                                                                                                                                               |
| `userAgent`           | remote: UA override (e.g. smart-TV UA for youtube.com/tv).                                                                                                                                                                                         |
| `entry`, `mount`      | static: entry file (default `index.html`); `"mount": "root"` serves at `/`.                                                                                                                                                                        |
| `textInput`           | `auto` (default) raises the box's typing screen when a text field takes focus; `off` for an app that ships its own on-screen keyboard.                                                                                                             |
| `cookies`             | Cookies placed in the app's own session before the first load, for a site whose language/market lever is a cookie (`[{ url, name, value }]`, `{locale}` placeholders allowed). Only for hosts in `origins`.                                        |
| `language`            | What language the app is told it runs in (`Accept-Language` + `navigator.language`). Default `"system"` = the box's UI language; a BCP-47 tag pins it. Never put a market in the app's URL - that stops following the setting.                     |
| `capabilities`        | **The security boundary.** Which preload-bridge surfaces the app gets: `nav`, `player`, `fetch`, `config`, `storage`, `display`, `input`, `system`. Default `["nav"]` - omitting it must never grant more. See [capabilities.md](capabilities.md). |
| `bridge`              | Renderer bridge adapter (`shell/bridges/<name>.js`); `qwebchannel` emulates Qt WebChannel for Plex HTPC.                                                                                                                                           |
| `player`              | `mpv-fullscreen` (video behind the transparent launcher) \| `mpv-overlay` (behind a transparent app element).                                                                                                                                      |
| `transparentSelector` | The app element made transparent to reveal mpv (e.g. `#media-container`).                                                                                                                                                                          |

## Shell-side plugins (`service`)

An app that needs host-side logic - a supervised daemon, an OAuth window,
custom HTTP routes - declares `"service": "<name>"` and ships `plugin.js` in its
package, next to its `manifest.json` (`~/.tvbox/apps/<id>/plugin.js`). There is
no separate in-shell plugin location: the plugin ships with the app package.

A plugin is a factory `(host) => ({ start?, stop? })`; the `host` surface
(routes, config, pairing, supervised children, `onConfigChange`, `navTo`, …) and
a worked example are in **[tvbox-apps/AUTHORING.md](https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md)**.
Plugins load **at shell boot only** (unlike manifests, which reload live) and
only when the app's `requires.bin` all resolve.

> **Trust note:** a plugin is Node code running in the shell's host process -
> installing one is code execution on the box. The registry is curated (every app
> is merge-reviewed - the review is the trust boundary, like Kodi's official
> repo), which is what lets a package carry a plugin. A `remote` app you host
> yourself gets only its declared, sandboxed capabilities. Review any plugin
> before dropping it into `~/.tvbox/apps`.
>
> **Before reaching for a plugin, check the capabilities.** A lot of what used
> to need host-side code - playing a stream (`player`), fetching + parsing a
> feed across origins (`fetch`), persisting settings (`storage`) - is a
> **sandboxed capability**, no plugin needed. A plugin is only for a background
> daemon, an OAuth window, or root-level work. The full capability model, the
> `fetch` API, and the app tiers are in **[capabilities.md](capabilities.md)**.

## Phone actions (`pairing`)

Some things simply cannot be done well with a remote: picking files, typing a
server password, entering credentials. And a `native` app has no screen of its own
on the box to put them on at all.

An app declares what it wants to offer, and the launcher renders a button per
entry in Settings, Apps:

```jsonc
"pairing": [
  { "kind": "roms",  "label": { "en": "Upload games",   "hu": "Játékok feltöltése" } },
  { "kind": "share", "label": { "en": "Network share",  "hu": "Hálózati megosztás" } },
],
```

Pressing one starts that pairing kind, and the TV shows a QR code plus a short URL
and a 4-digit code. The app's own `plugin.js` must register a provider for the kind
(`host.pairing.register(kind, { page, routes })`) and ships the page in its
package. The launcher knows nothing beyond the label: it starts the session and
draws the QR.

The pairing server is up only while that screen is open, and every route under it
is code-gated by the shell (`c` in the query for reads, `code` in the body for
writes). Requests are capped in size; a route that needs a bigger body says so
(`{ maxBody, handler }`).

## Checklist for a new app

1. Pick the shape: remote site → manifest only; needs mpv/local serving →
   static bundle; needs a daemon/OAuth → + plugin.
2. Write the manifest, validate against the schema.
3. Drop it in `~/.tvbox/apps/` on the box - the tile appears on HOME without a
   restart (plugin apps: restart the shell once).
4. Deps: prefer `requires.download` (no root); use `apt` only when there's no
   static build.
5. Test the remote flow: D-pad reachability, Back behaviour, and the Home
   double-tap returning to the launcher.
