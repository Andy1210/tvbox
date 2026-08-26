// The box's read API: every GET route, in one place.
//
// The counterpart of routes.js. A GET here is a READ - it reports what the box is
// or hands back a picture - and the few that cost something (a forked process, an
// authenticated upstream request) are named in `guardedGet` so the same-origin gate
// covers them, because an open GET is the policy for a side-effect-free read and a
// page the box loads can drive one through an <img> tag.
//
// Same shape as routes.js: modules with no shell state in them are required
// directly, and everything the shell can do that this needs arrives as `ctx`.
const fs = require("fs");
const path = require("path");

const ambient = require("./ambient");
const appshares = require("./appshares");
const audio = require("./audio");
const backup = require("./backup");
const bluetooth = require("./bluetooth");
const browse = require("./browse");
const builtinradio = require("./builtinradio");
const config = require("./config");
const display = require("./display");
const fileserver = require("./fileserver");
const firetvir = require("./firetvir");
const httpserver = require("./httpserver");
const images = require("./images");
const apps = require("./install");
const ir = require("./ir");
const maintenance = require("./maintenance");
const pairing = require("./pairing");
const phoneremote = require("./phoneremote");
const photoshare = require("./photoshare");
const player = require("./player");
const reconcile = require("./reconcile");
const remotefinder = require("./remotefinder");
const shares = require("./shares");
const sharing = require("./sharing");
const store = require("./store");
const system = require("./system");
const updater = require("./updater");
const wifiradio = require("./wifiradio");

// Same reason routes.js gives for its own copy: `udisksctl` is what mounts a stick
// and it is not on every box (udisks2 is a soft dep, and OTA can never add an apt
// package), so browse.js asks before it runs anything. `shares` is a function
// rather than a list because a share can be added while the box is running.
const browseDeps = { onPath: apps.onPath, shares: () => config.rawShares() };

/**
 * Which GETs the same-origin gate has to cover.
 *
 * Every non-GET is gated already. These are the reads that are NOT
 * side-effect-free: tv/standby stops playback, and the rest fork a process
 * (a python subprocess, bluetoothctl, lsblk, ffmpeg) or drive an outbound fetch.
 * Other read-only GETs stay open - they leak nothing actionable and blocking them
 * would break <img>/no-CORS uses.
 *
 * The cache in removable.js is what actually bounds the browse cost - an <img> or
 * <iframe> request carries no Origin header for the gate to catch.
 */
function guardedGet(p) {
  return (
    p === "/tvbox/api/tv/standby" ||
    p.startsWith("/tvbox/api/firetvir/") ||
    p.startsWith("/tvbox/api/browse/") ||
    p.startsWith("/tvbox/api/photoshare") ||
    // Same reason as firetvir: it forks a bluetoothctl per connected device.
    p === "/tvbox/api/remote/finder/capable"
  );
}

// A rendered photo, out of the thumbnail cache. The entry is keyed on the source
// file's size and mtime, so for one URL (which the caller stamps with that mtime)
// the answer can never change - which is what lets a grid re-use a tile it has
// already scrolled past instead of asking for it again.
function sendImage(res, file) {
  // The headers wait for the file to actually open. They promise the answer is
  // good for a year, so writing them first and failing afterwards would put an
  // empty response in Chromium's cache under a URL it will not ask about again -
  // and the entry CAN be gone by now, because the prune runs between the check
  // that found it and this read.
  const stream = fs.createReadStream(file);
  stream.on("open", () => {
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      // The fast path forwards a JPEG a stranger's camera wrote, so the declared
      // type is the only thing that should decide how it is treated.
      "X-Content-Type-Options": "nosniff",
    });
    stream.pipe(res);
  });
  stream.on("error", (e) => {
    console.warn("[images] read failed:", file, e.message);
    if (!res.headersSent) return imageError(res, "not_found");
    try {
      res.end(); // it broke half way; the status is already out there
    } catch (e2) {}
  });
  // A grid scrolling quickly abandons tiles it has moved past, and `pipe` only
  // unpipes on a closed response - it does not close the file. Without this each
  // abandoned tile would leave a descriptor open until the process exits.
  res.on("close", () => stream.destroy());
}

