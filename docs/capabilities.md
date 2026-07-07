# Capabilities - the tvbox app SDK

A tvbox app is a **package** - a manifest plus, where it needs them, its own web
UI and a host plugin. For a SANDBOXED app, what it is _allowed to do_ is the list
in `runtime.capabilities` - the security boundary. This page is the capability
reference and the model behind it: how an app can be powerful (play video, fetch
a feed, persist state) **without** being trusted with the host process.

The guiding idea: **"complex" should not mean "arbitrary native code."** A
capability is a narrow, brokered API the shell hands the app through its
preload bridge - the app calls it, the shell enforces the rules. So a
Live-TV-class UI (custom UI + a real player + an EPG feed) can be a sandboxed
capability app with no `service` plugin (the shipped Live TV app does use a
plugin, for its IPTV data proxy - but it needn't have).

## The three app tiers

| Tier                            | What it is                                                                                                                            | Trust                                                                                               | Distribution                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **1 - Remote/static webclient** | A site or a static bundle, capability-scoped. YouTube, Jellyfin, Plex.                                                                | Sandboxed (isolated window; static bundles run in the main window today - see _Where an app runs_). | Curated registry (merge-reviewed).                                                           |
| **2 - Capability app**          | Same sandbox, richer brokered APIs: `player`, `fetch`, `storage`, … A community IPTV/dashboard/media app.                             | Sandboxed; reaches only the brokers it declared, only its declared `origins`.                       | Curated registry (merge-reviewed).                                                           |
| **3 - Privileged / native**     | A `service` plugin (Node in the host) or a `requires.download` daemon. Spotify (librespot), Live TV (IPTV proxy), anything host-side. | **Full host trust.**                                                                                | Curated registry - merge-review is the trust boundary. `requires.aptRepo` is never accepted. |

The registry ([tvbox-apps](https://github.com/Andy1210/tvbox-apps)) is
**curated**: every app is merge-reviewed (the review - not a sandbox - is the
trust boundary, like Kodi's official repo), so it accepts all three tiers,
including a Tier 3 package that ships a `service` plugin. The sandbox still bounds
Tier 1/2 apps regardless of review; the one hard line is `requires.aptRepo` (a
third-party root apt source), which is never accepted - ship a no-root
`requires.download` binary instead.

## Capability reference

Declared per app in `runtime.capabilities` (default `["nav"]`). Omitting a
capability must never grant it - the boundary fails closed.

| Capability        | Grants (`window.tvbox.*`)                                           | Notes                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav`             | `launch(id)`, `home()` (+ `onNotify`/`onCommand`, main window only) | Universal; every app has it. `onNotify`/`onCommand` currently fire only for the launcher/main window - the isolated window doesn't receive them yet.        |
| `player`          | `play(url)`, `stop()`, `pip(on, rect)`, `onPlayer(cb)`              | Drives the shared `mpv`. App-agnostic - the shell plays a URL on the app's behalf; the app never spawns anything. Needs `mpv` on the box (`tvbox deps`).    |
| `fetch`           | `fetch(url, opts) → { ok, status, headers, body }`                  | Scoped server-side data proxy. **Only reaches the hosts in `runtime.origins`.** The sandbox-safe way to read a cross-origin JSON/M3U/XMLTV feed. See below. |
| `storage`         | `storage.get/set/remove(key[, value])`                              | A small, shell-owned, per-app key/value store (persisted, size-capped, never cross-app).                                                                    |
| `config`          | (launcher-internal)                                                 | First-party surface; not for third-party apps.                                                                                                              |
| `input`, `system` | reserved                                                            | Declared in the schema, not yet implemented.                                                                                                                |

### `fetch` - the data-proxy capability

A sandboxed app can't make cross-origin requests (CORS) or comfortably parse a
big feed. `fetch` lets it ask the shell to do the request, locked to the hosts
it declared:

```jsonc
{
  "id": "my-iptv",
  "type": "webclient",
  "runtime": {
    "serve": "remote",
    "url": "https://my-iptv.example/app/",
    "origins": ["my-iptv.example", "epg.example"],
    "capabilities": ["nav", "player", "fetch"],
  },
}
```

```js
// in the app:
const r = await window.tvbox.fetch("https://epg.example/xmltv.xml");
if (r.ok) parseXmltv(r.body); // then window.tvbox.play(streamUrl)
```

Enforced in the shell ([`shell/appfetch.js`](../shell/appfetch.js)):

- **Origin-locked** - the URL host must equal or be a subdomain of a declared
  `origins` entry; an app with no `origins` can't `fetch` at all.
- **Protocol** - https everywhere; plain http only to a declared **private/LAN**
  host (a self-hosted server the user opted into). Cloud-metadata hosts are
  hard-denied even if declared.
- **No ambient credentials** - cookies are never sent, `Set-Cookie` never
  returned. Request headers are allowlisted (no `Cookie`/`Host`/`Referer`).
- **Bounded** - GET/POST/HEAD only; 10 s timeout; 5 MB response cap; 256 KB
  request-body cap; ≤3 redirects, each hop re-validated against the allowlist.

Because the manifest is user-visible and user-installed, and the box is a home
LAN device, this mirrors the trust already granted to a remote app's declared
navigation `origins` - with request/response hardening on top.

## Where an app runs (the isolation model)

Two windows, by trust:

- **Isolated window** (`contextIsolation` + `sandbox` on, no Node): remote apps
  live here. A **capability app** (declares caps beyond `nav`) additionally gets
  the sandbox-safe [`preload-app.js`](../shell/preload-app.js), which exposes
  _only_ its granted brokers over `contextBridge`. A plain remote site (YouTube)
  gets no preload at all - unchanged.
- **Main window** (`contextIsolation: false`, Node-capable preload): the
  launcher and local **`static` bundles** (e.g. Plex, which needs the QWebChannel
  bridge). This is a trusted context, so a `static` bundle from the
  registry is a step above a remote app - treat `serve: static` store apps as
  needing review until they run in the isolated window too.

## Roadmap

The capability model is deliberately additive - a new capability is a new
broker, gated the same way, and a manifest that doesn't ask for it is
unaffected. Known next steps:

- **`player` for isolated capability apps.** Playback compositing (the
  transparent overlay with `mpv` behind) is currently tied to the main window,
  so a _remote_ capability app can `fetch`/`storage` today but can't yet drive
  `mpv` in its own window. Wiring the shared player into the isolated window is
  what makes a full **Live-TV-class app** shippable through the curated registry.
  It needs on-device validation (window/video behaviour) before it ships.
- **Static bundles in the isolated window**, so a `serve: static` store app is
  sandboxed like a remote one (removing the review caveat above).

> When you add or wire a capability, validate it on a real box with the first
> app that uses it - the broker logic is unit-tested
> ([`shell/appfetch.test.js`](../shell/appfetch.test.js)), but the window/preload
> path only truly exercises on device.
