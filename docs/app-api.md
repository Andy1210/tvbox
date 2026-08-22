# The app API

Everything an app can call on a tvbox, in one place: the `window.tvbox` bridge,
the shared SDK, the box's own HTTP routes, and the host API a service plugin
gets. This page is the **reference** - what exists, what it takes, what it
answers, and which of it your app is allowed to reach.

Three other pages own the parts around it, and this one links to them rather
than restating them: [app-manifest.md](app-manifest.md) is the field reference
for the manifest, [capabilities.md](capabilities.md) is the security model
behind the bridge, and
[AUTHORING.md](https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md)
in the registry is the step-by-step for building and publishing a package.

- [The three surfaces](#the-three-surfaces)
- [Feature detection, and why it is not optional](#feature-detection-and-why-it-is-not-optional)
- [`window.tvbox` reference](#windowtvbox-reference)
  - [Navigation](#navigation)
  - [The screensaver](#the-screensaver)
  - [The shared player](#the-shared-player)
  - [Events](#events)
  - [`fetch` - the data proxy](#fetch---the-data-proxy)
  - [`storage` - per-app key/value](#storage---per-app-keyvalue)
  - [`display` - output mode for your own video](#display---output-mode-for-your-own-video)
  - [`shares` - your folders from the other box](#shares---your-folders-from-the-other-box)
  - [Launcher-only surfaces](#launcher-only-surfaces)
- [Recipes](#recipes)
- [The SDK: `@tvbox/app-sdk`](#the-sdk-tvboxapp-sdk)
- [HTTP routes an app may call](#http-routes-an-app-may-call)
- [The host plugin API](#the-host-plugin-api)
- [App lifecycle](#app-lifecycle)
- [Developing without a box](#developing-without-a-box)
- [Checklist](#checklist)

## The three surfaces

An app reaches the box through exactly three doors, and which ones it has
depends on how it is served and what its manifest declared.

| Surface              | What it is                                                                                     | Who gets it                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **`window.tvbox`**   | The preload bridge: navigation, the shared player, the screensaver, the brokered capabilities. | Every local (`serve: local`/`static`) app. A remote (`serve: remote`) app only if it declares a capability beyond `nav`. |
| **Same-origin HTTP** | `fetch("/tvbox/api/…")` against the shell's own server, plus your plugin's routes.             | Every `serve: local`/`static` app - it is served from the same origin. A remote app is cross-origin and cannot.          |
| **The host API**     | `host.*` inside `plugin.js`, Node in the shell process.                                        | An app that declares `service` and ships a `plugin.js`. Full host trust.                                                 |

Two windows, by trust, and it decides what the bridge holds:

|                                                                | Main window                                           | Isolated window                                                |
| -------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| Who runs there                                                 | the launcher, and `serve: local`/`static` app bundles | `serve: remote` apps                                           |
| `contextIsolation`                                             | off (Node-capable preload)                            | on, `sandbox` on                                               |
| Preload                                                        | [`shell/preload.js`](../shell/preload.js)             | [`shell/preload-app.js`](../shell/preload-app.js)              |
| `launch`/`home`/`ambient`                                      | yes                                                   | yes, once any capability beyond `nav` is declared              |
| `player` (`play`, `onPlayer`, …)                               | with the `player` capability                          | **not yet** - the compositing path is tied to the main window  |
| `fetch`, `storage`, `shares`, `display`                        | with the capability                                   | with the capability                                            |
| `onCommand`, `onNotify`, `onNav`, `onWidgets`, `onAppsChanged` | yes                                                   | **no** - the shell pushes those events to the main window only |
| `window.tvbox` present at all                                  | always                                                | only when a capability beyond `nav` is declared                |

A `type: native` app has no renderer of ours at all, so it has none of this -
it talks to the world with its own code. See [native-apps.md](native-apps.md).

Where the two preloads offer the same call they take the same arguments and
mean the same thing, deliberately: **an app is not meant to know which window
it got.**

## Feature detection, and why it is not optional

Boxes update on their own schedule and an app updates independently of any
tvbox release, so your app WILL run on a shell older than the API you wrote
against. The bridge has no version field and does not need one: a call the
shell does not have is simply **absent**, so `?.` is the version check.

```ts
import { tvbox } from "@sdk";

tvbox().enqueue?.(urls); // no-op on a shell that has no queue
const t = (await tvbox().tracks?.()) ?? []; // [] rather than a crash
if (!tvbox().ambient) showMyOwnIdleScreen(); // decide what an old shell does
```

Two things follow from it:

- **Never assume a call landed.** `play`, `stop`, `pause`, `resume`, `seek`,
  `pip`, `setTrack` and `ambient.request()` are all fire-and-forget: they
  return `void`, and the shell's own rules may refuse them silently. What tells
  you something happened is a player event, not a return value.
- **Decide, on screen, what an older shell does.** A spinner waiting for a call
  that will never answer is a screen nobody can leave, and the remote has no
  Escape.

The floors worth knowing, because they are recent:

| API                                               | Shell |
| ------------------------------------------------- | ----- |
| `enqueue`, `clearQueue`, the `track` player event | 3.8.0 |
| `ambient.request()`                               | 3.8.0 |
| `play_media` on `onCommand`                       | 3.8.0 |
| `play(url, streams, startPos, { kind })`          | 3.8.0 |
| `shares.compare`, its `group` argument            | 3.8.0 |
| `host.idle()`                                     | 1.6   |
| `host.widget`                                     | 1.5   |

## `window.tvbox` reference

Reach it through the SDK rather than the global: `tvbox()` returns the bridge
when there is one and a **no-op stub** when there is not (a vite dev server, a
vitest run), with `launch`/`home` filled in so a call off-shell does not throw.

```ts
import { tvbox } from "@sdk";
tvbox().home();
```

### Navigation

| Call                       | Does                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch(id: string): void` | Open another app by manifest id. A no-op for an id that is not installed or not `ready` - it must not silently take the television somewhere else. |
| `home(): void`             | Leave for the launcher's HOME. Your app is **hidden, not closed** (see [App lifecycle](#app-lifecycle)).                                           |

The remote's Home button is handled for you: the preload watches for the DOM key
`BrowserHome` and navigates home from any app, so you do not bind it.

Closing an app for real - an "Exit?" dialog, the way Plex has one - is not on
this surface. It needs the `system` capability and a package-shipped
`runtime.bridge`, and it is keyed to the sending window, so an app can only ever
close itself.

### The screensaver

```ts
tvbox().ambient?.request(); // "I have nothing to show; the screensaver may come up"
```

The ambient screen belongs to the launcher, and the launcher's window is hidden
whenever an app is in front - exactly one visible toplevel. Its idle timer is
suppressed there on purpose: a hidden window sees none of the keys the person is
pressing, so counting that time would arm the screensaver behind whatever they
are watching. That is right for an app with something on screen and wrong for
one without, so **an app whose own screen has nothing to show asks.**

The shell brings the launcher forward with the ambient screen on, remembers
which app asked, and sends the screen back there on the first key.

**Deciding when is your app's job, and it needs both halves:** nothing of yours
playing, and no key for a while. `GET /tvbox/api/config` carries
`ambient.idleMinutes` - the delay the person chose for the launcher - so use
that rather than inventing your own.

The call is fire-and-forget, and the shell refuses it silently when:

- the asking app is **not the one on screen** (a background app's timer must not
  take the person out of what they are watching);
- a **native program** is running (the launcher would end it, not hide it), or a
  phone is **mirroring**;
- the shared player is showing a **picture**. Audio-only playback is allowed:
  sound already survives a screen change, so a paused album on a media screen is
  exactly the still picture this exists for. Whether asking over _playing_ music
  is right is your app's call - it is the one that knows whether its screen is
  the thing to look at;
- the owner has the screensaver **off** (Settings → Ambient);
- the shell predates the call, so `tvbox().ambient` is simply absent.

Coming back, your app was **hidden**: normally it returns exactly as it was, but
hidden means muted with its `<video>`/`<audio>` paused, and on a box with
`config.apps.background` off it means destroyed and relaunched. Do not ask for
this over state a person would mind losing.

`ambient.done()` exists on the main-window bridge but is the launcher's - the
shell accepts it from the launcher window only.

### The shared player

One `mpv` process, shared by the whole box, driven on your app's behalf: you
hand it a URL, you never spawn anything. Needs the `player` capability and
`mpv` on the box (it is in the platform baseline).

| Call                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `play(url, streams?, startPos?, opts?): void`                                  | `streams` is `{ audio?, sub?, subFile? }` in **0-based ordinals within each track type** (`sub: -1` = off, `subFile` = a sidecar subtitle URL) - for an app that resolved its streams server-side. What you leave out falls back to the box's language preference, per axis. `startPos` is seconds, and reaches mpv as `--start=`, i.e. before the first frame rather than a jump three seconds in. `opts.kind: "audio"` says there is no picture, so the box skips the output-mode handshake and the video reveal a film needs - both of which cost time and one of which blanks the screen. |
| `enqueue(urls: string[] \| string): Promise<{ ok, added?, refused?, error? }>` | What comes AFTER the current item, so the box crosses to it itself. This is what removes the silence between tracks. The box **appends** - it never replaces what is playing and never starts anything - and caps how many entries it holds, so top the list up as it advances (watch the `track` event) rather than handing over a library. `http(s)` only; anything else is counted in `refused`.                                                                                                                                                                                           |
| `clearQueue(): Promise<{ ok, error? }>`                                        | Drops what is queued BEHIND the current item. What is playing keeps playing: clearing a queue is not stopping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `stop(): void`                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pause()` / `resume(): void`                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `seek(posSec: number): void`                                                   | Absolute, in seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pip(on: boolean, rect?: {x,y,w,h}): void`                                     | Shrink the current video to a device-pixel rect ("browse while watching"), or restore it fullscreen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tracks(): Promise<PlayerTrack[]>`                                             | `[{ type: "audio" \| "sub", id, lang, title, selected }]`; `[]` when nothing plays.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `setTrack(type, id): void`                                                     | `id` is a track id from `tracks()`, or `"no"` / `"auto"`. Anything else is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `selectStreams({audio, sub, subFile}): Promise<…>`                             | The same track terms as `play`'s `streams`, for switching mid-playback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `setPlayerProp(name, value): Promise<…>`                                       | One **allowlisted** mpv property, in mpv's own units: `sub-delay`, `audio-delay`, `speed`, `volume`, `sub-scale`, `sub-pos`, `sub-visibility`, `sub-color`, `sub-border-color`. Anything else is rejected shell-side.                                                                                                                                                                                                                                                                                                                                                                         |
| `onPlayer(cb): () => void`                                                     | Subscribe; the return value unsubscribes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Two things the player is not: it is not per-app (a single global process, so
another app's `play` takes it from you - you find out through `finished` with a
reason), and it does not survive a picture leaving the screen. **Audio does**:
audio-only playback deliberately outlives pressing Home, which is why a music
app can be left while the album plays on.

### Events

Everything the shell pushes at a page, in one place. All of them subscribe the
same way and return an unsubscribe function.

#### `onPlayer(cb)` - the shared player's state

```ts
interface PlayerEvent {
  type: "playing" | "buffering" | "finished" | "error" | "position" | "duration" | "track";
  on?: boolean; // buffering on/off
  ms?: number; // position / duration, in milliseconds
  index?: number; // which queue entry is now playing, on "track" (0-based)
  reason?: string; // why playback ended, when it did not simply run out
}
```

`"track"` means the **queue moved on by itself**. It is not a "finished": an app
that starts the next item when it hears `finished` would react to this by
starting something, which is the relaunch a queue exists to avoid. With entries
queued, `finished` marks the end of the whole list.

**`reason` on `finished` is the one field you must read.** Absent means the item
ran out. Anything else means something stopped it:

| `reason`       | What happened                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| _(absent)_     | The item played to its end.                                                                                                             |
| `"tv-standby"` | **The television was switched off.** The CEC bridge reports standby, the shell stops playback, and this is how your app hears about it. |
| `"stopped"`    | The box or another app ended it: a `stop` from a phone or the assistant, leaving your app mid-film, another app claiming the player.    |

An app that auto-advances - a series, a playlist, a post-play screen - **must
not advance when a reason is present**. With the TV off, a box otherwise plays
its way through a season in an empty room. Treat a reason you do not recognise
as "something stopped it".

#### `onCommand(cb)` - media commands from outside the box

A remote's transport keys, a Home Assistant automation, or the household
assistant reach the box over MQTT (`tvbox/<id>/cmd`) and the shell forwards the
media half to the launcher **and** to the foreground app, so the app that owns
the sound can drive its own player.

```ts
interface TvCommand {
  action: string;
  app?: string;
  query?: string; // what to look for, on play_media
}
```

Actions an app receives: `pause`, `play`, `resume`, `stop`, `next`, `previous`,
`play_media`. The rest of the vocabulary (`launch`, `home`, `tv_on`, `tv_off`,
volume, `seek`, `find_remote`) is shell-side and never forwarded.

For `pause`/`play`/`stop` the shell has **already** acted on its own mpv before
forwarding, so treat these as "the person asked for this" rather than as
something you must apply to the shared player.

`play_media` carries `query` - words, not an id. Music asked for out loud
reaches the box as a name, and the account that can turn a name into something
playable is the one your app holds, so the search happens in your app.

**A command can arrive before your listener exists.** A window opened _by_ a
command is still executing its bundle when the shell delivers it, so the main
window's preload holds what arrived before the first listener (a few commands,
within a ten-second window) and replays it to every listener registered inside
that window. That is a hand-over gap of milliseconds, not a mailbox: after the
first listener, delivery is live only.

#### `onNotify(cb)` - a note to put on screen

```ts
interface TvNotification {
  title?: string;
  message?: string;
  image?: string; // e.g. a doorbell camera snapshot URL
  duration?: number; // ms before auto-dismiss (0 = sticky)
  raise?: boolean; // bring the launcher forward, over a remote app
}
```

Receive-only, pushed from MQTT or from `POST /tvbox/api/notify`. The launcher
draws these; an app normally does not need to.

#### `onNav(cb)` - the launcher was sent somewhere

`{ dest: string }`, e.g. `"settings"`, `"home"`, `"ambient"`. This is a remapped
remote button arriving through `/tvbox/api/nav` while the launcher is already
up. Launcher-internal in practice.

#### `onWidgets(cb)` / `onAppsChanged(cb)`

HOME-screen cards (see [the host API](#the-host-plugin-api)) and "the set of
running apps changed under HOME's feet". Both are the launcher's; they are on
the main-window bridge because that is where the launcher lives.

### `fetch` - the data proxy

A sandboxed app cannot make cross-origin requests, and parsing a large feed in a
renderer on this hardware is not free either. The `fetch` capability asks the
shell to do the request, **locked to the hosts the manifest declared**.

```ts
const r = await tvbox().fetch?.("https://epg.example/xmltv.xml");
if (r?.ok) parseXmltv(r.body);
```

```ts
interface FetchRequest {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>; // allowlisted shell-side
  body?: string;
}
type FetchResponse =
  { ok: true; status: number; headers: Record<string, string>; body: string } | { ok: false; error: string };
```

What the shell enforces ([`shell/appfetch.js`](../shell/appfetch.js)):

- **Origin-locked.** The URL host must equal, or be a subdomain of, an entry in
  `runtime.origins`. An app with no `origins` cannot `fetch` at all.
- **Protocol.** https everywhere; plain http only to a declared **private/LAN**
  host, which is a self-hosted server the user opted into. Cloud-metadata hosts
  are hard-denied even when declared.
- **No ambient credentials.** Cookies are never sent and `Set-Cookie` is never
  returned. Request headers are allowlisted - no `Cookie`, `Host`, `Referer`.
  Response headers come back lowercased and allowlisted.
- **Bounded.** GET/POST/HEAD only, 10 s timeout, 5 MB response cap, 256 KB
  request-body cap, at most 3 redirects with every hop re-validated.

The `ok: false` shape is a discriminated union, not an exception: a refusal
carries a reason string. Show it, do not retry it in a loop.

### `storage` - per-app key/value

```ts
await tvbox().storage?.set("lastChannel", "42");
const v = await tvbox().storage?.get("lastChannel"); // string | null
await tvbox().storage?.remove("lastChannel");
```

Small, shell-owned, persisted, size-capped, and **never cross-app**: the broker
keys off the sender window, which is permanently bound to one app, so a
background app's write still lands in its own store.

`localStorage` also works in your window, and the launcher's locale lives in one
shared key so a user's language carries over into your app. Use `storage` for
what should survive a bundle swap, and note that the manifest's `backup.state`
is what gets a file of yours into the encrypted settings backup.

### `display` - output mode for your own video

Resolution on the box is automatic: the UI draws at the panel's own resolution
**capped to 1080p**, and video temporarily takes a mode that suits the content -
**refresh first**, because a 23.976 fps film on a 60 Hz output judders even
though not one frame is dropped, then the smallest resolution that still covers
the video, never below 720p. There is no manual resolution setting to fight
with.

An app that hands a URL to the shared player gets this **free**. `display` is
for an app that plays video itself - a `<video>` element, its own player:

```ts
import { useVideoDisplayMode } from "@sdk";
// claims while `video` is set, releases on unmount / when it clears
useVideoDisplayMode(playing ? { width: 1920, height: 1080, fps: 23.976 } : null);
```

`fps` is the CONTENT's own rate (24000/1001 = 23.976, not a rounded 24). Your
app knows it from its own metadata; `HTMLVideoElement` does not expose it.

The raw calls are `claimForVideo(v)` and `release()`, both answering a
`DisplayClaim`:

```ts
interface DisplayClaim {
  ok: boolean;
  changed?: boolean; // a switch really happened
  reason?: string; // "no-matching-mode" | "no-capability" | "superseded" | …
  mode?: { width: number; height: number; refresh: number };
  error?: string; // only for a broken bridge, never for a missing capability
}
```

Rules the broker enforces, so a misbehaving app cannot own the screen: one claim
at a time, newest wins, and only the **foreground** app's counts; leaving the app
in any way releases it; a release from anyone but the holder is ignored; switches
are rate-limited, because each one blanks HDMI for a second or two.

`{ ok: true, changed: false, reason: "no-matching-mode" }` is the normal answer
from a panel with nothing better to offer - **keep playing**. Without the
capability every call is a benign no-op (`reason: "no-capability"`), so the SDK
helpers are safe to call unconditionally.

### `shares` - your folders from the other box

Two boxes in two rooms and files of yours a person would want in both - an
emulator's saves being the obvious case. The split is deliberate: **what** may be
offered is your manifest's `shares.paths`, **whether** it is offered is a
person's decision in Settings, and **bringing files across** is your app's,
because it is the one that knows what its files mean.

```ts
const { peers, shares } = await tvbox().shares!.list();
// peers:  [{ id, name }]                    - boxes this one has been paired with
// shares: [{ id, name, present, on }]       - THIS app's, as Settings sees them

const c = await tvbox().shares!.compare(peers[0].id, shares[0].id);
// { ok: true, here: {newest, files}, there: {newest, files},
//   newerThere, olderThere, sameTimeDiffers, groups }

await tvbox().shares!.pull(peers[0].id, shares[0].id /*, group */);
```

`compare` exists because a pull is one press and it replaces what is here.
`newerThere` is what would arrive; **`olderThere` is what would be replaced by an
older copy** - the copy does not prefer the newer file, and that count is the
difference between a useful pull and a regret. `sameTimeDiffers` is the third
case: written in the same second on both sides but not the same size.

`groups` breaks the same numbers down by the first folder inside the share,
which for an emulator's saves is one per console - and that is what makes "which
box has the newer save" answerable at all, because one date per box says nothing
when one room played the SNES and the other the GameCube. `pull` takes that
folder name as an optional third argument.

There is no path argument, no destination argument and **no push**: a box brings
files to itself, so two boxes cannot overwrite each other's copy behind the
user's back. Everything is scoped to the calling app.

`pull` answers `{ ok, error? }`: `unknown_share`, `unknown_peer`, `busy` (one at
a time - two copies into the same folder race), `rclone_missing`, `pull_failed`.
`compare` fails with `unreachable` or `compare_failed` - **a failure is never
reported as an empty folder**, because that reads as "everything there is worth
bringing".

Each call costs a listing over the network (0.25-0.8 s for a save folder), so ask
on opening a screen, not on every render.

### Launcher-only surfaces

`window.tvbox.typing` (`status`, `submit`, `cancel`, `phone`) is on the
main-window bridge but the shell **rejects any sender that is not the launcher**.
It is not an HTTP route on purpose: every local app bundle shares the shell's
origin, so a route would let one of them read the pairing code and inject
keystrokes into another app's focused field.

Your app does not need it. A focused text field raises the box's typing screen by
itself - the preload watches for focus landing in a field and tells the shell,
for every local and remote app alike. Set `runtime.textInput: "off"` if your app
ships its own on-screen keyboard (the SDK's `Osk`).

## Recipes

### Let the screensaver come up over a screen with nothing on it

```tsx
const idleMinutes = useConfigStore((s) => s.config?.ambient.idleMinutes ?? 10);

useEffect(() => {
  if (isPlayingSomething) return; // both halves: no playback of ours...
  const t = setTimeout(() => tvbox().ambient?.request(), idleMinutes * 60_000);
  const wake = () => clearTimeout(t);
  window.addEventListener("keydown", wake, true); // ...and no key for a while
  return () => {
    clearTimeout(t);
    window.removeEventListener("keydown", wake, true);
  };
}, [isPlayingSomething, idleMinutes]);
```

### Do not start the next episode when the TV was switched off

```ts
useEffect(
  () =>
    tvbox().onPlayer?.((ev) => {
      if (ev.type !== "finished") return;
      if (ev.reason) return showIdleScreen(); // tv-standby, stopped, anything new
      playNextEpisode();
    }),
  [],
);
```

The bug this avoids is not theoretical: with the TV off and no reason check, a
post-play screen works its way through a season in an empty room.

### Keep a queue topped up instead of restarting the player per track

```ts
tvbox().play?.(tracks[0].url, undefined, 0, { kind: "audio" });
tvbox().enqueue?.(tracks.slice(1, 4).map((t) => t.url));

tvbox().onPlayer?.((ev) => {
  if (ev.type === "track") {
    setNowPlayingIndex(ev.index ?? 0);
    tvbox().enqueue?.(nextFewUrlsAfter(ev.index ?? 0)); // the box caps what it holds
  }
  if (ev.type === "finished" && !ev.reason) onWholeListDone();
});
```

### An in-playback language picker

```ts
const tracks = (await tvbox().tracks?.()) ?? [];
tvbox().setTrack?.("audio", 2);
tvbox().setTrack?.("sub", "no"); // "auto" is also accepted
```

Apply optimistically, then re-query `tracks()` after ~500 ms to confirm what mpv
actually selected. Live TV's `TrackMenu.tsx` in the registry is the reference
implementation.

### Report what is playing, so the house knows

```ts
import { postNowPlaying } from "@sdk";
postNowPlaying({ app: "myapp", state: "playing", title, artist, image });
```

This POSTs `/tvbox/api/nowplaying`, which the shell bridges to MQTT (retained)
for Home Assistant and feeds into the box's idle test - so a box playing your
audio is correctly _not_ idle for the nightly auto-update. Report `idle` when
you stop; a stale `playing` keeps the box awake.

### Gate something behind the box's parental PIN

```tsx
import { PinGate } from "@sdk";

{
  locked && <PinGate onSuccess={() => setLocked(false)} onCancel={goBack} />;
}
```

There is ONE central PIN, set in HOME Settings, stored salted and hashed, and
verified server-side. Use `PinGate` rather than re-wiring `PinPad` + `verifyPin`

- error state, so every app shares the PIN the user set once.

### Play a file from the box or a USB stick

```ts
const { sources, removable } = await (await fetch("/tvbox/api/browse/sources")).json();
const listing = await (await fetch("/tvbox/api/browse/list?path=" + encodeURIComponent(p))).json();
tvbox().play?.(entry.path, undefined, startPos);
```

Nothing auto-mounts: opening a stick IS the mount
(`POST /tvbox/api/browse/mount {device}`). Three things to build around:

- **These routes are newer than some shells in the field.** A 404 means the box
  cannot do this at all - say so on screen rather than showing an empty list.
  Same for `removable.supported: false`, which is a box without `udisks2`.
- **A path is checked, not trusted.** Both sides are resolved with `realpath` and
  compared as `root + separator`, so `..`, a symlink on the stick and a
  same-prefix sibling folder are all refused. Walk from what a listing gave you;
  do not construct paths.
- **Feature-detect the transport calls too.** A shell older than
  `pause`/`resume`/`seek` exposes none of them, and a screen that assumes they
  are there is a spinner nobody can leave.

## The SDK: `@tvbox/app-sdk`

The shared 10-foot UI: the pieces a remote-driven, D-pad screen needs, so
neither the launcher nor an app reimplements them.

**It ships as TypeScript source, not a built package.** Both the launcher and
every app resolve it through a Vite alias plus a matching tsconfig path:

```ts
// vite.config.ts
resolve: { alias: { "@sdk": path.resolve(__dirname, "../../../app-sdk/src") } }
// tsconfig.json
"paths": { "@sdk/*": ["../../../app-sdk/src/*"] }
```

Because the alias resolves straight to `src/`, the package deliberately has no
`main`, no `exports` and no build step - adding one would change how `@sdk`
resolves. Its peers (React 19, zustand 5,
`@noriginmedia/norigin-spatial-navigation` 3, qrcode 1) come from the host that
consumes the source. Build your app from inside a tvbox checkout that has
`tvbox-apps/` cloned within it, which is the sibling layout the alias expects.

### Focus and the D-pad

| Export                               | Signature                                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initSpatialNavigation(options?)`    |                                                                                   | Call once at startup. It pins the `GetBoundingClientRectAdapter`, and that is not cosmetic: the library's default adapter measures with `offsetTop`/`offsetHeight`, which are **rounded to whole pixels**, and its direction filter is strict. With rows sized in `vh` their real boxes touch at fractional coordinates, rounding turns a touch into a one-pixel overlap, and the row is dropped from every candidate list - unreachable with the D-pad in either direction. |
| `useFocusableItem(config?, scroll?)` | `→ { ref, focused, focusKey }`                                                    | A focusable list/grid item. Owns the two things every focusable otherwise repeats by hand: merging the DOM ref with the spatial-nav ref, and scrolling into view on focus. Omit `scroll` for an always-visible control that should not scroll. `ref` is a callback ref, so there is no cast at the call site.                                                                                                                                                                |
| `FocusButton`                        | `{ focusKey?, onEnter, className?, children, label?, onArrowPress?, onFocused? }` | The standard focusable button. `label` is the accessible name, needed when the content is an icon. `onArrowPress(dir) => boolean` intercepts an arrow before spatial nav resolves it - return `false` to say it is handled, for the cases where geometry gives the right answer and the wrong destination. `onFocused` is for what `scrollIntoView` cannot express, like bringing a header into view when the topmost focusable is reached.                                  |
| `useBackspace(handler, enabled?)`    |                                                                                   | Remote Back. A single capture-phase listener fires only the **top** handler - the most recently mounted enabled one - so a modal's Back closes the modal and the parent's handler takes over again when it unmounts. Register with `enabled` false while your modal is closed, or it swallows Back for the parent.                                                                                                                                                           |
| `isBackKey(e)`                       | `→ boolean`                                                                       | For raw `keydown` handlers outside the `useBackspace` stack, e.g. a fullscreen playback view with no focusable UI. **Back arrives as four different DOM keys** depending on how the box is driven: `Backspace` (the CEC bridge), `BrowserBack`/`GoBack` (a Bluetooth remote's own Back), `Escape` (some remotes). Never check a single key.                                                                                                                                  |
| `startGamepadNav()`                  | `→ teardown`                                                                      | Translates a game controller into the arrow/Enter/Back key events the UI already understands. Renderer-side on purpose: an input bridge doing it would also fire inside an app that speaks Gamepad natively and double-navigate its menus. Costs nothing with no pad connected, and stops polling in a hidden window.                                                                                                                                                        |

### Input on a screen with no keyboard

| Export                                                               | Signature                                                | Notes                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Osk`                                                                | `{ title, initial?, onDone, onCancel, extra?, layout? }` | The D-pad on-screen keyboard. It is a focus boundary, which is why `extra` (an extra action such as "type on your phone") lives INSIDE it - a button outside could never be reached with the arrows. `layout` is optional: left out, it asks the shell once and caches for the session. Accent rows follow Settings → System → Region. |
| `PinPad`                                                             | `{ title, onSubmit, onCancel, error?, busy? }`           | The raw pad.                                                                                                                                                                                                                                                                                                                           |
| `PinGate`                                                            | `{ onSuccess, onCancel, title?, wrongText? }`            | `PinPad` + `verifyPin` + error state, over the box's one central PIN. Strings default to the shared `parental.enterPin` / `parental.wrongPin` i18n keys. Prefer this.                                                                                                                                                                  |
| `verifyPin(pin)`                                                     | `→ Promise<boolean>`                                     | Server-side check.                                                                                                                                                                                                                                                                                                                     |
| `layoutKey`, `oskLayers`, `OSK_LAYOUTS`, `noteOskLayout`, `KeyGlyph` |                                                          | The keyboard's own internals, exported for a UI that builds its own key row.                                                                                                                                                                                                                                                           |

### i18n

| Export                                                      | Signature                              | Notes                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `configureI18n(locales, { fallback? })`                     |                                        | Call **once at startup, before rendering**. The SDK hardcodes no languages; the host injects its dictionaries.                          |
| `useI18n()`                                                 | `→ { locale, tag, t, loc, setLocale }` | `t(key, vars?)` with `{name}` interpolation, `loc(value)` for a manifest `LocaleString`, `tag` for `Intl` formatting.                   |
| `translate(locale, key, vars?)` / `localize(value, locale)` |                                        | The same two, outside React.                                                                                                            |
| `availableLocales()`                                        | `→ [{ id, name, tag }]`                | For a language picker.                                                                                                                  |
| `useLocaleStore`                                            |                                        | The persisted store behind it (`tvbox.i18n` in `localStorage`), shared with the launcher, so the user's language carries into your app. |

Each locale dictionary must carry a `_meta: { name, tag }` - the display name in
its own script, and the BCP-47 tag used for date and number formatting. A
persisted locale your host no longer ships is dropped on `configureI18n`, so
reported locale and rendered language cannot drift apart.

### Config, capability and the rest

| Export                                                                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tvbox()`                                                                                                                                                           | The typed bridge, or a no-op stub off-shell. Use it instead of `window.tvbox`.                                                                                                                                                                                                                                                                                                            |
| `api(path, opts?)`                                                                                                                                                  | A thin same-origin `fetch` wrapper, so app code has one call site pointing at the shell.                                                                                                                                                                                                                                                                                                  |
| `fetchConfig()`                                                                                                                                                     | `→ PublicConfig \| null`. **`null` means the shell is unreachable, which is NOT an unconfigured box** - offer retry rather than dropping the user into first-run onboarding over a transient hiccup.                                                                                                                                                                                      |
| `useConfigStore`                                                                                                                                                    | The zustand store over `/tvbox/api/config`: `config`, `error`, `load()`, and a setter per section. Loaded once and refreshed after writes, so components subscribe instead of each fetching on mount.                                                                                                                                                                                     |
| `saveIptv`, `saveParental`, `saveAmbient`, `saveUi`, `savePlayer`, `saveWifi`, `saveBluetooth`, `saveMqtt`, `saveIr`, `saveUpdate`, `saveRemote`, `saveRemotePower` | Section writers. A non-2xx response **throws** rather than resolving `undefined`, so a failed save cannot quietly write garbage into the store.                                                                                                                                                                                                                                           |
| `postNowPlaying(np)`                                                                                                                                                | `{ app, state: "playing" \| "paused" \| "idle", title?, artist?, image? }`.                                                                                                                                                                                                                                                                                                               |
| `claimForVideo`, `releaseVideoMode`, `useVideoDisplayMode`                                                                                                          | The `display` capability; see above. The hook exists because the **release** is the part apps forget.                                                                                                                                                                                                                                                                                     |
| `installNavSounds()`, `setSoundsEnabled`, `setSoundsSuppressed`, `tickMove`, `tickSelect`                                                                           | Focus ticks, synthesised with WebAudio so no audio assets ship. One global capture listener: arrows tick "move", Enter ticks "select" - keyed to what the user FELT, a keypress, not to what the focus engine did. Fed from `config.ui.navSounds`.                                                                                                                                        |
| Types                                                                                                                                                               | `PublicConfig`, `RemoteAction`, `RemoteKeymap`, `RemoteDeviceConfig`, `RemotePower`, `IrBackend`, `IrAction`, `IrActionMap`, `PlayerEvent`, `PlayerTrack`, `TvCommand`, `TvNotification`, `NavEvent`, `PipRect`, `FetchRequest`, `FetchResponse`, `StorageBridge`, `DisplayBridge`, `VideoMode`, `DisplayClaim`, `LocaleString`, `LocaleDict`, `LocaleInfo`, `NowPlaying`, `TvboxBridge`. |

Your app's own styling: `@import "tailwindcss"` plus `@source` the app-sdk and
your source, and copy the shared `@theme` token block from
`apps-src/livetv/index.css` in the registry so your screens match the rest of the
box.

## HTTP routes an app may call

A `serve: local` app is served at `/<id>/` from the **same origin** as the API,
so it reaches these with a plain `fetch` - no capability needed. The server
listens on `127.0.0.1:8097` only. A `serve: remote` app is cross-origin and
cannot use any of them; that is what the `fetch` capability is for.

Everything state-changing is behind a same-origin gate: every non-GET, plus the
GETs that fork a process (`/tvbox/api/browse/*`, `/tvbox/api/photoshare*`,
`/tvbox/api/firetvir/*`, `/tvbox/api/tv/standby`). Read-only GETs are open,
because blocking them would break `<img>` and other no-CORS uses.

| Route                                                                                                   | For                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /tvbox/api/config`                                                                                 | The secret-free `PublicConfig`. Where `ambient.idleMinutes`, `ui.navSounds`, `player.audioLang`/`subLang`, `parental.pinSet` and `apps.background` come from.                |
| `POST /tvbox/api/config`                                                                                | A partial patch; answers `{ config }` with the fresh state. Prefer the SDK writers.                                                                                          |
| `POST /tvbox/api/parental/verify`                                                                       | `{ pin }` → `{ ok }`. Behind `verifyPin`/`PinGate`.                                                                                                                          |
| `POST /tvbox/api/nowplaying`                                                                            | `{ app, state, title?, artist?, image? }`. Behind `postNowPlaying`.                                                                                                          |
| `POST /tvbox/api/notify`                                                                                | `{ title?, message?, duration?, raise? }` - one note on screen. Capped shell-side (title 120, message 400, duration ≤ 60 s), because the launcher draws whatever arrives.    |
| `GET /tvbox/api/apps`                                                                                   | Every installed app as the launcher sees it: `id`, `name`, `tagline`, `type`, `status`, `accent`, `icon`, `running`, `foreground`, `pairing`, `switches`, dependency status. |
| `POST /tvbox/api/apps/quit`                                                                             | `{ id }` - really close a background app.                                                                                                                                    |
| `POST /tvbox/api/nav`                                                                                   | `{ dest }`: `"home"`, `"settings"`, `"switch"` (cycle running apps), or `{ dest: "app", app: "<id>" }`.                                                                      |
| `GET /tvbox/api/browse/sources`                                                                         | The user's folders, every partition of every removable drive, every mounted network share. `kind` says which.                                                                |
| `GET /tvbox/api/browse/list?path=…`                                                                     | One directory inside one of those roots. Anything else is refused.                                                                                                           |
| `GET /tvbox/api/browse/thumb`, `…/image`                                                                | A thumbnail or the full image for an entry.                                                                                                                                  |
| `POST /tvbox/api/browse/mount`, `…/unmount`                                                             | `{ device }` - opening a stick IS the mount.                                                                                                                                 |
| `GET /tvbox/api/widgets`                                                                                | The HOME cards plugins have set.                                                                                                                                             |
| `GET /tvbox/api/system/info`, `…/region`, `GET /tvbox/api/display/status`, `GET /tvbox/api/audio/sinks` | Read-only box facts, if your screen needs them.                                                                                                                              |

Your plugin's own routes are matched **before** the built-ins, under the prefix
you registered, so `fetch("/tvbox/api/myapp/state")` reaches your own code:

```js
host.registerRoutes("/tvbox/api/myapp", {
  "GET /state": (req, res) => host.json(res, { ok: true }),
  "POST /save": (req, res, { body }) => host.json(res, save(body)),
});
```

## The host plugin API

If your app needs host-side Node - a daemon, an OAuth window, server routes -
ship `apps/<id>/plugin.js` and set `"service": "<id>"` in the manifest. It is a
factory the shell calls at boot with the `host` object:

```js
module.exports = (host) => {
  host.registerRoutes("/tvbox/api/myapp", { "GET /state": (req, res) => host.json(res, state()) });
  host.onConfigChange((sections) => {
    if (sections.includes("myapp")) reload();
  });
  return { start() {}, stop() {} }; // both optional
};
```

**This is trusted code in the shell process.** It is the boundary the curated
registry's merge review exists for - there is no sandbox here.

| `host.*`                                                                         | What it is                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`                                                                           | `http://localhost:<port>` - the box's own origin.                                                                                                                                                                                                                                                                                                   |
| `config`                                                                         | The config store (`rawSpotify`/`setSpotify`/`publicConfig`, …). **Read config through this, never by requiring a core config module.**                                                                                                                                                                                                              |
| `json(res, obj)`                                                                 | Write a JSON response.                                                                                                                                                                                                                                                                                                                              |
| `log(...args)`                                                                   | Prefixed console logging, into `~/.tvbox/shell.log`.                                                                                                                                                                                                                                                                                                |
| `registerRoutes(prefix, table)`                                                  | HTTP routes, keyed `"METHOD /subpath"`. Call from the factory, before the server starts.                                                                                                                                                                                                                                                            |
| `onConfigChange(cb)`                                                             | `cb(sections)` after a config write. Tagged with your app, so unloading the plugin removes it - an untagged listener would survive its plugin and start a daemon nothing is left to stop.                                                                                                                                                           |
| `switchOn(key)`                                                                  | The value in force for one of your manifest's own `switches`. Scoped: a plugin reading another app's settings is not a thing this API allows.                                                                                                                                                                                                       |
| `spawnService(name, spec)` / `stopService(name)` / `restartService(name, delay)` | A supervised child process.                                                                                                                                                                                                                                                                                                                         |
| `childEnv()`                                                                     | A spawn environment carrying the session's Wayland variables.                                                                                                                                                                                                                                                                                       |
| `audioSink()`                                                                    | The detected HDMI sink node name.                                                                                                                                                                                                                                                                                                                   |
| `BrowserWindow`                                                                  | Electron's, for a plugin that needs its own window - an OAuth flow.                                                                                                                                                                                                                                                                                 |
| `pairing.register(kind, provider)`                                               | Your own phone-pairing page(s) and their routes. Serve the HTML from your own package dir with `fs`; do not rely on the core page directory.                                                                                                                                                                                                        |
| `widget.set({title, subtitle})` / `widget.clear()`                               | ONE card on HOME, per app - a plugin can only ever write its own. Sanitised host-side (title 120 chars, subtitle 160) and cleared on uninstall. Enter on the card opens the app. Shell 1.5+, so `if (host.widget)`.                                                                                                                                 |
| `navTo(id, {query}?)`                                                            | Foreground an app by id (`"home"` = the launcher). It stops whatever else is playing when it switches apps.                                                                                                                                                                                                                                         |
| `showLauncher(hash?)`                                                            | Stop other playback and bring the launcher forward, optionally at a hash.                                                                                                                                                                                                                                                                           |
| `appState(id)`                                                                   | `{ running, foreground }`. "Running" is per app KIND: a native app has no window of ours, so its own process is what running means.                                                                                                                                                                                                                 |
| `notify(n)`                                                                      | The same on-screen note as `POST /tvbox/api/notify`.                                                                                                                                                                                                                                                                                                |
| `idle()`                                                                         | **Is the box free?** The very predicate the shell's own background jobs wait for: no player, launcher focused, nothing reported playing, no install, no maintenance. Shell 1.6+.                                                                                                                                                                    |
| `launchNative(id, extraArgs)`                                                    | Start your app's own native program with per-launch arguments. Takes an **app id**, not a command line: the program still comes from the manifest the shell validated, and the arguments go through the same parser. A plugin can add arguments to a program the shell already knows; it cannot invent a command line. Returns whether it launched. |
| `nativeRunning()`                                                                | The id of the native app running now, or `null` - what a UI needs after a reload, since its own window is hidden while the game runs.                                                                                                                                                                                                               |

### Background work waits for `host.idle()`

```js
if (host.idle?.()) startTheSweep();
```

Poll it on a timer and stop between units of work rather than assuming it stays
true. A **user-initiated** action should ignore it - they asked for it now.
RetroArch's artwork pass (`apps/retroarch/lib/art.js` in the registry) is the
reference.

### Loading, replacing, unloading

A plugin loads only when its declared deps resolve. An install or update
**hot-loads** it with no shell restart, and an update unloads the old code
first - which takes its config listeners, its routes and the require cache for
its whole package directory with it. So write `stop()` as the thing that
releases what the shell cannot see for you: a daemon, a supervised child, a
listening socket. A `stop` that throws leaves whatever it held until a restart.

## App lifecycle

**Every app runs in its own window, and leaving it just hides it.** HOME comes
up instantly and reopening resumes the live page - browse position, scroll
state, logged-in session - in well under a second.

| Moment                                       | What your app sees                                                                                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch                                       | Your bundle loads. A command that opened the window is held for your first `onCommand` listener.                                                                                                                              |
| Foreground                                   | Your window is the only visible toplevel.                                                                                                                                                                                     |
| Leaving (Home, another app, the screensaver) | The window is **hidden**: the renderer is muted and any in-page `<video>`/`<audio>` is paused best-effort. Your JS keeps running; `document.visibilityState` is `hidden`, and `requestAnimationFrame` is throttled to a stop. |
| A picture playing in the shared player       | Stops, and you get `finished` with `reason: "stopped"`. **Audio-only playback survives** - that is what lets a music app be left while the album plays on.                                                                    |
| Coming back                                  | The same page, as it was.                                                                                                                                                                                                     |
| Quit                                         | The ✕ in HOME's Running row, `POST /tvbox/api/apps/quit`, an uninstall, or your own `system.exit`: the window is destroyed and the next launch is fresh.                                                                      |
| Evicted                                      | Hidden windows are LRU-capped by the box's RAM (1 window under 3.5 GB, 3 under 7 GB, 6 above), and a once-a-minute RAM guard drops the least-recently-used one under the memory floor. A shell restart drops them all.        |
| `config.apps.background: false`              | The old behaviour: leaving destroys the window. Your app must survive this.                                                                                                                                                   |

Three consequences worth designing for:

- **Do not treat "my page is still loaded" as "the user is looking at me."**
  Check `visibilityState` before doing anything that assumes a screen.
- **Hidden apps do not block the nightly auto-update**, so a restart can drop
  yours at any time. Persist what matters (`storage`, or `backup.state`).
- **Identity is per-window.** The preload's answer and every capability broker
  key off the sender window, which is permanently bound to one app - so a
  background app keeps its own capabilities, origins and storage, and there is no
  window reuse and no confused-deputy path.

A `type: native` app has no half-state: it either owns the screen or it has
exited, and `running` on its tile means its process is alive. A `webclient` app
that _launches_ a native program per item (RetroArch) keeps its own hidden window
throughout, and the program exiting lands the user back in the list they started
it from.

## Developing without a box

- **`tvbox()` is a no-op stub off-shell**, so a vite dev server and a vitest run
  do not need the bridge mocked. What is absent stays absent, which is also a
  free rehearsal for an older shell.
- **The launcher has a demo mode** (`npm run build:demo`, deployed at
  <https://andy1210.github.io/tvbox/>) that mocks the shell API. It is the
  quickest way to see the 10-foot UI in a desktop browser.
- **Serve your own registry to a real box:** `npm run store:serve` in the
  registry prints a LAN URL, and Settings → Apps → Store sources adds it beside
  the official one. Plain http works only because the address is on your own
  network.
- **Test the D-pad, not the mouse.** `launcher/src/test/remote.ts` in this repo
  is the vitest harness for it, and spatial-nav tests need
  `getBoundingClientRect` stubbed - with the all-zero rects a DOM shim returns by
  default every candidate is equidistant, so a passing test proves nothing.
- **Driving a real box headlessly** (uinput keys, screenshots, DevTools on the
  debug port) is in [diagnostics.md](diagnostics.md).

## Checklist

- [ ] `runtime.capabilities` lists **only** what you call. Omitting one must
      never grant it, and the review reads this field first.
- [ ] `runtime.origins` covers every host your `fetch` touches, and nothing more.
- [ ] Every optional bridge call goes through `?.`, and you have decided what an
      older shell shows on screen.
- [ ] `finished` handlers check `reason` before advancing.
- [ ] Back is handled with `useBackspace` or `isBackKey`, never a single key.
- [ ] Nothing on screen is reachable only by pointer: every control takes D-pad
      focus, and no screen is a dead end.
- [ ] Your app reports now-playing when it makes sound, and `idle` when it stops.
- [ ] `backup.paths`/`state` names what a person would be sad to lose - not
      caches, not anything re-downloadable.
- [ ] A screen that can sit still all night asks for the screensaver.
- [ ] It was tried on a real box, driven with the remote from the sofa.