// Why there is no picture, as a status the UI can tell apart: a missing box
// dependency is something a person can fix, and a file this box cannot decode is
// not. The body stays empty - the caller is an <img>.
const IMAGE_ERROR_STATUS = { no_ffmpeg: 501, unsupported: 415, timeout: 504, failed: 500 };
function imageError(res, reason) {
  res.writeHead(IMAGE_ERROR_STATUS[reason] || 404, { "X-Tvbox-Reason": String(reason || "not_found") });
  res.end();
}

const query = (req) => new URLSearchParams((req.url || "").split("?")[1] || "");

/**
 * Answer a GET. Returns true when it did.
 *
 * The static fallbacks are the last thing tried, so an API path can never be
 * shadowed by a file: `serveFallback` is called only after every route below has
 * declined.
 */
function get(p, req, res, ctx) {
  // secret-free config view for the launcher
  if (p === "/tvbox/api/config") {
    httpserver.jsonRes(res, config.publicConfig());
    return true;
  }
  if (p === "/tvbox/api/pairing/status") {
    httpserver.jsonRes(res, { phoneConnected: pairing.phoneConnected() });
    return true;
  }
  // IR blaster backend health for the settings card (connected/lastError)
  if (p === "/tvbox/api/ir/status") {
    httpserver.jsonRes(res, ir.status());
    return true;
  }
  if (p === "/tvbox/api/wifi/status") {
    // The radio state comes from nmcli, not from the config: what the UI shows
    // has to be what the box IS, so a radio something else turned back on does
    // not read as off just because the setting says so.
    system.wifiStatus((s) =>
      system.ethernetStatus((eth) =>
        wifiradio.state(ctx.childEnv(), (radio) =>
          httpserver.jsonRes(res, { ...s, ethernet: eth, radio: radio === null ? null : radio === "enabled" }),
        ),
      ),
    );
    return true;
  }
  // The built-in radios as a lasting setting: what the boot config says, plus
  // whether the root unit that can change it is installed at all. An OTA-only
  // box has this screen and not the unit (root files are provision's), and the
  // UI has to say so rather than offer a switch that cannot work.
  if (p === "/tvbox/api/radios") {
    builtinradio.readState((state) =>
      system.ethernetStatus((eth) =>
        httpserver.jsonRes(res, {
          ...state,
          helper: builtinradio.helperInstalled(),
          ethernet: eth,
        }),
      ),
    );
    return true;
  }
  if (p === "/tvbox/api/system/region") {
    system.systemRegion((r) => httpserver.jsonRes(res, r));
    return true;
  }
  if (p === "/tvbox/api/wifi/list") {
    system.wifiList((n) => httpserver.jsonRes(res, { networks: n }));
    return true;
  }
  if (p === "/tvbox/api/system/info") {
    system.systemInfo((i) => httpserver.jsonRes(res, i));
    return true;
  }
  if (p === "/tvbox/api/update/status") {
    httpserver.jsonRes(res, updater.status());
    return true;
  }
  if (p === "/tvbox/api/backup/status") {
    httpserver.jsonRes(res, { restoredAt: ctx.restoredAt() });
    return true;
  }
  if (p === "/tvbox/api/reconcile/status") {
    httpserver.jsonRes(res, reconcile.state());
    return true;
  }
  if (p === "/tvbox/api/backup/pending-localstorage") {
    httpserver.jsonRes(res, backup.pendingLocalStorage());
    return true;
  }
  if (p === "/tvbox/api/display/status") {
    // Read-only: what the output is at now, what the UI mode should be, and who
    // (if anyone) currently holds a video claim. Resolution is automatic, so
    // there is nothing to pick - the only action is /display/refresh below.
    display.list((info) => {
      const cur = info && info.modes.find((m) => m.current);
      httpserver.jsonRes(res, {
        output: info ? info.output : "",
        current: cur ? { key: cur.key, width: cur.width, height: cur.height, refresh: cur.refreshExact } : null,
        ...ctx.dmode.state(),
      });
    });
    return true;
  }
  if (p === "/tvbox/api/audio/sinks") {
    audio.listSinks(ctx.childEnv(), (sinks) =>
      httpserver.jsonRes(res, { sinks, override: (config.rawAudio() || {}).sink || null }),
    );
    return true;
  }
  if (p === "/tvbox/api/bt/status") {
    bluetooth.status(ctx.childEnv(), (s) => httpserver.jsonRes(res, s));
    return true;
  }
  if (p === "/tvbox/api/bt/devices") {
    bluetooth.list(ctx.childEnv(), (d) => httpserver.jsonRes(res, { devices: d }));
    return true;
  }
  if (p === "/tvbox/api/remote/devices") {
    // Currently-managed remotes (published by the bridge). Merge in the saved
    // keymap per device so the UI shows what's already bound.
    const list = (ctx.readBridgeJson("remote-devices.json", { devices: [] }).devices || []).slice(0, 20);
    const saved = (config.rawRemote() || {}).devices || {};
    httpserver.jsonRes(res, {
      devices: list.map((d) => ({ ...d, keymap: (saved[d.id] && saved[d.id].keymap) || {} })),
    });
    return true;
  }
  if (p === "/tvbox/api/remote/learned") {
    httpserver.jsonRes(res, { learned: ctx.readBridgeJson("remote-learned.json", null) });
    return true;
  }
  if (p === "/tvbox/api/ambient/weather") {
    ambient.weather((config.rawAmbient() || {}).city, (w) => httpserver.jsonRes(res, w || {}));
    return true;
  }
  if (p === "/tvbox/api/ambient/photos") {
    httpserver.jsonRes(res, { photos: ambient.photos() });
    return true;
  }
  if (p === "/tvbox/api/ambient/photo") {
    const name = query(req).get("name") || "";
    // serveStatic guards the root boundary (no traversal)
    httpserver.serveStatic(res, ambient.PHOTO_DIR, name, null);
    return true;
  }
  // TV powered off (from the CEC bridge) -> stop playback
  if (p === "/tvbox/api/tv/standby") {
    player.onTvStandby();
    httpserver.jsonRes(res, { ok: true });
    return true;
  }
  // Fire TV remote IR programming (Settings → Peripherals; shell/firetvir.js)
  if (p === "/tvbox/api/firetvir/status") {
    firetvir.status((s) => httpserver.jsonRes(res, s));
    return true;
  }
  // Which connected remotes are Fire TV / Alexa remotes we can program (expose
  // the keymap GATT service). The remap UI shows the IR feature ONLY for these.
  if (p === "/tvbox/api/firetvir/programmable") {
    firetvir.programmableRemotes((macs) => httpserver.jsonRes(res, { macs }));
    return true;
  }
  // Which connected remotes carry a buzzer we can ring (the finder GATT
  // service). Same shape as the IR one above: the remap UI offers "find this
  // remote" ONLY for these, so a remote without one never shows a dead row.
  if (p === "/tvbox/api/remote/finder/capable") {
    remotefinder.capableRemotes((macs) => httpserver.jsonRes(res, { macs, ringing: remotefinder.isRinging() }));
    return true;
  }
  // The brands the published index carries (shell/irindex.js), with the licence
  // notice that has to travel with the data.
  if (p === "/tvbox/api/firetvir/brands") {
    firetvir.brands((err, r) =>
      httpserver.jsonRes(
        res,
        err ? { ok: false, error: String(err.message || err).slice(0, 200) } : { ok: true, ...r },
      ),
    );
    return true;
  }
  // One brand's codesets merged into the devices they really are - one small file,
  // built by scripts/ir-index/build.js rather than assembled here.
  if (p === "/tvbox/api/firetvir/brand") {
    const slug = query(req).get("slug") || "";
    firetvir.brandDevices(slug, (err, r) =>
      httpserver.jsonRes(
        res,
        err ? { ok: false, error: String(err.message || err).slice(0, 200) } : { ok: true, ...r },
      ),
    );
    return true;
  }
  // What this remote was set up to drive. The remote's own keymap cannot be read
  // back, so this file is the only record there is.
  if (p === "/tvbox/api/firetvir/plan") {
    const plan = firetvir.readPlan(query(req).get("mac") || "");
    // null covers both a bad MAC and a plan file that could not be read, and the
    // screen treats either the same way: it must not offer a setup that would be
    // written over the real one.
    httpserver.jsonRes(res, plan ? { ok: true, plan } : { ok: false, error: "could not read the saved setup" });
    return true;
  }
  if (p === "/tvbox/api/fileserver") {
    const st = fileserver.status(config.rawFileserver(), sharing.fileserverDeps());
    httpserver.jsonRes(res, { ...st, installing: sharing.isInstallingRclone() });
    return true;
  }
  if (p === "/tvbox/api/appshares") {
    // Re-read the manifests, like /tvbox/api/apps does: an app installed since
    // boot brings its shares with it, and without this they appear only after
    // something else happened to refresh the cache.
    apps.loadManifests();
    const cfg = config.rawAppshares();
    const st = appshares.status(cfg, sharing.appsharesDeps());
    // Peers without their tokens: the launcher needs to name a box and nothing more.
    const list = (cfg.peers || []).map((x) => ({ id: x.id, name: x.name, host: x.host }));
    httpserver.jsonRes(res, { ...st, peers: list, installing: sharing.isInstallingRclone() });
    return true;
  }
  // What there is to play on the box itself: the user's own folders and each
  // partition of a plugged-in USB stick (browse.js). Read-only; the app that
  // walks them is the registry's `files` package, and mounting is a POST.
  if (p === "/tvbox/api/shares") {
    httpserver.jsonRes(res, {
      ...shares.status(config.rawShares(), sharing.sharesDeps()),
      installing: sharing.isInstallingRclone(),
    });
    return true;
  }
  // Screen mirroring. `available` is what greys the tile: a box whose radio is
  // carrying its own network cannot do this at all, and saying so up front is
  // better than a button that always fails.
  if (p === "/tvbox/api/miracast") {
    const st = ctx.mirroring.state();
    httpserver.jsonRes(res, {
      armed: ctx.mirroring.isArmed(),
      streaming: ctx.mirroring.isStreaming(),
      name: st.name || "",
      ssid: st.ssid || "",
      channel: st.channel || "",
    });
    return true;
  }
  if (p === "/tvbox/api/browse/sources") {
    browse.sources(browseDeps, (s) => httpserver.jsonRes(res, s));
    return true;
  }
  if (p === "/tvbox/api/browse/list") {
    browse.list(browseDeps, query(req).get("path") || "", (r) => httpserver.jsonRes(res, r));
    return true;
  }
  // A photo, at a size a TV can hold: `thumb` for a grid tile, `image` for the
  // viewer. Neither ever returns the source file - images.js re-encodes, or
  // hands back the thumbnail the camera itself wrote - so a path that gets past
  // the containment check below still cannot spill the contents of a file that
  // is not an image.
  //
  // The caller appends the entry's mtime as `v`, which nothing here reads: it is
  // what makes each answer immutable for its URL, so a grid scrolling back over
  // a tile takes it from Chromium's cache instead of asking again.
  if (p === "/tvbox/api/browse/thumb" || p === "/tvbox/api/browse/image") {
    const q = query(req);
    const wantView = p.endsWith("/image");
    browse.file(browseDeps, q.get("path") || "", (r) => {
      if (!r.ok) return imageError(res, r.error);
      const done = (err, out) => (err ? imageError(res, err) : sendImage(res, out));
      if (wantView) images.view(r.path, Number(q.get("w")) || 0, done);
      else images.thumb(r.path, done);
    });
    return true;
  }
  if (p === "/tvbox/api/phoneremote") {
    // The paired phones live here rather than in publicConfig: their rows carry
    // a token hash, and this list is names and times only.
    httpserver.jsonRes(res, {
      enabled: !!config.rawPhoneRemote().enabled,
      phones: phoneremote.list(),
      port: phoneremote.PORT,
      // When the screen share runs out, so Settings can count it down rather
      // than just say "on".
      screenUntil: phoneremote.screenUntil(),
      // Where a phone goes. The same for every one of them - a token tells them
      // apart, not the address - and deliberately NOT a pairing code: minting
      // one for someone who just wanted the address would invalidate the code a
      // phone is holding.
      url: phoneremote.address(),
    });
    return true;
  }
  if (p === "/tvbox/api/photoshare") {
    httpserver.jsonRes(res, { names: photoshare.list(), max: photoshare.MAX_ITEMS });
    return true;
  }
  // The same two as browse's, for photos a phone cast at the viewer. A different
  // containment rule - one flat directory, and a name pattern with no separator in
  // it - so this does not need to be a browse root to be readable.
  if (p === "/tvbox/api/photoshare/thumb" || p === "/tvbox/api/photoshare/image") {
    const q = query(req);
    const file = photoshare.pathFor(q.get("name") || "");
    if (!file) {
      imageError(res, "not_found");
      return true;
    }
    const done = (err, out) => (err ? imageError(res, err) : sendImage(res, out));
    if (p.endsWith("/image")) images.view(file, Number(q.get("w")) || 0, done);
    else images.thumb(file, done);
    return true;
  }
  // App-store registry (Settings → Store). ?refresh=1 bypasses the 5-min cache.
  if (p === "/tvbox/api/store/list") {
    const refresh = (req.url || "").includes("refresh=1");
    store
      .listForUi(config)(refresh)
      // Merge in live install state so the store can show progress + poll it:
      // each entry gains `installing` and a coarse `progress.phase`.
      .then((d) => {
        const list = (d.apps || []).map((e) => ({
          ...e,
          installing: maintenance.isInstalling(e.id),
          progress: maintenance.progressFor(e.id) || null,
          flatpakStatus: maintenance.flatpakStatusFor(e.id), // result of the last manual flatpak update
        }));
        httpserver.jsonRes(res, { ...d, apps: list, installing: maintenance.installingIds() });
      })
      .catch((e) => httpserver.jsonRes(res, { apps: [], error: String(e.message || e).slice(0, 120) }));
    return true;
  }
  if (p === "/tvbox/api/power/sleep-timer") {
    httpserver.jsonRes(res, { at: ctx.sleepTimer() });
    return true;
  }
  if (p === "/tvbox/api/widgets") {
    httpserver.jsonRes(res, { widgets: ctx.widgetList() });
    return true;
  }
  // The launcher's app list. Manifests are re-read on every call (a handful of
  // small JSON files) so a dropped-in ~/.tvbox/apps manifest appears as a tile
  // live - no shell restart. Plugins/services still load at boot only.
  if (p === "/tvbox/api/apps") {
    apps.loadManifests();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ctx.appTiles()));
    return true;
  }
  // (Live TV data routes /tvbox/api/livetv/* are registered by the livetv plugin.)
  return false;
}

