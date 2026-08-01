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

| Capability | Grants (`window.tvbox.*`)                                                                                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav`      | `launch(id)`, `home()` (+ `onNotify`/`onCommand`, main window only)                                                                                                      | Universal; every app has it. `onNotify`/`onCommand` currently fire only for the launcher/main window - the isolated window doesn't receive them yet.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `player`   | `play(url, streams?)`, `stop()`, `pip(on, rect)`, `tracks()`, `setTrack(type, id)`, `selectStreams({audio, sub, subFile})`, `setPlayerProp(name, value)`, `onPlayer(cb)` | Drives the shared `mpv`. App-agnostic - the shell plays a URL on the app's behalf; the app never spawns anything. Needs `mpv` on the box (`tvbox deps`). `streams`/`selectStreams` take 0-based ordinals within each track type (`sub: -1` = off, `subFile` = a sidecar subtitle URL) so an app that resolved its streams server-side can say so; `setPlayerProp` reaches an allowlisted set of mpv properties (`sub-delay`, `audio-delay`, `speed`, `volume`, `sub-scale`, `sub-pos`, `sub-visibility`, `sub-color`, `sub-border-color`) in mpv's own units. |
| `fetch`    | `fetch(url, opts) → { ok, status, headers, body }`                                                                                                                       | Scoped server-side data proxy. **Only reaches the hosts in `runtime.origins`.** The sandbox-safe way to read a cross-origin JSON/M3U/XMLTV feed. See below.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `storage`  | `storage.get/set/remove(key[, value])`                                                                                                                                   | A small, shell-owned, per-app key/value store (persisted, size-capped, never cross-app).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `display`  | `display.claimForVideo({width,height,fps})`, `display.release()`                                                                                                         | Switches the OUTPUT mode to suit the app's OWN video (its `<video>`/player) and puts the UI mode back on release. Foreground-only. Not needed with `player` - the shell's `mpv` claims for itself. See below.                                                                                                                                                                                                                                                                                                                                                 |
| `config`   | (launcher-internal)                                                                                                                                                      | First-party surface; not for third-party apps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `input`    | (bridge-only)                                                                                                                                                            | Media/remote keys routed into a bridge app's own handlers (see `shell/bridges/qwebchannel.js`). No `window.tvbox` surface.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `system`   | (bridge-only) `system.exit` / `quit` / `close` / `closeApp`                                                                                                              | Lets a bridge app ask the host to CLOSE it - its window is destroyed and the next launch starts fresh, unlike Home which only backgrounds it. This is what a Plex-style "Exit?" dialog calls.                                                                                                                                                                                                                                                                                                                                                                 |

### `display` - the adaptive-mode capability

Resolution on the box is automatic: the UI draws at the panel's own resolution
**capped to 1080p** (a 4K launcher costs bandwidth, heat and frames for nothing),
and video temporarily takes a mode that suits the content - **refresh first**,
because a 23.976 fps film on a 60 Hz output judders even though not one frame is
dropped, then the smallest resolution that still covers the video, never below
720p. There is no manual resolution setting to fight with.

An app that hands a URL to the shared `mpv` (`player`) gets this for free - the
shell reads the stream's `container-fps`/`dwidth`/`dheight` and claims before the
first frame. `display` is for an app that plays video **itself** (a `<video>`
element, its own player):

```ts
import { useVideoDisplayMode } from "@tvbox/app-sdk";
// claims while `video` is set, releases on unmount / when it clears
useVideoDisplayMode(playing ? { width: 1920, height: 1080, fps: 23.976 } : null);
```

`fps` is the CONTENT's own rate (24000/1001 = 23.976, not a rounded 24) - the app
knows it from its own metadata; `HTMLVideoElement` does not expose it.

Rules the broker enforces, so a misbehaving app can't own the screen:

- **one claim at a time**, newest wins, and only the **foreground** app's counts;
- leaving the app (Home, backgrounded, window closed, crash) releases it;
- a release from anyone but the holder is ignored;
- a claim the panel can't satisfy (a 60 Hz-only set and a 24p film) answers
  `{ ok: true, changed: false, reason: "no-matching-mode" }` - keep playing, and
  the shell's own mpv path switches to `video-sync=display-resample` there;
- switches are rate-limited: each one blanks HDMI for a second or two.

Needs `wlr-randr` on the box (in the image + provision apt lists). On an
OTA-updated box that never got it, every claim answers `no output` and the
resolution simply stays where the TV put it.

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