/**
 * Everything that is a FILE rather than an answer: the launcher, an installed
 * package app's own web/ bundle, and the root-mounted web-client app's SPA.
 * Reached only once every route above has declined.
 */
function serveFallback(p, res, ctx) {
  // HOME launcher (our React app) under /tvbox/, relative assets
  if (p === "/tvbox" || p === "/tvbox/") p = "/tvbox/index.html";
  if (p.startsWith("/tvbox/")) {
    httpserver.serveStatic(res, ctx.launcherDir, p.slice("/tvbox/".length), null);
    return;
  }
  // An installed PACKAGE app serves its own web/ bundle at /<id>/... . Package
  // apps live at ~/.tvbox/apps/<id>/ (dir-app: manifest.json + optional
  // plugin.js + web/ UI); the manifest carries _dir. Served from the same
  // origin as /tvbox/api, so the app reaches its own plugin routes with a
  // plain same-origin fetch - no extra capability needed.
  {
    const seg = (p.split("/")[1] || "").toLowerCase();
    const m = seg && /^[a-z0-9_-]+$/.test(seg) ? apps.manifestById(seg) : null;
    // Only a package app that opts into local serving (serve:"local") is
    // mounted at /<id>/; this keeps it from shadowing the root web app's
    // (Plex's) top-level asset paths on an id collision.
    if (m && m._dir && m.runtime && m.runtime.serve === "local") {
      const webRoot = path.join(m._dir, "web");
      if (fs.existsSync(webRoot)) {
        const entry = path.join(webRoot, "index.html");
        const sub = p.slice(1 + seg.length + 1) || "index.html"; // strip "/<seg>/"
        httpserver.serveStatic(res, webRoot, sub, entry);
        return;
      }
    }
  }
  // everything else: the root-mounted web-client app's SPA (index fallback)
  const a = ctx.rootWebApp();
  if (!a) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no root app");
    return;
  }
  const root = apps.appDataDir(a.id);
  const entry = (a.runtime && a.runtime.entry) || "index.html";
  if (p === "/") p = "/" + entry;
  httpserver.serveStatic(res, root, p, path.join(root, entry));
}

module.exports = { get, serveFallback, guardedGet, sendImage, imageError, IMAGE_ERROR_STATUS };
