// tvbox Electron shell. A single fullscreen window that hosts the HOME launcher
// (our React app, served under /tvbox/) and "apps" described by manifests in
// apps/. Web-client apps (e.g. Plex HTPC) are served from their installed
// bundle and composited over mpv, which plays video BEHIND the transparent
// window driven over its JSON IPC. Apps get a capability-scoped bridge
// (preload.js); the remote Home button returns to the launcher from anywhere.
// Run: electron . --ozone-platform=wayland --no-sandbox
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn, execFile } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const config = require("./config");
const pairing = require("./pairing");
const display = require("./display"); // wlr-randr resolution/refresh control
const audio = require("./audio"); // wpctl sink list + volume (device audio settings)
const bluetooth = require("./bluetooth"); // bluetoothctl pair/connect (audio + input devices)
const ambient = require("./ambient"); // weather + local photos for the idle/ambient screen
const mqttBridge = require("./mqtt"); // MQTT: now-playing publish + command/notify (HA integration)
const ir = require("./ir"); // IR blaster hub: TV volume/mute over ESPHome or Home Assistant
const appwins = require("./appwindows"); // background-apps window registry + hidden-set policy (LRU/RAM guard)
const firetvir = require("./firetvir"); // Fire TV remote IR programming (venv deps + irdb codesets + BLE tool)
const apps = require("./install"); // manifests + install-recipe runner (shared with the tvbox CLI)
const store = require("./store"); // app-store registry client (manifest-only apps -> ~/.tvbox/apps)
const appfetch = require("./appfetch"); // capability: scoped server-side fetch (data proxy), origin-locked + SSRF-guarded
const netguard = require("./netguard"); // shared loopback/LAN/public host classification + lanIp
const appdata = require("./appdata"); // capability: per-app key/value storage under ~/.tvbox/appdata
const updater = require("./updater"); // OTA self-update (versions/ + `current` symlink flip)
const backup = require("./backup"); // encrypted settings backup/restore (phone pairing page)
const backupPairing = require("./pairing/backup");
const { Supervisor } = require("./service_supervisor"); // generic supervised child procs (plugins use it)
const pkg = require("./package.json"); // shell version (About/diagnostics)

const { PORT } = require("./constants");
const BASE = "http://localhost:" + PORT;
const IPC = "/tmp/tvbox-mpv.sock";
const APP_ID = "tvbox-shell"; // Wayland app_id (== package.json name); used by wlrctl raise
const LAUNCHER = path.join(__dirname, "launcher-dist"); // built React launcher (served under /tvbox/)
// Inherit the session's Wayland env (run-shell.sh exports it); only fill gaps:
// hardcoding uid 1000 breaks boxes whose first user isn't 1000 (Pi Imager custom user).
const WL_ENV = {
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/" + process.getuid(),
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
};

// Auto-route audio: detect the present HDMI sink at runtime (TV/port-independent),
// set it as default, AND remember its node.name so we can pass it to mpv as an
// explicit --audio-device (mpv's "default" resolves to "no target node" here).
let audioSink = null;
function ensureAudio(done) {
  // Pass the manual override (if the user picked a sink in Settings); the script
  // uses it when present and otherwise auto-detects the HDMI sink.
  const pref = (config.rawAudio() && config.rawAudio().sink) || "";
  try {
    execFile(
      "sh",
      [path.join(__dirname, "audio-default.sh"), pref],
      { env: { ...process.env, ...WL_ENV } },
      (_e, stdout) => {
        const name = ((stdout || "").trim().split("\n").pop() || "").trim();
        if (name) audioSink = name;
        if (done) done();
      },
    );
  } catch (e) {
    if (done) done();
  }
}

// Pin userData to a name-independent path so renaming the package never loses
// app state (each web-client app's login lives in localStorage there).
app.setPath("userData", path.join(os.homedir(), ".tvbox", "shell-userdata"));

app.commandLine.appendSwitch("ozone-platform", "wayland");
app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");

// Electron ≥43 delivers console-message as a details object (the first arg,
// carrying a STRING `level` of "debug"|"info"|"warning"|"error"; the old
// numeric-positional signature is gone). Map that level back to the short tags
// the shell log always used - "debug" takes the old verbose "log" slot, and any
// unmapped level falls through to "?" at the call site.
const CONSOLE_TAG = { debug: "log", info: "info", warning: "warn", error: "error" };

const MIME = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".map": "application/json",
};

let win = null;
let mpv = null;
let mpvPip = false; // mpv is in PiP (small top-right) mode, not fullscreen
let playingUrl = null;
let mpvOwnerId = null; // app id whose player broker call launched mpv (video-mode target)
let currentAppId = null; // which app is FOREGROUND (null = launcher); drives focus + video-mode targeting
// Background apps: every app runs in its OWN BrowserWindow; leaving an app
// hides its window (registry + hidden-set policy live in appwindows.js). A
// window is destroyed only by the HOME quit affordance, the RAM guard, app
// uninstall/update, its own crash, or config.apps.background=false (the
// rollback lever to the old destroy-on-leave behavior).
function appWindow(id) {
  return appwins.get(id);
}
function foregroundWindow() {
  return (currentAppId && appWindow(currentAppId)) || (win && !win.isDestroyed() ? win : null);
}
let mqttCtl = null; // MQTT bridge control (publish/…) once connected; null if not configured
let nowPlaying = null; // last launcher-reported now-playing (Spotify/Live TV) - gates auto-update idleness
let restoredAt = null; // a backup restore just ran; the launcher polls this to show "restarting"
const queued = { url: null, startPos: 0 };

// The box counts as idle for a self-initiated restart (nightly auto-update)
// only when nothing is on screen or audible: no mpv, launcher focused, and the
// last now-playing report isn't "playing" (librespot audio has no mpv process
// to look at). HIDDEN app windows don't block idleness - they're muted/paused,
// and the restart simply drops them (they reload on next launch).
function boxIdle() {
  return !mpv && !currentAppId && !(nowPlaying && nowPlaying.state === "playing");
}
// Restart the shell in-place: quit cleanly (localStorage flush, plugin stop);
// the labwc respawn loop relaunches run-shell.sh, which follows the `current` symlink.
function restartShell(why) {
  console.log("[main] restarting shell:", why || "");
  app.quit();
}

// ---- plugins (manifest-selected shell-side modules, e.g. Spotify) ----
// A plugin is loaded ONLY when its app is present and its declared binary deps
// resolve; it gets a scoped `host` API (below) and never touches shell internals.
const supervisor = new Supervisor(); // shared supervised-child manager for plugins
const loadedPlugins = []; // { start, stop } from each plugin factory
const loadedPluginIds = new Set(); // app ids whose plugin is loaded (dedupe hot-load vs boot)
const pluginRoutes = []; // [{ prefix, table }] - HTTP routes a plugin registered
const configListeners = []; // plugins that react to a config write (e.g. Live TV drops its cache)
// Notify plugins that config sections changed (host.onConfigChange). A package
// plugin can't reach the shell config write directly, so this is how e.g. the
// Live TV plugin invalidates its channel/EPG cache when the IPTV source changes.
function emitConfigChange(sections) {
  if (!sections || !sections.length) return;
  for (const cb of configListeners) {
    try {
      cb(sections);
    } catch (e) {
      console.warn("[config] listener:", e.message);
    }
  }
}
const installing = new Set(); // app ids whose bundle is being installed on-demand (UI)
// Per-app install progress for the store UI: id -> { phase }. `phase` is a
// coarse, reliable stage the launcher turns into "Downloading.../Installing..."
// text (not a fragile parsed %), so an install shows a live stage instead of a
// frozen screen. Every install step is also appended to ~/.tvbox/install.log so
// a slow/stuck install can be diagnosed (there was no install log before).
const installProgress = new Map(); // id -> { phase: "deps" | "bundle" | "finishing" }
const INSTALL_LOG = path.join(os.homedir(), ".tvbox", "install.log");
function setInstallPhase(id, phase) {
  if (phase) installProgress.set(id, { phase });
  else installProgress.delete(id);
}
function logInstall(id, line) {
  try {
    fs.appendFileSync(INSTALL_LOG, "[" + id + "] " + line + "\n");
  } catch (e) {
    /* best effort - a missing log must never fail an install */
  }
}
// Run `cli.js <args>` for app <id> at stage <phase>, piping its output to the
// install log (so flatpak/curl progress is inspectable) and resolving true on a
// clean exit. Used for both the bundle fetch and the no-root binary-dep install.
function spawnCli(args, id, phase) {
  return new Promise((resolve) => {
    setInstallPhase(id, phase);
    logInstall(id, phase + " start: cli " + args.join(" "));
    const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), ...args], {
      env: { ...process.env, ...WL_ENV, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (d) =>
      String(d)
        .split(/\r?\n/)
        .forEach((l) => l.trim() && logInstall(id, l.trim()));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      logInstall(id, phase + " spawn error: " + e.message);
      resolve(false);
    });
    child.on("exit", (code) => {
      logInstall(id, phase + " exit " + code);
      resolve(code === 0);
    });
  });
}
// Full provision of a just-installed store app: fetch its no-root binary deps
// AND its bundle (whichever it declares), in order, from ONE store action - so
// the user never has to press the HOME tile to finish an install, and the app
// only reaches HOME once it is actually launchable. A `service` app's plugin
// still loads at boot, so it restarts once at the end (gated on idle); that is
// the last step, after everything is in place (hot-loading without a restart is
// a follow-up). Progress + the installing flag drive the store UI.
async function provisionFull(id) {
  const m = apps.manifestById(id);
  if (!m || installing.has(id)) return;
  installing.add(id);
  let ok = true;
  try {
    const deps = apps.appDeps(m);
    if (!deps.depsOk && deps.installable) ok = await spawnCli(["deps", id, "--download-only"], id, "deps");
    if (ok && m.install && m.install.source && !apps.isInstalled(id))
      ok = await spawnCli(["install", id], id, "bundle");
  } catch (e) {
    logInstall(id, "provision error: " + (e.message || e));
    ok = false;
  }
  // Activate a service app's plugin WITHOUT a restart: hot-load registers its
  // routes on the live server and starts its daemon. Only if hot-load fails do
  // we fall back to a one-off restart (and only when idle, so nothing playing is
  // interrupted); otherwise the plugin just loads on the next natural boot.
  if (ok && m.service) {
    setInstallPhase(id, "finishing");
    if (hotLoadPlugin(id)) {
      installing.delete(id);
      setInstallPhase(id, null);
      return;
    }
    if (boxIdle()) {
      setTimeout(() => restartShell("service install (hot-load failed): " + id), 1200);
      return; // keep installing/phase set until the restart
    }
  }
  installing.delete(id);
  setInstallPhase(id, null);
}

// ---- app manifests + install (the install-recipe runner lives in install.js,
// shared with the `tvbox` CLI; the shell just queries manifests + serves apps) ----
function appTiles() {
  // the subset the launcher needs to draw a tile (+ dependency status so it can
  // grey out an app whose required binary isn't installed)
  return apps.getManifests().map((m) => {
    const { depsOk, missing, installable: depsInstallable } = apps.appDeps(m);
    // installable = has a bundle install recipe (flatpak/url/git) that can be
    // provisioned from the UI without root (e.g. Plex). installed = its bundle is
    // present. A webclient with installable && !installed needs a one-tap install.
    const installable = !!(m.install && m.install.source);
    // A remote web-app whose URL comes from config (runtime.urlConfig) is only
    // launchable once that URL is set (e.g. Home Assistant). Everything else is
    // always "configured" so the launcher gates only what actually needs it.
    const rt = m.runtime || {};
    const configured = rt.serve === "remote" && rt.urlConfig ? !!(config.appConfig(rt.urlConfig) || {}).baseUrl : true;
    return {
      id: m.id,
      name: m.name,
      tagline: m.tagline,
      type: m.type,
      status: m.status,
      accent: m.accent,
      icon: m.icon,
      // background apps: a live (possibly hidden) window exists; HOME shows a
      // running badge + quit affordance, resume is instant via navTo
      running: !!appwins.get(m.id),
      foreground: m.id === currentAppId,
      depsOk,
      missing,
      depsInstallable, // every missing binary is a no-root download dep -> UI-installable (no CLI)
      installable,
      installed: apps.isInstalled(m.id),
      installing: installing.has(m.id),
      configured,
      // Launchable = belongs on HOME: ready status, binary deps present,
      // configured, a bundle app has its bundle, and not mid-install. HOME shows
      // ONLY these, so a still-installing / not-yet-provisioned app stays in the
      // store (with progress) instead of appearing greyed on HOME.
      ready:
        m.status === "ready" &&
        depsOk &&
        configured &&
        !installing.has(m.id) &&
        (!installable || apps.isInstalled(m.id)),
      progress: installProgress.get(m.id) || null,
    };
  });
}
function capsFor(id) {
  // The launcher (id null) is the trusted first-party UI that hosts builtin apps,
  // so it gets player + config too. An app gets exactly what its manifest declares
  // and defaults to nav-only - a manifest that forgets `capabilities` must NOT
  // silently inherit player/config (that boundary would fail open).
  if (!id) return ["nav", "player", "config"];
  const m = apps.manifestById(id);
  return (m && m.runtime && m.runtime.capabilities) || ["nav"];
}
function rootWebApp() {
  return apps
    .getManifests()
    .find((m) => m.type === "webclient" && m.runtime && m.runtime.mount === "root" && m.status === "ready");
}

// The app DOM element that must become transparent to reveal mpv (declared per
// app in the manifest, e.g. Plex's "#media-container"). The shell has no
// app-specific selector baked in.
function transparentSelectorFor(id) {
  const m = id && apps.manifestById(id);
  return (m && m.runtime && m.runtime.transparentSelector) || null;
}

// One-time stylesheet per window (each app has its own window now; the flag
// lives on the window and resets on navigation); switch between "video mode"
// (page transparent so the mpv window behind shows through) and idle (opaque
// black backdrop, never the desktop) by toggling a class SYNCHRONOUSLY in the
// renderer - avoids the insertCSS/removeInsertedCSS races that left resumed
// video black.
async function ensureStyle(w) {
  w = w || win;
  if (!w || w.isDestroyed() || w.tvboxStyleInjected) return;
  w.tvboxStyleInjected = true;
  const sel = transparentSelectorFor(w.tvboxAppId || null);
  const extra = sel ? ",html.tvbox-video " + sel : "";
  try {
    await w.webContents.insertCSS(
      "html:not(.tvbox-video)::before{content:'';position:fixed;inset:0;background:#000;z-index:-1;}" +
        "html.tvbox-video,html.tvbox-video body" +
        extra +
        "{background:transparent !important;background-color:transparent !important;}",
    );
  } catch (e) {
    w.tvboxStyleInjected = false;
  }
}
// Reveal (on=true, targets the mpv owner's window) or restore the opaque
// backdrop. Clearing without a target clears EVERY live window - teardown
// paths run after focus/ownership already changed, and the class is
// idempotent, so blanket-clearing is the race-free option.
function setVideoMode(on, w) {
  const flip = (x) => {
    if (!x || x.isDestroyed()) return;
    x.webContents
      .executeJavaScript("document.documentElement.classList." + (on ? "add" : "remove") + "('tvbox-video')")
      .catch(() => {});
  };
  if (on) flip(w || appWindow(mpvOwnerId) || win);
  else if (w) flip(w);
  else {
    flip(win);
    for (const [, aw] of appwins.all()) flip(aw);
  }
}

// ---- HTTP: launcher (/tvbox/), app manifests API, and the root web app (Plex) ----
function serveStatic(res, root, p, spaFallback) {
  const fp = path.join(root, p);
  const base = root.endsWith(path.sep) ? root : root + path.sep; // boundary: don't match sibling dirs
  if ((fp === root || fp.startsWith(base)) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    fs.createReadStream(fp).pipe(res);
  } else if (spaFallback && fs.existsSync(spaFallback)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(spaFallback));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}
function jsonRes(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function handlePost(p, data, res) {
  if (p === "/tvbox/api/config") {
    const changed = [];
    if (data.iptv) {
      config.setIptv(data.iptv);
      changed.push("iptv");
    }
    if (data.parental) {
      config.setParental(data.parental);
      changed.push("parental");
    }
    if (data.spotify) {
      config.setSpotify(data.spotify);
      changed.push("spotify");
    }
    if (data.display) {
      config.setDisplay(data.display); // e.g. { matchFramerate } toggle
      changed.push("display");
    }
    if (data.ambient) {
      config.setAmbient(data.ambient);
      changed.push("ambient");
    }
    if (data.update) {
      // only the two toggles; the feed URL stays box-local. Partial saves must
      // not clobber the other toggle, so pass through only what was sent.
      const upd = {};
      if (data.update.auto !== undefined) upd.auto = data.update.auto !== false;
      if (data.update.appsAuto !== undefined) upd.appsAuto = data.update.appsAuto !== false;
      config.setUpdate(upd);
      changed.push("update");
    }
    if (data.ui) {
      config.setUi(data.ui); // launcher prefs (clock format) - whitelisted in config.js
      changed.push("ui");
    }
    if (data.player) {
      config.setPlayer(data.player); // mpv track-language defaults - validated in config.js
      changed.push("player");
    }
    if (data.wifi) {
      config.setWifi(data.wifi); // regulatory country - applied by the root boot unit
      changed.push("wifi");
    }
    if (data.mqtt) {
      config.setMqtt(data.mqtt); // whitelisted/sanitized in config.js; empty host clears = integration off
      applyMqttConfig(); // reconnect the bridge to the new broker right away
      changed.push("mqtt");
    }
    if (data.remote) {
      config.setRemote(data.remote); // per-device button remap (sanitized in config.js)
      remoteBridgeCmd("reload"); // tell the bridge to re-read the keymap
      changed.push("remote");
    }
    if (data.ir) {
      config.setIr(data.ir); // IR blaster backend + action map (sanitized in config.js)
      ir.applyConfig(); // reconnect the backend right away
      remoteBridgeCmd("reload"); // the bridge re-reads whether volume keys go to IR
      changed.push("ir");
    }
    if (data.apps) {
      config.setApps(data.apps); // background-apps toggle (whitelisted in config.js)
      changed.push("apps");
    }
    emitConfigChange(changed); // e.g. Live TV drops its channel/EPG cache on a new IPTV source
    return jsonRes(res, { ok: true, config: config.publicConfig() });
  }
  if (p === "/tvbox/api/display/apply") {
    return applyDisplayMode(String(data.mode || ""), res);
  }
  if (p === "/tvbox/api/audio/default") {
    // persist the override (empty string clears it -> back to auto), then re-apply
    config.setAudio({ sink: String(data.sink || "") });
    return ensureAudio(() => jsonRes(res, { ok: true, sink: audioSink }));
  }
  if (p === "/tvbox/api/audio/volume") {
    return audio.setVolume({ ...process.env, ...WL_ENV }, Number(data.id), Number(data.volume), (ok) =>
      jsonRes(res, { ok }),
    );
  }
  if (p === "/tvbox/api/ir/send") {
    // IR blaster: abstract TV command (volume_up/volume_down/mute), optionally
    // repeated (steps). Callers: the remote bridge (BT volume keys) + the
    // settings UI test buttons. A dead blaster answers ok:false, never a 500.
    return ir.send(String(data.action || ""), data.steps).then(
      (r) => jsonRes(res, r),
      (e) => jsonRes(res, { ok: false, error: String((e && e.message) || e) }),
    );
  }
  if (p === "/tvbox/api/nav") {
    // Launcher/app navigation from the remote bridge (remapped "settings" /
    // "app:<id>" buttons). Settings: launcher already up -> in-page event (no
    // reload); app fullscreen -> leave it and boot the launcher on the target
    // view via the #hash. App launch: navTo (no-ops on unknown/not-ready ids).
    const dest = String(data.dest || "");
    if (dest === "app") {
      const id = String(data.app || "");
      if (!/^[a-z0-9_-]{1,32}$/.test(id)) return jsonRes(res, { ok: false, error: "invalid app id" });
      navTo(id);
      return jsonRes(res, { ok: true, dest, app: id });
    }
    if (dest === "switch") {
      switchApp(); // cycle through running apps (the appswitcher remap action)
      return jsonRes(res, { ok: true, dest, app: currentAppId });
    }
    if (dest !== "home" && dest !== "settings") return jsonRes(res, { ok: false, error: "unknown dest: " + dest });
    if (currentAppId !== null) showLauncher(dest === "settings" ? "#settings" : "");
    else if (win && !win.isDestroyed()) win.webContents.send("tvbox-nav", { dest });
    return jsonRes(res, { ok: true, dest });
  }
  if (p === "/tvbox/api/apps/quit") {
    // HOME's running-apps row: really exit a background app (its window and
    // page state are dropped; next launch is a fresh start).
    const id = String(data.id || "");
    if (!appWindow(id)) return jsonRes(res, { ok: false, error: "not running" });
    destroyAppWindow(id);
    return jsonRes(res, { ok: true, id });
  }
  // Fire TV remote IR programming (Settings → Peripherals; shell/firetvir.js)
  if (p === "/tvbox/api/firetvir/deps") {
    return jsonRes(res, { ok: firetvir.installDeps() }); // progress is polled via /firetvir/status
  }
  if (p === "/tvbox/api/firetvir/test") {
    firetvir.testKey(String(data.mac || ""), String(data.path || ""), String(data.key || ""), (err, r) =>
      jsonRes(res, err ? { ok: false, error: String(err.message || err).slice(0, 200) } : r),
    );
    return;
  }
  if (p === "/tvbox/api/firetvir/program") {
    firetvir.program(String(data.mac || ""), String(data.path || ""), String(data.label || ""), (err, r) =>
      jsonRes(res, err ? { ok: false, error: String(err.message || err).slice(0, 200) } : r),
    );
    return;
  }
  if (p === "/tvbox/api/firetvir/erase") {
    firetvir.erase(String(data.mac || ""), (err, r) =>
      jsonRes(res, err ? { ok: false, error: String(err.message || err).slice(0, 200) } : r),
    );
    return;
  }
  if (p === "/tvbox/api/nowplaying") {
    // launcher pushes the current now-playing (Spotify / Live TV); bridge it to
    // MQTT (retained) for HA, and remember it for the auto-update idle gate.
    nowPlaying = data;
    if (mqttCtl) mqttCtl.publish("nowplaying", data, { retain: true });
    return jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/update/check") {
    updater.check().then((s) => jsonRes(res, s));
    return;
  }
  if (p === "/tvbox/api/update/apply") {
    // async: download/npm ci can take minutes - respond now, the UI polls status
    updater.apply();
    return jsonRes(res, updater.status());
  }
  if (p === "/tvbox/api/update/clear-failed") {
    return jsonRes(res, updater.clearFailed());
  }
  if (p === "/tvbox/api/backup/context") {
    // launcher hands over its localStorage snapshot right before the backup QR
    backupPairing.setContext(data);
    return jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/backup/pending-localstorage/clear") {
    backup.clearPendingLocalStorage();
    return jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/power") {
    return handlePower(String(data.action || ""), res);
  }
  if (p === "/tvbox/api/ambient/photos/clear") {
    return jsonRes(res, { ok: true, removed: ambient.clearPhotos() });
  }
  if (p === "/tvbox/api/ambient/photos/delete") {
    return jsonRes(res, { ok: ambient.deletePhoto(String(data.name || "")) });
  }
  if (p === "/tvbox/api/bt/scan") {
    return bluetooth.scan({ ...process.env, ...WL_ENV }, Number(data.seconds) || 8, (devices) =>
      jsonRes(res, { devices }),
    );
  }
  if (p.startsWith("/tvbox/api/bt/")) {
    const action = p.slice("/tvbox/api/bt/".length);
    const fn = {
      pair: bluetooth.pair,
      connect: bluetooth.connect,
      disconnect: bluetooth.disconnect,
      remove: bluetooth.remove,
    }[action];
    const mac = String(data.mac || "").toUpperCase();
    if (!fn) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) return jsonRes(res, { ok: false, error: "bad mac" });
    return fn({ ...process.env, ...WL_ENV }, mac, (r) => jsonRes(res, r));
  }
  if (p === "/tvbox/api/remote/learn") {
    // Enter learn mode for a device: the bridge captures & reports the next
    // button pressed on it (id may contain spaces -> rest-of-line in the FIFO).
    const id = String((data && data.id) || "").replace(/[\r\n]/g, "");
    if (!id) return jsonRes(res, { ok: false, error: "no id" });
    remoteBridgeCmd("learn " + id);
    return jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/remote/learn-off") {
    remoteBridgeCmd("learn-off");
    return jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/parental/verify") {
    return jsonRes(res, { ok: config.verifyPin(String(data.pin || "")) });
  }
  if (p === "/tvbox/api/pairing/start") {
    return jsonRes(res, pairing.start(data.locale, data.kind)); // kind: "iptv" (default) | "spotify"
  }
  if (p === "/tvbox/api/pairing/stop") {
    pairing.stop();
    return jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/apps/install") {
    return startInstall(String(data.id || ""), res);
  }
  if (p === "/tvbox/api/apps/deps") {
    return startDeps(String(data.id || ""), res);
  }
  if (p === "/tvbox/api/store/install") {
    const id = String(data.id || "");
    store
      .install(config, id)
      .then((r) => {
        jsonRes(res, r);
        // The manifest is on disk; now finish the install (no-root binary deps +
        // bundle) in the SAME action, so the app reaches HOME only once it is
        // actually launchable - no "press the tile to finish" step. provisionFull
        // handles the final service-plugin restart itself, gated on idle.
        if (r.ok) provisionFull(id);
      })
      .catch((e) => jsonRes(res, { ok: false, error: String(e.message || e).slice(0, 120) }));
    return;
  }
  if (p === "/tvbox/api/store/uninstall") {
    const id = String(data.id || "");
    if (currentAppId === id) showLauncher();
    destroyAppWindow(id); // a background window must not outlive its app
    setWidget(id, null);
    return jsonRes(res, store.uninstall(id));
  }
  if (p === "/tvbox/api/config/app") {
    // Set a urlConfig app's address: { key, baseUrl } (http/https or empty to clear).
    const key = String(data.key || "");
    const baseUrl = String(data.baseUrl || "").trim();
    if (baseUrl && !/^https?:\/\/\S+$/.test(baseUrl)) return jsonRes(res, { ok: false, error: "bad url" });
    return jsonRes(res, { ok: config.setAppConfig(key, { baseUrl }) });
  }
  if (p === "/tvbox/api/apps/remove") {
    // Drop an installed web-client bundle (apps-data/<id>). The manifest stays,
    // so the tile reverts to its "installable" state - the UI mirror of
    // `tvbox remove <id>`.
    const id = String(data.id || "");
    const m = apps.manifestById(id);
    if (!m || m.type !== "webclient") return jsonRes(res, { ok: false, error: "not removable" });
    if (installing.has(id)) return jsonRes(res, { ok: false, error: "install in progress" });
    if (currentAppId === id) showLauncher(); // never yank the bundle out from under the running app
    destroyAppWindow(id); // incl. a hidden background window
    return jsonRes(res, { ok: true, removed: apps.removeApp(id) });
  }
  if (p === "/tvbox/api/wifi/connect") {
    return wifiConnect(String(data.ssid || ""), String(data.password || ""), !!data.hidden, (r) => jsonRes(res, r));
  }
  if (p === "/tvbox/api/power/sleep-timer") {
    return jsonRes(res, setSleepTimer(data.minutes)); // 0/absent = cancel
  }
  if (p === "/tvbox/api/wifi/forget") {
    return wifiForget(String(data.ssid || ""), (r) => jsonRes(res, r));
  }
  if (p === "/tvbox/api/system/timezone") {
    return setTimezone(String(data.timezone || ""), (r) => jsonRes(res, r));
  }
  if (p === "/tvbox/api/system/keymap") {
    return setKeymap(String(data.keymap || ""), (r) => jsonRes(res, r));
  }
  if (p === "/tvbox/api/system/hostname") {
    return setHostname(String(data.hostname || ""), (r) => jsonRes(res, r));
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

// Low-battery warning for connected BT remotes - a dead remote is a bricked
// TV, so surface it while there's still charge. One toast per device per day;
// the launcher localizes the { kind: "lowBattery" } payload itself.
const btWarned = new Map(); // mac -> day stamp
function btBatteryTick() {
  bluetooth.list({ ...process.env }, (devices) => {
    const day = new Date().toDateString();
    for (const d of devices || []) {
      if (!d.connected || d.battery == null || d.battery > 15) continue;
      if (btWarned.get(d.mac) === day) continue;
      btWarned.set(d.mac, day);
      console.log("[bt] low battery:", d.name, d.battery + "%");
      handleTvNotify({ kind: "lowBattery", name: d.name, battery: d.battery });
    }
  });
}

// Nightly app auto-update (the Fire TV model): in the OTA updater's 03-06h
// window, when the box is idle and update.appsAuto isn't turned off, install
// every pending registry update through the EXACT same path as the store's
// Update button (store.install + provisionFull) - provisionFull's own idle
// gating handles any service-plugin restart. One app at a time; re-checked
// between apps so a wake-up aborts the run.
let appsAutoBusy = false;
async function appsAutoTick() {
  const u = config.rawUpdate() || {};
  if (u.appsAuto === false) return;
  const h = new Date().getHours();
  if (h < 3 || h > 5) return;
  if (appsAutoBusy || installing.size || !boxIdle()) return;
  appsAutoBusy = true;
  try {
    const l = await store.listForUi(config)(true);
    for (const id of l.updates || []) {
      // re-checked per app: a user install started during the awaited registry
      // refresh (or a provisionFull that just scheduled a service restart)
      // must stop the run - store.install would swap ~/.tvbox/apps/<id> under it
      if (!boxIdle() || installing.size) break;
      console.log("[store] nightly app auto-update:", id);
      const r = await store.install(config, id);
      if (r && r.ok) await provisionFull(id);
    }
  } catch (e) {
    console.warn("[store] nightly app auto-update failed:", String(e.message || e).slice(0, 160));
  } finally {
    appsAutoBusy = false;
  }
}

// On-demand bundle install (e.g. Plex's flatpak) triggered from the launcher.
// Runs the recipe OUT OF PROCESS (`node cli.js install <id>`) so a multi-minute
// flatpak download never blocks the Electron main process / UI; the launcher
// polls /tvbox/api/apps and sees `installing` then `installed` flip. User-space
// only (flatpak --user / curl / git) - never root; apt deps are the `tvbox deps`
// CLI's job. Restricted to a ready app that declares an install recipe.
function startInstall(id, res) {
  const m = apps.manifestById(id);
  if (!m || !(m.install && m.install.source) || m.status !== "ready")
    return jsonRes(res, { ok: false, error: "not installable" });
  if (apps.isInstalled(id)) return jsonRes(res, { ok: true, installed: true });
  if (installing.has(id)) return jsonRes(res, { ok: true, installing: true });
  installing.add(id);
  console.log("[install] on-demand start:", id);
  // Run cli.js as Node via Electron's own binary (ELECTRON_RUN_AS_NODE) so we
  // don't depend on a separate `node` being on PATH in the shell's env.
  const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "install", id], {
    env: { ...process.env, ...WL_ENV, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  child.on("error", (e) => {
    console.warn("[install]", id, "spawn error:", e.message);
    installing.delete(id);
  });
  child.on("exit", (code) => {
    console.log("[install]", id, "exit", code);
    installing.delete(id);
  });
  return jsonRes(res, { ok: true, installing: true });
}

// Install an app's no-root binary deps (requires.download) from the UI - the
// "remote-only, no CLI" path. Runs `cli.js deps <id> --download-only` out of
// process (curl/tar can take seconds; never block the main process) and reuses
// the `installing` flag so the launcher's poll shows progress. apt-only deps
// are NOT touched here (they need root / the image / `tvbox deps`).
function startDeps(id, res) {
  const m = apps.manifestById(id);
  if (!m) return jsonRes(res, { ok: false, error: "unknown app" });
  const deps = apps.appDeps(m);
  if (deps.depsOk) return jsonRes(res, { ok: true, depsOk: true });
  if (!deps.installable)
    return jsonRes(res, { ok: false, error: "needs setup on the box: tvbox deps " + id, missing: deps.missing });
  if (installing.has(id)) return jsonRes(res, { ok: true, installing: true });
  installing.add(id);
  console.log("[deps] on-demand start:", id);
  const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "deps", id, "--download-only"], {
    env: { ...process.env, ...WL_ENV, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  child.on("error", (e) => {
    console.warn("[deps]", id, "spawn error:", e.message);
    installing.delete(id);
  });
  child.on("exit", (code) => {
    console.log("[deps]", id, "exit", code);
    installing.delete(id);
    // A freshly downloaded binary is now on PATH; activate a `service` plugin
    // by hot-load (no restart) - same as the store install path.
    if (code === 0 && m.service) hotLoadPlugin(id);
  });
  return jsonRes(res, { ok: true, installing: true });
}

// ---- plugin route dispatch ----
// Match a request against a plugin's registered route table. A plugin declares a
// prefix (e.g. "/tvbox/api/spotify") and a table keyed "METHOD /subpath"; the
// generic server tries these before its own built-in routes.
function matchPluginRoute(method, pathname) {
  for (const { prefix, table } of pluginRoutes) {
    if (!pathname.startsWith(prefix)) continue;
    const sub = pathname.slice(prefix.length);
    if (sub && sub[0] !== "/") continue; // don't let "/spotify" match "/spotifyX"
    const fn = table[method + " " + sub];
    if (fn) return fn;
  }
  return null;
}

// ---- WiFi (device setting: HOME → Settings shows status + a network picker) ----
// nmcli runs as the shell's (active-session) user; connect falls back to
// passwordless sudo if polkit blocks it. execFile (no shell) - SSID/password are
// literal argv, no injection.
function wifiStatus(cb) {
  execFile("nmcli", ["-t", "-f", "GENERAL.STATE,GENERAL.CONNECTION", "device", "show", "wlan0"], (e, out) => {
    if (e) return cb({ connected: false, ssid: "" });
    let state = "",
      conn = "";
    for (const l of (out || "").split("\n")) {
      if (l.startsWith("GENERAL.STATE:")) state = l.slice(14);
      else if (l.startsWith("GENERAL.CONNECTION:")) conn = l.slice(19).trim();
    }
    cb({ connected: /(^|\D)100(\D|$)/.test(state), ssid: conn && conn !== "--" ? conn : "" });
  });
}
// Ethernet presence + IP (the robust alternative to WiFi on a fixed box). Finds
// the first connected ethernet device (name is eth0/end0-dependent) via nmcli.
function ethernetStatus(cb) {
  execFile("nmcli", ["-t", "-f", "DEVICE,TYPE,STATE", "device"], { timeout: 8000 }, (e, out) => {
    if (e) return cb({ connected: false, ip: "" });
    let dev = "";
    for (const l of (out || "").split("\n")) {
      const p = l.split(":");
      if (p[1] === "ethernet" && p[2] === "connected") {
        dev = p[0];
        break;
      }
    }
    if (!dev) return cb({ connected: false, ip: "" });
    execFile("nmcli", ["-t", "-f", "IP4.ADDRESS", "device", "show", dev], { timeout: 8000 }, (_e2, out2) => {
      const m = /IP4\.ADDRESS\[1\]:([^/\n]+)/.exec(out2 || "");
      cb({ connected: true, ip: m ? m[1].trim() : "", device: dev });
    });
  });
}
// System region for the first-boot wizard + Settings: current timezone + the
// full zone list, and the current X11 keymap + the layout list. The launcher
// groups timezones by region (Europe/Budapest -> Europe > Budapest). ASYNC
// (never block the Electron main thread) and the big STATIC lists are cached
// after the first read, so re-opening the picker doesn't re-spawn 4 processes
// each time (that was blocking the UI). Only current tz/keymap is re-read.
const lines = (s) =>
  String(s || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
let regionListCache = null; // { timezones, keymaps } - static lists, cached after a successful fetch
function systemRegion(cb) {
  const readCurrent = (lists) =>
    execFile("timedatectl", ["show", "-p", "Timezone", "--value"], { timeout: 5000 }, (e, tzOut) => {
      const timezone = e ? "" : String(tzOut).trim();
      execFile("localectl", ["status"], { timeout: 5000 }, (e2, st) => {
        const m = /X11 Layout:\s*(\S+)/.exec(String(st || ""));
        cb({ timezone, keymap: m ? m[1] : "", timezones: lists.timezones, keymaps: lists.keymaps });
      });
    });
  if (regionListCache) return readCurrent(regionListCache);
  execFile("timedatectl", ["list-timezones"], { timeout: 8000 }, (e, tzs) => {
    execFile("localectl", ["list-x11-keymap-layouts"], { timeout: 8000 }, (e2, kms) => {
      const lists = { timezones: lines(tzs), keymaps: lines(kms) };
      // Cache only a SUCCESSFUL, non-empty fetch. A transient failure (the wizard
      // opens before systemd-localed/timedated is up, or the 8s timeout trips
      // under first-boot load) must not poison the cache with empty lists - a
      // truthy empty cache would blank the region picker for the life of the
      // shell. On failure we serve this one call and re-fetch next time.
      if (!e && !e2 && lists.timezones.length && lists.keymaps.length) regionListCache = lists;
      readCurrent(lists);
    });
  });
}
// timedatectl set-timezone works from the box user's active session (polkit
// allows timedate1.set-timezone). localectl set-x11-keymap needs the locale1
// polkit grant provision installs (auth is required by default).
function setTimezone(tz, cb) {
  if (!/^[A-Za-z0-9_+/][A-Za-z0-9_+/-]{0,63}$/.test(tz)) return cb({ ok: false, error: "bad timezone" });
  execFile("timedatectl", ["set-timezone", tz], { timeout: 8000 }, (e) =>
    cb(e ? { ok: false, error: String(e.message || e).slice(0, 120) } : { ok: true }),
  );
}
function setKeymap(layout, cb) {
  if (!/^[a-z0-9][a-z0-9,_-]{0,31}$/.test(layout)) return cb({ ok: false, error: "bad layout" });
  execFile("localectl", ["set-x11-keymap", layout], { timeout: 8000 }, (e) =>
    cb(e ? { ok: false, error: String(e.message || e).slice(0, 120) } : { ok: true }),
  );
}
// hostnamectl set-hostname needs the hostname1 polkit grant provision installs
// (set-hostname / set-static-hostname require admin auth by default). Sets the
// static + transient name; /etc/hosts is left to tvbox-firstboot (root) - a
// stale 127.0.1.1 line only costs a cosmetic sudo warning. Name = one RFC-1123
// label (letters/digits/hyphen, 1-63, no leading/trailing hyphen).
function setHostname(name, cb) {
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(name)) return cb({ ok: false, error: "bad hostname" });
  execFile("hostnamectl", ["set-hostname", name], { timeout: 8000 }, (e) =>
    cb(e ? { ok: false, error: String(e.message || e).slice(0, 120) } : { ok: true }),
  );
}
function wifiList(cb) {
  execFile(
    "nmcli",
    ["-t", "-f", "ACTIVE,SIGNAL,SECURITY,SSID", "device", "wifi", "list", "--rescan", "auto"],
    { timeout: 20000 },
    (e, out) => {
      if (e) return cb([]);
      const seen = new Set(),
        nets = [];
      for (const raw of (out || "").split("\n")) {
        if (!raw) continue;
        // nmcli -t escapes ':' inside values as '\:'. SSID is last (may contain ':').
        const line = raw.replace(/\\:/g, "\0");
        const m = /^(yes|no):(\d*):([^:]*):(.*)$/.exec(line);
        if (!m) continue;
        const ssid = m[4].replace(/\0/g, ":");
        if (!ssid || seen.has(ssid)) continue;
        seen.add(ssid);
        nets.push({ ssid, signal: Number(m[2]) || 0, secured: !!(m[3] && m[3] !== "--"), active: m[1] === "yes" });
      }
      nets.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.signal - a.signal);
      const top = nets.slice(0, 30);
      // Mark networks with a saved profile so the UI can offer "forget". Name
      // match covers profiles our own connect created; the active network always
      // has a profile regardless of its name.
      wifiSavedConnections((names) => {
        const saved = new Set(names);
        for (const n of top) n.known = n.active || saved.has(n.ssid);
        cb(top);
      });
    },
  );
}
function wifiConnect(ssid, password, hidden, cb) {
  if (!ssid) return cb({ ok: false, error: "no ssid" });
  const args = ["device", "wifi", "connect", ssid];
  if (password) args.push("password", password);
  // Hidden networks aren't in the scan list, so nmcli must be told to probe for
  // the SSID instead of matching a scan result.
  if (hidden) args.push("hidden", "yes");
  execFile("nmcli", args, { timeout: 35000 }, (e, _o, err) => {
    if (!e) return cb({ ok: true });
    execFile("sudo", ["-n", "nmcli", ...args], { timeout: 35000 }, (e2, _o2, err2) => {
      if (!e2) return cb({ ok: true });
      cb({
        ok: false,
        error: String(err2 || err || e.message || "")
          .trim()
          .slice(0, 160),
      });
    });
  });
}
// Saved (known) WiFi connection profile names. `nmcli device wifi connect` names
// the profile after the SSID, so name==ssid is the common case; renamed or
// NM-suffixed ("MyNet 1") profiles are handled by the SSID lookup in wifiForget.
function wifiSavedConnections(cb) {
  execFile("nmcli", ["-t", "-f", "NAME,TYPE", "connection", "show"], { timeout: 8000 }, (e, out) => {
    if (e) return cb([]);
    const names = [];
    for (const raw of (out || "").split("\n")) {
      if (!raw) continue;
      // nmcli -t escapes BOTH '\' and ':' inside values ('\\' and '\:');
      // tokenize both so a name containing a backslash still parses (a lone
      // '\:'-only pass would eat the field separator after a trailing '\').
      const line = raw.replace(/\\\\/g, "\u0001").replace(/\\:/g, "\u0000");
      const m = /^(.*):([^:]*)$/.exec(line);
      if (!m) continue;
      if (m[2] !== "802-11-wireless" && m[2] !== "wifi") continue;
      names.push(m[1].replace(/\u0000/g, ":").replace(/\u0001/g, "\\"));
    }
    cb(names);
  });
}
// Forget a saved network: delete every NM profile stored for the SSID - the
// profile named exactly like the SSID (what our own connect creates) plus any
// profile whose 802-11-wireless.ssid matches (renamed/suffixed duplicates).
// Same user-then-passwordless-sudo ladder as wifiConnect.
function nmcliDeleteConnection(name, cb) {
  const args = ["connection", "delete", "id", name];
  execFile("nmcli", args, { timeout: 15000 }, (e) => {
    if (!e) return cb(true);
    execFile("sudo", ["-n", "nmcli", ...args], { timeout: 15000 }, (e2) => cb(!e2));
  });
}
function wifiForget(ssid, cb) {
  if (!ssid) return cb({ ok: false, error: "no ssid" });
  wifiSavedConnections((names) => {
    const direct = names.filter((n) => n === ssid);
    const rest = names.filter((n) => n !== ssid);
    const delAll = (targets) => {
      if (!targets.length) return cb({ ok: false, error: "no saved network: " + ssid.slice(0, 64) });
      let okAny = false,
        i = 0;
      const step = () => {
        if (i >= targets.length) return cb(okAny ? { ok: true } : { ok: false, error: "delete failed" });
        nmcliDeleteConnection(targets[i++], (ok) => {
          okAny = okAny || ok;
          step();
        });
      };
      step();
    };
    // Check the differently-named profiles' stored SSID one by one (sequential:
    // a box has a handful of profiles at most).
    const matchRest = (i, acc) => {
      if (i >= rest.length) return delAll(direct.concat(acc));
      execFile("nmcli", ["-g", "802-11-wireless.ssid", "connection", "show", rest[i]], { timeout: 8000 }, (e, out) => {
        const v = String(out || "")
          .trim()
          .replace(/\\:/g, ":");
        matchRest(i + 1, !e && v === ssid ? acc.concat(rest[i]) : acc);
      });
    };
    matchRest(0, []);
  });
}

// ---- system info (read-only diagnostics for HOME → Settings → About) ----
function cpuTempC() {
  try {
    const n = parseInt(fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8"), 10);
    return isFinite(n) ? Math.round(n / 100) / 10 : null;
  } catch (e) {
    return null;
  } // millidegrees -> °C, 0.1 res
}
function memInfo() {
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (k) => {
      const r = new RegExp("^" + k + ":\\s+(\\d+)", "m").exec(m);
      return r ? Number(r[1]) : null;
    };
    return { totalKb: kb("MemTotal"), availableKb: kb("MemAvailable") }; // MemAvailable = the "free" that matters
  } catch (e) {
    return { totalKb: null, availableKb: null };
  }
}
function deviceModel() {
  try {
    return fs.readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
  } catch (e) {
    return "";
  }
}
// SD-card space for About - installs/OTA fail invisibly on a full disk otherwise.
function diskInfo() {
  try {
    const s = fs.statfsSync(os.homedir());
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch (e) {
    return null;
  }
}

function systemInfo(cb) {
  const info = {
    version: pkg.version || "",
    hostname: os.hostname(),
    model: deviceModel(),
    ip: netguard.lanIp(),
    uptimeSec: Math.round(os.uptime()),
    cpuTempC: cpuTempC(),
    mem: memInfo(),
    disk: diskInfo(),
    wifi: { ssid: "", signal: null }, // empty on Ethernet
  };
  execFile("nmcli", ["-t", "-f", "ACTIVE,SIGNAL,SSID", "device", "wifi"], { timeout: 8000 }, (e, out) => {
    if (!e)
      for (const raw of (out || "").split("\n")) {
        if (!raw.startsWith("yes:")) continue; // the connected network
        const m = /^yes:(\d*):(.*)$/.exec(raw.replace(/\\:/g, " ")); // nmcli -t escapes ':' in values
        if (m) {
          info.wifi.signal = m[1] ? Number(m[1]) : null;
          info.wifi.ssid = m[2].replace(/ /g, ":");
        }
        break;
      }
    cb(info);
  });
}

// Apply a display mode ("WxH@N") via wlr-randr, persisting it only on success so
// a rejected mode never gets re-applied on boot.
function applyDisplayMode(mode, res) {
  display.applyKey({ ...process.env, ...WL_ENV }, mode, (ok, err) => {
    if (ok) config.setDisplay({ mode }); // persist only on success
    jsonRes(res, ok ? { ok: true } : { ok: false, error: err || "apply failed" });
  });
}

// Power menu actions from Home. sleep = display off over CEC (the box keeps
// running; wake by turning the TV on). reboot/poweroff run as the session user:
// logind's polkit policy allows them for an active local session (that's how
// desktop shutdown buttons work), so no root is needed; passwordless sudo is
// kept only as a fallback for exotic setups. On reboot/poweroff the box goes
// down, so the JSON response may never reach the client - that's fine.
// User-set sleep timer ("turn the TV off in N minutes") - unconditional by
// design (the user explicitly asked for it), unlike the screensaver auto-sleep.
let sleepTimerAt = null;
let sleepTimerId = null;
function setSleepTimer(minutes) {
  if (sleepTimerId) clearTimeout(sleepTimerId);
  sleepTimerId = null;
  sleepTimerAt = null;
  const min = Number(minutes);
  if (Number.isFinite(min) && min > 0 && min <= 24 * 60) {
    sleepTimerAt = Date.now() + min * 60 * 1000;
    sleepTimerId = setTimeout(
      () => {
        sleepTimerId = null;
        sleepTimerAt = null;
        console.log("[power] sleep timer fired");
        showLauncher();
        cecPower(false);
      },
      min * 60 * 1000,
    );
  }
  return { ok: true, at: sleepTimerAt };
}

function handlePower(action, res) {
  if (action === "sleep" || action === "sleep_if_idle") {
    // sleep_if_idle = the screensaver's auto-sleep: refuse while anything plays
    // (Spotify Connect streams with the launcher sitting idle on Home, so
    // "screensaver is up" does NOT imply "nothing is playing"). The power
    // menu's manual Sleep stays unconditional.
    if (action === "sleep_if_idle" && !boxIdle()) return jsonRes(res, { ok: true, slept: false });
    showLauncher(); // stop playback / leave any remote app, back to Home
    cecPower(false); // TV off via CEC
    return jsonRes(res, { ok: true, slept: true });
  }
  const sub = action === "reboot" || action === "poweroff" ? action : null;
  if (!sub) return jsonRes(res, { ok: false, error: "bad action" });
  console.log("[power]", sub);
  execFile("systemctl", [sub], { timeout: 8000 }, (e, _o, err) => {
    if (!e) return jsonRes(res, { ok: true });
    execFile("sudo", ["-n", "systemctl", sub], { timeout: 8000 }, (e2, _o2, err2) => {
      jsonRes(
        res,
        e2
          ? {
              ok: false,
              error: String(err2 || err || e.message || "")
                .trim()
                .slice(0, 120),
            }
          : { ok: true },
      );
    });
  });
}

// Origins allowed to issue state-changing requests: only our own pages (the
// launcher and local app bundles are all served by this same server, loaded
// via BASE=localhost). Browsers attach an Origin header to every cross-origin
// POST, so a foreign Origin here is some LAN page - e.g. a plain-http remote
// app (remoteProtoOk allows those) - blind-firing at the control API through
// the TV's own renderer. Requests WITHOUT an Origin (curl, the CEC bridge, the
// tvbox CLI, the shell's own Node code) are local tools, not browsers - they
// stay allowed; the server only listens on 127.0.0.1 anyway.
const OWN_ORIGINS = new Set(["http://127.0.0.1:" + PORT, "http://localhost:" + PORT]);
function foreignOrigin(req) {
  const o = req.headers.origin;
  return !!o && !OWN_ORIGINS.has(String(o).toLowerCase());
}

function serve() {
  const server = http.createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch (e) {
      // malformed percent-escape (e.g. "GET /%") throws URIError; without this
      // guard - and with no uncaughtException handler - one bad URL from any
      // local client would kill the whole shell process.
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad request");
      return;
    }
    // Same-origin gate for everything state-changing: every non-GET (the POST
    // API + plugin POST routes) plus the one mutating GET (tv/standby stops
    // playback). Read-only GETs stay open - they leak nothing a same-LAN
    // attacker can act on and blocking them would break <img>/no-CORS uses.
    if ((req.method !== "GET" || p === "/tvbox/api/tv/standby") && foreignOrigin(req)) {
      console.warn("[main] rejected cross-origin", req.method, p, "from", req.headers.origin);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("cross-origin request rejected");
      return;
    }
    // POST API (config writes) - read the JSON body then dispatch to a plugin
    // route (e.g. Spotify) or the built-in handler.
    if (req.method === "POST" && p.startsWith("/tvbox/api/")) {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on("end", () => {
        let d = {};
        try {
          d = JSON.parse(body || "{}");
        } catch (e) {}
        const route = matchPluginRoute("POST", p);
        if (route) {
          try {
            route(req, res, { body: d });
          } catch (e) {
            res.writeHead(500);
            res.end();
          }
          return;
        }
        handlePost(p, d, res);
      });
      return;
    }
    // plugin-registered GET routes (e.g. all of Spotify's) take precedence
    const gRoute = matchPluginRoute("GET", p);
    if (gRoute) {
      try {
        gRoute(req, res, {});
      } catch (e) {
        try {
          res.writeHead(500);
          res.end();
        } catch (e2) {}
      }
      return;
    }
    // secret-free config view for the launcher
    if (p === "/tvbox/api/config") {
      jsonRes(res, config.publicConfig());
      return;
    }
    if (p === "/tvbox/api/pairing/status") {
      jsonRes(res, { phoneConnected: pairing.phoneConnected() });
      return;
    }
    // IR blaster backend health for the settings card (connected/lastError)
    if (p === "/tvbox/api/ir/status") {
      jsonRes(res, ir.status());
      return;
    }
    if (p === "/tvbox/api/wifi/status") {
      wifiStatus((s) => ethernetStatus((eth) => jsonRes(res, { ...s, ethernet: eth })));
      return;
    }
    if (p === "/tvbox/api/system/region") {
      systemRegion((r) => jsonRes(res, r));
      return;
    }
    if (p === "/tvbox/api/wifi/list") {
      wifiList((n) => jsonRes(res, { networks: n }));
      return;
    }
    if (p === "/tvbox/api/system/info") {
      systemInfo((i) => jsonRes(res, i));
      return;
    }
    if (p === "/tvbox/api/update/status") {
      jsonRes(res, updater.status());
      return;
    }
    if (p === "/tvbox/api/backup/status") {
      jsonRes(res, { restoredAt });
      return;
    }
    if (p === "/tvbox/api/backup/pending-localstorage") {
      jsonRes(res, backup.pendingLocalStorage());
      return;
    }
    if (p === "/tvbox/api/display/modes") {
      display.list({ ...process.env, ...WL_ENV }, (info) => {
        const d = config.rawDisplay() || {};
        jsonRes(res, {
          output: info ? info.output : "",
          modes: info ? info.modes : [],
          saved: d.mode || null,
          matchFramerate: !!d.matchFramerate,
        });
      });
      return;
    }
    if (p === "/tvbox/api/audio/sinks") {
      audio.listSinks({ ...process.env, ...WL_ENV }, (sinks) =>
        jsonRes(res, { sinks, override: (config.rawAudio() || {}).sink || null }),
      );
      return;
    }
    if (p === "/tvbox/api/bt/status") {
      bluetooth.status({ ...process.env, ...WL_ENV }, (s) => jsonRes(res, s));
      return;
    }
    if (p === "/tvbox/api/bt/devices") {
      bluetooth.list({ ...process.env, ...WL_ENV }, (d) => jsonRes(res, { devices: d }));
      return;
    }
    if (p === "/tvbox/api/remote/devices") {
      // Currently-managed remotes (published by the bridge). Merge in the saved
      // keymap per device so the UI shows what's already bound.
      const list = (readBridgeJson("remote-devices.json", { devices: [] }).devices || []).slice(0, 20);
      const saved = (config.rawRemote() || {}).devices || {};
      jsonRes(res, { devices: list.map((d) => ({ ...d, keymap: (saved[d.id] && saved[d.id].keymap) || {} })) });
      return;
    }
    if (p === "/tvbox/api/remote/learned") {
      jsonRes(res, { learned: readBridgeJson("remote-learned.json", null) });
      return;
    }
    if (p === "/tvbox/api/ambient/weather") {
      ambient.weather((config.rawAmbient() || {}).city, (w) => jsonRes(res, w || {}));
      return;
    }
    if (p === "/tvbox/api/ambient/photos") {
      jsonRes(res, { photos: ambient.photos() });
      return;
    }
    if (p === "/tvbox/api/ambient/photo") {
      const name = (req.url || "").split("?")[1] ? new URLSearchParams(req.url.split("?")[1]).get("name") : "";
      return serveStatic(res, ambient.PHOTO_DIR, name || "", null); // serveStatic guards the root boundary (no traversal)
    }
    // TV powered off (from the CEC bridge) -> stop playback
    if (p === "/tvbox/api/tv/standby") {
      onTvStandby();
      jsonRes(res, { ok: true });
      return;
    }
    // Fire TV remote IR programming (Settings → Peripherals; shell/firetvir.js)
    if (p === "/tvbox/api/firetvir/status") {
      firetvir.status((s) => jsonRes(res, s));
      return;
    }
    if (p === "/tvbox/api/firetvir/brands") {
      firetvir.fetchBrands((err, brands) =>
        jsonRes(res, err ? { ok: false, error: String(err.message || err).slice(0, 200) } : { ok: true, brands }),
      );
      return;
    }
    if (p === "/tvbox/api/firetvir/codeset") {
      const q = (req.url || "").split("?")[1];
      const csPath = q ? new URLSearchParams(q).get("path") || "" : "";
      firetvir.fetchCodeset(csPath, (err, cs) => {
        if (err) return jsonRes(res, { ok: false, error: String(err.message || err).slice(0, 200) });
        firetvir.checkProtocols(cs.protocols, (perr, supported) =>
          jsonRes(res, { ok: true, ...cs, supported: perr ? null : supported }),
        );
      });
      return;
    }
    // App-store registry (Settings → Store). ?refresh=1 bypasses the 5-min cache.
    if (p === "/tvbox/api/store/list") {
      const refresh = (req.url || "").includes("refresh=1");
      store
        .listForUi(config)(refresh)
        // Merge in live install state so the store can show progress + poll it:
        // each entry gains `installing` and a coarse `progress.phase`.
        .then((d) => {
          const apps2 = (d.apps || []).map((e) => ({
            ...e,
            installing: installing.has(e.id),
            progress: installProgress.get(e.id) || null,
          }));
          jsonRes(res, { ...d, apps: apps2, installing: [...installing] });
        })
        .catch((e) => jsonRes(res, { apps: [], error: String(e.message || e).slice(0, 120) }));
      return;
    }
    // launcher's app list. Manifests are re-read on every call (a handful of
    // small JSON files) so a dropped-in ~/.tvbox/apps manifest appears as a
    // tile live - no shell restart. Plugins/services still load at boot only.
    if (p === "/tvbox/api/power/sleep-timer") {
      jsonRes(res, { at: sleepTimerAt });
      return;
    }
    if (p === "/tvbox/api/widgets") {
      jsonRes(res, { widgets: widgetList() });
      return;
    }
    if (p === "/tvbox/api/apps") {
      apps.loadManifests();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(appTiles()));
      return;
    }
    // (Live TV data routes /tvbox/api/livetv/* are registered by the livetv plugin.)
    // HOME launcher (our React app) under /tvbox/, relative assets
    if (p === "/tvbox" || p === "/tvbox/") p = "/tvbox/index.html";
    if (p.startsWith("/tvbox/")) {
      serveStatic(res, LAUNCHER, p.slice("/tvbox/".length), null);
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
          serveStatic(res, webRoot, sub, entry);
          return;
        }
      }
    }
    // everything else: the root-mounted web-client app's SPA (index fallback)
    const a = rootWebApp();
    if (!a) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no root app");
      return;
    }
    const root = apps.appDataDir(a.id);
    const entry = (a.runtime && a.runtime.entry) || "index.html";
    if (p === "/") p = "/" + entry;
    serveStatic(res, root, p, path.join(root, entry));
  });
  // A restart races the dying instance for the port (the labwc respawn loop
  // restarts us within ~1s; the old process may not have released :PORT yet). Without a handler
  // EADDRINUSE is an uncaught exception and the shell limps on WITHOUT its
  // server (black launcher, dead API) - so retry until the port frees up.
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.warn("[main] :" + PORT + " busy (old instance dying?) - retrying");
      setTimeout(() => server.listen(PORT, "127.0.0.1"), 1000);
    } else console.warn("[main] server error:", e.message);
  });
  server.listen(PORT, "127.0.0.1", () => console.log("[main] server on :" + PORT));
}

// ---- mpv control ----
// Player events go to every live window: the driving app (own window now) needs
// them for its UI, the launcher for now-playing state. Listeners that don't
// care simply have no handler registered.
function emit(ev) {
  if (win && !win.isDestroyed()) win.webContents.send("player-event", ev);
  for (const [, w] of appwins.all()) {
    try {
      w.webContents.send("player-event", ev);
    } catch (e) {}
  }
}
// One request/response round-trip on the mpv IPC socket (mpvCmd is fire-and-
// forget). Resolves null on any failure - callers treat that as "no tracks".
function mpvQuery(command) {
  return new Promise((resolve) => {
    const s = net.connect(IPC);
    const to = setTimeout(() => {
      try {
        s.destroy();
      } catch (e) {}
      resolve(null);
    }, 2500);
    s.on("error", () => {
      clearTimeout(to);
      resolve(null);
    });
    let buf = "";
    s.on("connect", () => {
      try {
        s.write(JSON.stringify({ command, request_id: 77 }) + "\n");
      } catch (e) {}
    });
    s.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (m.request_id === 77) {
          clearTimeout(to);
          try {
            s.end();
          } catch (e) {}
          return resolve(m.error === "success" ? m.data : null);
        }
      }
    });
  });
}

function mpvCmd(obj) {
  const s = net.connect(IPC);
  s.on("error", () => {});
  s.on("connect", () => {
    try {
      s.write(JSON.stringify(obj) + "\n");
    } catch (e) {}
    s.end();
  });
}
function stopMpv() {
  // (mpvOwnerId is NOT cleared here: launchMpv calls this on relaunch right
  // after "play" set the owner. Every play re-assigns it, and without a running
  // mpv no first-frame reveal can consume a stale value.)
  if (mpv) {
    const pid = mpv.pid;
    mpv.removeAllListeners("exit"); // our own kill must NOT signal "finished" to the app
    try {
      process.kill(-pid, "SIGTERM");
    } catch (e) {
      try {
        mpv.kill("SIGTERM");
      } catch (e2) {}
    }
    console.log("[player] stopMpv pid", pid);
    mpv = null;
  }
  try {
    fs.unlinkSync(IPC);
  } catch (e) {}
}
function launchMpv(url, startPos, pip, rect) {
  stopMpv();
  mpvPip = !!pip;
  // mpv is a shared, dep-gated player service - spawned lazily only when a
  // player-capable app actually plays, and only if the binary is present. A box
  // that never opted into an mpv app (fresh install) has no mpv; degrade with a
  // clear event instead of an ENOENT spawn. (Tiles are already greyed via the
  // manifest's requires.bin, so this is the belt-and-suspenders path.)
  if (!apps.onPath("mpv")) {
    console.warn("[player] mpv not installed - cannot play (run: tvbox deps <app>)");
    emit({ type: "error" });
    emit({ type: "finished" });
    return;
  }
  emit({ type: "buffering", on: true });
  const args = [
    "--no-config",
    "--no-osc",
    "--no-input-default-bindings",
    "--vo=gpu",
    "--gpu-api=opengl",
    "--hwdec=auto-safe",
    "--input-ipc-server=" + IPC,
    "--start=" + startPos,
    "--log-file=" + path.join(os.homedir(), ".tvbox", "mpv.log"),
    "--msg-level=all=error",
  ];
  // PiP (Live TV "browse while watching"): a small always-on-top window. Wayland
  // clients can't self-position, so run mpv under XWayland (DISPLAY, no
  // WAYLAND_DISPLAY) where --geometry works. `rect` (device px, measured by the
  // launcher from the on-screen placeholder) makes it match exactly at any
  // resolution/layout; fall back to a top-right percentage. Fullscreen otherwise.
  if (pip) {
    const geo =
      rect && rect.w > 0
        ? Math.round(rect.w) + "x" + Math.round(rect.h) + "+" + Math.round(rect.x) + "+" + Math.round(rect.y)
        : "26%+99%+3%";
    // NOT ontop: mpv sits BEHIND the (transparent) Electron window and shows
    // through a box-shadow "hole" the browse UI punches, so the launcher keeps
    // keyboard focus (D-pad works) while the video is visible in the hole.
    args.push("--no-border", "--ontop=no", "--geometry=" + geo);
  } else args.push("--window-maximized=yes", "--no-border", "--ontop=no");
  if (audioSink) args.push("--audio-device=pipewire/" + audioSink);
  // "match content framerate": resample so e.g. 50fps IPTV plays smoothly on a
  // 60Hz output without a display mode switch (user opts in; off by default).
  if (config.rawDisplay() && config.rawDisplay().matchFramerate) args.push("--video-sync=display-resample");
  // Preferred audio/subtitle language (Settings > Picture & sound). mpv falls
  // back to the stream default when the language isn't present; subtitles stay
  // OFF unless a preference is set (--slang alone doesn't enable them, so add
  // sid=auto to actually select a matching track).
  const pl = config.rawPlayer() || {};
  if (/^[a-z]{2,3}$/.test(pl.audioLang || "")) args.push("--alang=" + pl.audioLang);
  if (/^[a-z]{2,3}$/.test(pl.subLang || "")) args.push("--slang=" + pl.subLang, "--sid=auto");
  // "--" ends option parsing: a URL starting with "-" (or a crafted playlist
  // entry) must always be argv's file position, never an mpv option.
  args.push("--", url);
  const env = { ...process.env, ...WL_ENV };
  if (pip) {
    env.DISPLAY = env.DISPLAY || ":0";
    delete env.WAYLAND_DISPLAY;
  }
  mpv = spawn("mpv", args, { env, detached: true, stdio: "ignore" });
  console.log("[player] mpv launched pid", mpv.pid, pip ? "(pip)" : "");
  // One-touch wake: video starting while the TV sleeps should light it up
  // (voice/HA "play X" with the TV off). "on 0" is a no-op on a TV that's
  // already on. The one exception: right after the USER put the TV on standby -
  // the stop we emit as "finished" can make an app auto-play the next item
  // (Plex on-deck), which must not switch the TV back on.
  if (Date.now() - lastTvStandbyAt > 30 * 1000) cecPower(true);
  mpv.on("exit", (code, sig) => {
    console.log("[player] mpv exited code", code, "sig", sig);
    emit({ type: "finished" });
    mpv = null;
    playingUrl = null;
    setVideoMode(false);
  });
  // mpv grabs keyboard focus when its window maps (and can do so late), which
  // would break D-pad nav - so keep pulling the launcher back to the front +
  // focus for a few seconds. This works for both modes: fullscreen mpv is behind
  // the transparent overlay, and PiP mpv is behind the transparent window showing
  // through the browse UI's hole, so raising the launcher never hides the video.
  [500, 1200, 2000, 3000, 4000].forEach((ms) => setTimeout(raiseWindow, ms));
  setTimeout(observeMpv, 900);
}
function observeMpv() {
  const s = net.connect(IPC);
  let firstPos = false;
  s.on("error", (e) => console.log("[player] observer error", e.code));
  s.on("connect", () => {
    console.log("[player] observer connected");
    ["time-pos", "duration", "pause", "eof-reached", "core-idle"].forEach((p, i) =>
      s.write(JSON.stringify({ command: ["observe_property", i + 1, p] }) + "\n"),
    );
  });
  let buf = "";
  s.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (m.event !== "property-change") continue;
      if (m.name === "time-pos" && m.data != null) {
        // reveal the video (make the Electron window transparent) only in
        // fullscreen; in PiP the browse UI stays opaque and mpv floats on top.
        if (!firstPos) {
          firstPos = true;
          if (!mpvPip) {
            console.log("[player] first frame -> reveal video");
            setVideoMode(true);
          }
          // mpv maps its window and grabs keyboard focus exactly when playback
          // actually starts. For a slow-to-buffer source (a Plex movie can take
          // well over 5s to start) that happens AFTER the fixed post-launch raise
          // retries ended, leaving mpv focused so the remote stops reaching the
          // app UI. Re-raise on the real playback-start event (and a short burst
          // after, since the focus grab can trail the first frame) - this covers
          // any buffer delay, unlike the fixed launch-time window.
          [0, 250, 700, 1500].forEach((ms) => setTimeout(raiseWindow, ms));
        }
        emit({ type: "playing" });
        emit({ type: "position", ms: Math.round(m.data * 1000) });
      } else if (m.name === "duration" && m.data != null) emit({ type: "duration", ms: Math.round(m.data * 1000) });
      else if (m.name === "core-idle") emit({ type: "buffering", on: !!m.data });
      else if (m.name === "eof-reached" && m.data) {
        console.log("[player] eof-reached");
        emit({ type: "finished" });
      }
    }
  });
}

// ---- IPC ----
// TV turned off (signalled by the CEC bridge): stop active playback so a stream
// doesn't keep running after the screen is off. Only the playback is stopped,
// nothing is killed; the app's UI updates via the "finished" event.
let lastTvStandbyAt = 0; // launchMpv suppresses its CEC wake right after this
function onTvStandby() {
  lastTvStandbyAt = Date.now();
  if (!mpv) return;
  console.log("[tv] standby -> stop playback");
  playingUrl = null;
  stopMpv();
  setVideoMode(false);
  emit({ type: "finished" });
}

// Bring the FOREGROUND shell window (the active app's own window, or the
// launcher) to the front and hand it focus (also via wlrctl, so the compositor
// raises us above a just-exited mpv). Shared by playback start and by
// showLauncher. All our windows share the Wayland app_id, and only one is
// visible at a time, so the wlrctl focus lands on the right toplevel.
function raiseWindow() {
  const w = foregroundWindow();
  if (w && w !== win && !w.isDestroyed()) {
    try {
      if (w.isMinimized()) w.restore();
      w.setAlwaysOnTop(true, "screen-saver");
      w.show();
      w.focus();
      w.moveTop();
    } catch (e) {}
    execFile("wlrctl", ["toplevel", "focus", "app_id:" + APP_ID], { env: { ...process.env, ...WL_ENV } }, () => {});
    return;
  }
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    win.setAlwaysOnTop(true, "screen-saver");
    win.show();
    win.focus();
    win.moveTop();
    execFile("wlrctl", ["toplevel", "focus", "app_id:" + APP_ID], { env: { ...process.env, ...WL_ENV } }, () => {});
  } catch (e) {}
}
// Stop any other playback and bring the launcher forward, optionally at a hash
// (e.g. "#spotify" so it opens a built-in view). Exposed to plugins via the host
// API - this is how a cast jumps to the Spotify now-playing screen without core
// knowing anything Spotify-specific.
function showLauncher(hash) {
  if (!win || win.isDestroyed()) return;
  const leaving = currentAppId;
  currentAppId = null;
  playingUrl = null;
  stopMpv();
  setVideoMode(false);
  // The launcher page stays loaded permanently now (apps run in their own
  // windows), so returning home is a show(), not a reload. A hash still forces
  // a load (plugins use it to open a view, e.g. host.showLauncher("#spotify")),
  // and a stray non-launcher URL in this window gets reset defensively.
  if (hash || !String(win.webContents.getURL() || "").startsWith(BASE + "/tvbox/")) {
    win.loadURL(BASE + "/tvbox/" + (hash || ""));
  } else {
    try {
      win.webContents.send("tvbox-nav", { dest: "home" }); // reset a lingering Settings/Catalog view
    } catch (e) {}
  }
  raiseWindow();
  if (leaving) backgroundApp(leaving); // after the launcher is up - no desktop flash
  for (const [id, w] of appwins.all()) if (id !== leaving && w.isVisible()) backgroundApp(id);
}

// ---- per-app windows (background apps) ----
// Registry + hidden-set policy (mute/pause, LRU cap, RAM guard) live in
// appwindows.js; here is only the foreground orchestration. The "exactly ONE
// visible always-on-top toplevel" invariant still holds - hidden windows are
// unmapped in Wayland, so CEC key routing / stacking stay sane.
const backgroundApp = (id) => appwins.background(id);
const destroyAppWindow = (id) => appwins.destroy(id);

// Bring a running app's window back to the foreground (instant resume). The
// page kept its state; only audio is re-enabled - a paused video stays paused
// for the app/user to resume.
function foregroundApp(id) {
  const w = appWindow(id);
  if (!w) return false;
  currentAppId = id;
  appwins.touch(id);
  try {
    w.webContents.setAudioMuted(false);
  } catch (e) {}
  w.setAlwaysOnTop(true, "screen-saver");
  w.show();
  w.focus();
  w.moveTop();
  for (const [oid, ow] of appwins.all()) if (oid !== id && ow.isVisible()) backgroundApp(oid);
  if (win && !win.isDestroyed()) win.hide(); // exactly one visible toplevel
  return true;
}

// ---- isolated window for remote web apps (YouTube etc.) ----
// A remote site is UNTRUSTED relative to the launcher, so it must NOT run in the
// main window (which has a Node-capable preload + contextIsolation:false for the
// local Plex bridge). It gets its own window: contextIsolation + sandbox ON, NO
// preload (so the site can't reach window.tvbox / Node), navigation locked to the
// manifest's declared `runtime.origins` (https only), and popups denied. Its own
// persistent partition keeps the site's login across sessions.
// A remote app's URL is either literal in the manifest (runtime.url, e.g.
// youtube.com/tv) or config-driven (runtime.urlConfig names a config section
// holding { baseUrl }, e.g. a user's Home Assistant). Returns "" when a
// config-driven URL isn't set yet, so the caller can treat the app as
// unconfigured instead of loading a blank window.
function resolveRemoteUrl(m) {
  const rt = m.runtime || {};
  if (rt.urlConfig) return (config.appConfig(rt.urlConfig) || {}).baseUrl || "";
  return rt.url || "";
}
// Loopback / RFC1918 / link-local / mDNS - a self-hosted LAN service (Home
// Assistant, Jellyfin, ...) can't be a public untrusted site, so plain http to
// it is acceptable; public hosts must still be https.
function remoteProtoOk(x) {
  return x.protocol === "https:" || (x.protocol === "http:" && netguard.isLanHost(x.hostname));
}
function allowedRemoteHosts(rt, url) {
  const declared = (rt.origins || []).map((s) => String(s).toLowerCase());
  if (declared.length) return declared;
  try {
    return [new URL(url).hostname.toLowerCase()];
  } catch (e) {
    return [];
  }
}
function openRemoteApp(m, url) {
  const rt = m.runtime || {};
  let start;
  try {
    start = new URL(url);
  } catch (e) {
    start = null;
  }
  if (!start || !remoteProtoOk(start)) {
    console.warn("[nav] remote url not allowed:", url);
    return;
  }
  const hosts = allowedRemoteHosts(rt, url);
  const allowed = (u) => {
    try {
      const x = new URL(u);
      const n = x.hostname.toLowerCase();
      return remoteProtoOk(x) && hosts.some((h) => n === h || n.endsWith("." + h));
    } catch (e) {
      return false;
    }
  };
  stopMpv();
  setVideoMode(false); // no mpv behind a remote app; drop any prior session
  currentAppId = m.id; // identity is per-window (windowAppId); this global only tracks foreground
  // A capability app (declares caps beyond "nav") gets the sandbox-safe
  // contextBridge preload so it can reach its granted brokers (fetch/storage).
  // A plain remote site (e.g. YouTube declares only nav) gets NO preload,
  // exactly as before, so nothing about the existing untrusted path changes.
  const isCapApp = (rt.capabilities || []).some((c) => c && c !== "nav");
  const w = new BrowserWindow({
    fullscreen: true,
    frame: false,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: "persist:remote-" + m.id,
      ...(isCapApp ? { preload: path.join(__dirname, "preload-app.js") } : {}),
    },
  });
  appwins.register(m.id, w); // capability brokers identify THIS window's app by sender (tvboxAppId)
  const wc = w.webContents;
  wc.on("console-message", (ev) => {
    console.log(
      "[remote:" + (CONSOLE_TAG[ev.level] || "?") + "]",
      ev.message,
      ev.sourceId ? "(" + ev.sourceId + ":" + ev.lineNumber + ")" : "",
    );
  });
  const guard = (e, u) => {
    if (!allowed(u)) {
      console.warn("[remote] blocked navigation:", u);
      e.preventDefault();
    }
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.setWindowOpenHandler(() => ({ action: "deny" })); // no popups / new windows in the kiosk
  // Auto-hide the OS cursor when idle: a remote site (e.g. YouTube leanback) is
  // D-pad driven, so a stray idle pointer shouldn't linger - show it only while a
  // real mouse moves. Injected into the page (no preload here).
  const IDLEHIDE_JS =
    "(function(){if(window.__tvh)return;window.__tvh=1;" +
    "var s=document.createElement('style');s.textContent='html.tvhide,html.tvhide *{cursor:none!important}';document.documentElement.appendChild(s);" +
    "var t;function show(){document.documentElement.classList.remove('tvhide');clearTimeout(t);t=setTimeout(function(){document.documentElement.classList.add('tvhide')},2500)}" +
    "document.documentElement.classList.add('tvhide');window.addEventListener('mousemove',show,true);})();";
  wc.on("dom-ready", () => {
    wc.executeJavaScript(IDLEHIDE_JS).catch(() => {});
  });
  // Remote Home key (CEC double-tap Back -> BrowserHome) returns to the launcher.
  // BrowserBack/GoBack (a BT remote's Back button) -> re-injected as Backspace,
  // same translation as the main window: a remote site (YouTube leanback) only
  // handles the key the CEC remote would send, not the browser navigation keys.
  wc.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "BrowserHome") {
      e.preventDefault();
      showLauncher();
      return;
    }
    if (input.key === "BrowserBack" || input.key === "GoBack") {
      e.preventDefault();
      if (input.type !== "keyDown" && input.type !== "keyUp") return;
      wc.sendInputEvent({ type: input.type === "keyDown" ? "keyDown" : "keyUp", keyCode: "Backspace" });
    }
  });
  // If this window goes away for ANY reason while it's still the active app
  // (the site called window.close(), a top-level Back exited it, a crash), the
  // launcher is currently hidden, so recover it instead of dropping to the bare
  // desktop. An intentional return (showLauncher) sets currentAppId=null first,
  // so this is a no-op there; likewise when switching straight to another app.
  const thisAppId = m.id;
  w.on("closed", () => {
    if (appwins.get(thisAppId) === w) appwins.destroy(thisAppId);
    if (currentAppId === thisAppId) showLauncher();
  });
  w.setAlwaysOnTop(true, "screen-saver");
  w.loadURL(url, rt.userAgent ? { userAgent: rt.userAgent } : undefined);
  w.focus();
  w.moveTop();
  // Hide the (transparent, always-on-top) launcher window and any other visible
  // app so there's exactly ONE visible toplevel - otherwise two same-level
  // always-on-top windows have compositor-dependent stacking and CEC keys could
  // route to the wrong one. showLauncher() re-shows the launcher on return.
  for (const [oid, ow] of appwins.all()) if (oid !== m.id && ow.isVisible()) backgroundApp(oid);
  if (win && !win.isDestroyed()) win.hide();
}

// ---- own window for LOCAL webclient apps (Plex, Live TV, Spotify UI, ...) ----
// Same trust level as the old model (curated local apps ran in the privileged
// main window; review is the trust boundary): Node-capable preload,
// contextIsolation off (the Plex QWebChannel bridge needs it). Transparent +
// always-on-top like the main window, because mpv plays BEHIND it and the
// tvbox-video class reveals it (ensureStyle/setVideoMode target this window).
function openLocalApp(m) {
  const rt = m.runtime || {};
  currentAppId = m.id;
  const w = new BrowserWindow({
    fullscreen: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  appwins.register(m.id, w);
  w.setAlwaysOnTop(true, "screen-saver");
  w.webContents.on("console-message", (ev) => {
    console.log(
      "[app:" + m.id + ":" + (CONSOLE_TAG[ev.level] || "?") + "]",
      ev.message,
      ev.sourceId ? "(" + ev.sourceId + ":" + ev.lineNumber + ")" : "",
    );
  });
  // Same BT-remote Back translation the main window did while an app owned it
  // (BrowserBack/GoBack -> trusted Backspace; the app UIs only know the CEC form).
  w.webContents.on("before-input-event", (e, input) => {
    if (input.key !== "BrowserBack" && input.key !== "GoBack") return;
    e.preventDefault();
    if (input.type !== "keyDown" && input.type !== "keyUp") return;
    w.webContents.sendInputEvent({ type: input.type === "keyDown" ? "keyDown" : "keyUp", keyCode: "Backspace" });
  });
  // Black backdrop + video-reveal CSS, re-armed on every navigation like the
  // main window's did-finish-load handler.
  w.webContents.on("did-finish-load", () => {
    w.tvboxStyleInjected = false;
    ensureStyle(w);
    setVideoMode(false, w);
  });
  const thisAppId = m.id;
  w.on("closed", () => {
    if (appwins.get(thisAppId) === w) appwins.destroy(thisAppId);
    if (currentAppId === thisAppId) showLauncher();
  });
  const atRoot = rt.mount === "root";
  w.loadURL(BASE + (atRoot ? "/" : "/" + m.id + "/"));
  w.focus();
  w.moveTop();
  for (const [oid, ow] of appwins.all()) if (oid !== m.id && ow.isVisible()) backgroundApp(oid);
  if (win && !win.isDestroyed()) win.hide();
}

// A notification arrived over MQTT (tvbox/<id>/notify). Forward it to the
// launcher renderer to draw an overlay; if it asks to be raised (e.g. a doorbell
// camera), bring the launcher window forward so it's visible over a remote app.
function handleTvNotify(payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("tv-notify", payload || {});
  } catch (e) {}
  if (payload && payload.raise) raiseWindow();
}

// TV power over CEC. The CEC bridge (tvbox-cec user service) owns the adapter
// and its cec-client stdin, so we can't open a second cec-client; instead we
// drop a whitelisted command ("on 0" / "standby 0") into a FIFO the bridge
// forwards to cec-client. O_NONBLOCK so we never hang if the bridge isn't running.
const CEC_CMD_FIFO = "/tmp/tvbox-cec-cmd";
function cecPower(on) {
  try {
    const fd = fs.openSync(CEC_CMD_FIFO, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, (on ? "on 0" : "standby 0") + "\n");
    fs.closeSync(fd);
    console.log("[cec] power", on ? "on" : "off");
  } catch (e) {
    console.warn("[cec] power failed (bridge running?):", e.message);
  }
}
function forwardCommand(cmd) {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send("tv-command", cmd);
    } catch (e) {}
  }
  // The active app runs in its own window now - it gets the transport too
  // (remote/sandboxed windows deliberately have no tv-command listener).
  const fg = currentAppId && appWindow(currentAppId);
  if (fg) {
    try {
      fg.webContents.send("tv-command", cmd);
    } catch (e) {}
  }
}

// Remote input bridge (tvbox-remote user service) control FIFO: "reload" (re-read
// the remap config) or drive learn mode ("learn <id>" / "learn-off"). O_NONBLOCK
// so we never hang if the bridge isn't running.
const REMOTE_CMD_FIFO = "/tmp/tvbox-remote-cmd";
function remoteBridgeCmd(cmd) {
  try {
    const fd = fs.openSync(REMOTE_CMD_FIFO, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, cmd + "\n");
    fs.closeSync(fd);
  } catch (e) {
    console.warn("[remote] cmd failed (bridge running?):", e.message);
  }
}
// The bridge publishes its state to small JSON files under ~/.tvbox: the list of
// currently-managed remotes, and the last button captured in learn mode.
function readBridgeJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".tvbox", name), "utf8"));
  } catch (e) {
    return fallback;
  }
}

// (Re)start the MQTT bridge from the saved config. mqtt.js stop() publishes a
// best-effort retained "offline" and force-ends the module-level client, so
// calling it before init is safe (and a no-op when not started). rawMqtt() is
// null unless host AND username are set - a cleared config turns the bridge off.
function applyMqttConfig() {
  mqttBridge.stop();
  mqttCtl = null;
  const mcfg = config.rawMqtt();
  if (mcfg) mqttCtl = mqttBridge.init(mcfg, { onNotify: handleTvNotify, onCommand: handleTvCommand });
  // re-seed retained now-playing on the (possibly new) broker; the mqtt client
  // queues QoS-0 publishes made before "connect", so this is safe immediately
  if (mqttCtl && nowPlaying) mqttCtl.publish("nowplaying", nowPlaying, { retain: true });
}

// A control command arrived over MQTT (tvbox/<id>/cmd) - the assistant's
// tv_control tool (voice) or a HA automation. Shell-native actions here; media
// transport is also forwarded to the launcher so the active app (e.g. Spotify)
// can drive its own player.
function handleTvCommand(cmd) {
  const action = String((cmd && cmd.action) || "").toLowerCase();
  console.log("[mqtt] command", action, (cmd && cmd.app) || "");
  switch (action) {
    case "launch":
    case "open":
      if (cmd && cmd.app) navTo(String(cmd.app));
      break;
    case "home":
      showLauncher();
      break;
    case "pause":
      mpvCmd({ command: ["set_property", "pause", true] });
      forwardCommand(cmd);
      break;
    case "play":
    case "resume":
      mpvCmd({ command: ["set_property", "pause", false] });
      forwardCommand(cmd);
      break;
    case "stop":
      playingUrl = null;
      stopMpv();
      setVideoMode(false);
      emit({ type: "finished" });
      forwardCommand(cmd);
      break;
    case "next":
    case "previous":
      forwardCommand(cmd);
      break; // no mpv analogue; the launcher routes to Spotify
    case "tv_on":
      cecPower(true);
      break;
    case "tv_off":
    case "standby":
      cecPower(false);
      break;
    case "volume_up":
    case "volume_down":
    case "mute":
      // TV volume over the IR blaster (ir.js) - CEC volume doesn't reach every
      // TV. steps repeats the send ("volume up by 3"); ir.js clamps it.
      ir.send(action, cmd && cmd.steps).catch((e) => console.warn("[ir]", action, "failed:", (e && e.message) || e));
      break;
    default:
      console.warn("[mqtt] unknown command:", action);
  }
}

ipcMain.on("plog", (_e, p, a) => console.log("[plog]", p, a)); // debug: raw player.* calls from an app

// Which window a webContents belongs to: null = the launcher window, an app id
// = that app's own window, undefined = unknown/stale sender (no identity, no
// caps). Every identity/capability decision keys off THIS, never the global
// foreground id - a hidden app keeps ITS OWN identity, so a background call is
// scoped to its own caps/origins/storage (no confused deputy).
function windowAppId(sender) {
  if (win && !win.isDestroyed() && sender === win.webContents) return null;
  for (const [, w] of appwins.all()) if (sender === w.webContents) return w.tvboxAppId;
  return undefined;
}

// Synchronous: the preload asks which app this is, which capabilities it was
// granted, and which bridge adapter its manifest declared - so it loads only
// that surface (the security/extensibility boundary). Answered PER SENDER
// WINDOW - multiple app windows exist now (background apps).
ipcMain.on("tvbox:app", (e) => {
  const id = windowAppId(e.sender);
  if (id === undefined) {
    e.returnValue = { id: null, capabilities: [], bridge: null }; // unknown sender: nothing
    return;
  }
  const m = id && apps.manifestById(id);
  e.returnValue = {
    id,
    capabilities: capsFor(id),
    bridge: (m && m.runtime && m.runtime.bridge) || null,
  };
});

// Navigate between the HOME launcher and an app. The launcher calls
// window.tvbox.launch(id); the Home button calls window.tvbox.home() (local apps)
// or is caught main-side (remote apps) -> back to the launcher, stopping video.
// Every app runs in its own window: a RUNNING app is simply re-shown (instant
// resume, background apps); a fresh one gets its window created.
function navTo(dest) {
  console.log("[nav]", dest);
  if (dest === "home") {
    showLauncher();
    return;
  }
  const m = apps.manifestById(dest);
  if (!m || m.status !== "ready") return;
  // Switching apps silences the one being replaced: its UI is going to the
  // background, and a plugin foregrounding its app on a cast (Spotify Connect)
  // must stop e.g. the IPTV stream it takes over from. Called only on paths
  // that WILL navigate - an unconfigured remote app must not cost the current
  // stream (review F3).
  const stopPrevPlayback = () => {
    if (mpv && currentAppId !== m.id) {
      playingUrl = null;
      stopMpv();
      setVideoMode(false);
      emit({ type: "finished" });
    }
  };
  if (appWindow(m.id)) {
    // already running in the background -> instant resume of its live window
    stopPrevPlayback();
    foregroundApp(m.id);
    return;
  }
  if (m.type === "webclient") {
    const rt = m.runtime || {};
    if (rt.serve === "remote") {
      // Untrusted live site (e.g. youtube.com/tv) or a config-driven LAN service
      // (e.g. Home Assistant) - loaded in a dedicated isolated window (see
      // openRemoteApp, which sets currentAppId once past its protocol guard), NOT
      // a Node-capable window. An unset config-driven URL means the app isn't
      // configured yet; the launcher gates that (tile.configured) so here we
      // just no-op rather than open a blank window.
      const url = resolveRemoteUrl(m);
      if (url) {
        stopPrevPlayback();
        openRemoteApp(m, url);
      } else console.warn("[nav] remote app not configured:", m.id);
      return;
    }
    // local bundle -> its own privileged window with the full preload.js SDK
    // (player/fetch/storage/onCommand/onNotify + bridge). A PACKAGE app
    // (serve:"local") serves its own web/ at /<id>/; the legacy single
    // root-mounted bundle (serve:"static", mount:"root", e.g. Plex) is at /.
    // Curated apps run privileged (review is the trust boundary).
    stopPrevPlayback();
    openLocalApp(m);
    return;
  }
  // (No builtin branch: every app is a webclient package now - either a local
  // web/ bundle served at /<id>/ or a remote site - handled above.)
}

// Cycle foreground through the running apps (the `appswitcher` remap action).
// From the launcher it foregrounds the most recently used app; from an app it
// goes to the next running one (wrapping); with nothing running it's a no-op.
function switchApp() {
  const running = appwins.all();
  if (!running.length) return;
  if (!currentAppId) {
    running.sort((a, b) => (b[1].tvboxLastShown || 0) - (a[1].tvboxLastShown || 0));
    navTo(running[0][0]);
    return;
  }
  const ids = running.map(([id]) => id);
  const next = ids[(ids.indexOf(currentAppId) + 1) % ids.length];
  if (next === currentAppId) showLauncher();
  else navTo(next);
}

// Navigate between the HOME launcher and an app. The launcher calls
// window.tvbox.launch(id); the Home button calls window.tvbox.home() (local apps)
// or is caught main-side (remote apps) -> back to the launcher, stopping video.
ipcMain.on("nav", (_e, dest) => navTo(dest));

// Which app a capability call belongs to - the SENDER window's own identity
// (windowAppId), never the global foreground id. Every window is permanently
// bound to one app, so a BACKGROUND app's call is still scoped to its own
// caps/origins/storage - there is no window reuse and thus no confused deputy.
// Unknown/stale senders resolve to null (denied by the cap checks below).
function appIdForSender(sender) {
  const id = windowAppId(sender);
  return id || null; // launcher (null) and unknown (undefined) both deny app caps
}

// ---- capability: scoped server-side fetch (data proxy) ----
// Keyed to the SENDER's app: it only reaches the hosts that app declared in
// runtime.origins, and only if it holds the "fetch" capability. This is the
// sandbox-safe alternative to a service plugin for "fetch + parse a feed"
// (e.g. an IPTV app's channel list / XMLTV). Guards live in appfetch.js.
ipcMain.handle("app:fetch", async (e, req) => {
  const id = appIdForSender(e.sender);
  const m = id && apps.manifestById(id);
  if (!m || !capsFor(id).includes("fetch")) return { ok: false, error: "no fetch capability" };
  const origins = (m.runtime && m.runtime.origins) || [];
  req = req || {};
  return appfetch.proxy({ origins, url: req.url, method: req.method, headers: req.headers, body: req.body });
});

// ---- capability: per-app key/value storage ----
// A small shell-owned kv namespace scoped to the sender's app id (never
// cross-app), gated on the "storage" capability. Persisted + size-capped in
// appdata.js.
ipcMain.handle("app:storage", (e, action, key, value) => {
  const id = appIdForSender(e.sender);
  if (!id || !capsFor(id).includes("storage")) return { ok: false, error: "no storage capability" };
  if (action === "get") return { ok: true, value: appdata.get(id, key) };
  if (action === "set") return appdata.set(id, key, value);
  if (action === "remove") return appdata.remove(id, key);
  return { ok: false, error: "unknown storage action" };
});

ipcMain.handle("player", (e, action, payload) => {
  payload = payload || {};
  console.log("[player] action", action, payload && payload.url ? payload.url.slice(0, 55) : "");
  if (action === "queue") {
    queued.url = payload.url;
    queued.startPos = payload.startPos || 0;
  } else if (action === "play") {
    // remember whose window the video belongs to: the first-frame reveal
    // (setVideoMode(true) in observeMpv) must hit THAT window, not the launcher
    mpvOwnerId = appIdForSender(e.sender);
    if (mpv && playingUrl === queued.url && !mpvPip) {
      console.log("[player] resume (already loaded)");
      mpvCmd({ command: ["set_property", "pause", false] });
    } else if (queued.url) {
      playingUrl = queued.url;
      setVideoMode(false);
      ensureAudio(() => launchMpv(queued.url, queued.startPos));
    } // fullscreen (also un-PiPs)
  } else if (action === "pause") mpvCmd({ command: ["set_property", "pause", true] });
  else if (action === "resume") mpvCmd({ command: ["set_property", "pause", false] });
  else if (action === "stop") {
    playingUrl = null;
    stopMpv();
    setVideoMode(false);
  } else if (action === "seek") mpvCmd({ command: ["seek", payload.posSec || 0, "absolute"] });
  else if (action === "tracks") {
    // audio/subtitle tracks of the playing stream, for an in-playback picker
    return mpvQuery(["get_property", "track-list"]).then((list) => ({
      ok: Array.isArray(list),
      tracks: (Array.isArray(list) ? list : [])
        .filter((t) => t && (t.type === "audio" || t.type === "sub"))
        .map((t) => ({
          type: t.type,
          id: t.id,
          lang: t.lang || "",
          title: t.title || "",
          selected: !!t.selected,
        })),
    }));
  } else if (action === "track") {
    // { type: "audio"|"sub", id: <track id> | "no" | "auto" } - aid/sid switch
    const prop = payload.type === "sub" ? "sid" : "aid";
    const v = payload.id === "no" || payload.id === "auto" ? payload.id : Number(payload.id);
    if (typeof v === "string" || Number.isFinite(v)) mpvCmd({ command: ["set_property", prop, v] });
  } else if (action === "pip") {
    // Toggle the current channel between a PiP (at the launcher-measured rect) and
    // fullscreen. PiP needs the window transparent (so mpv behind shows through the
    // hole); fullscreen starts opaque and observeMpv reveals on the first frame.
    if (playingUrl) {
      setVideoMode(!!payload.on);
      ensureAudio(() => launchMpv(playingUrl, 0, !!payload.on, payload.rect));
    }
  }
  return { ok: true };
});

// ---- home-screen widgets (plugin-driven) ----
// A service plugin (the only sanctioned background code) can put ONE card on
// the HOME screen - e.g. Spotify's now-playing while a cast is active. The
// plugin pushes state, the launcher renders it, Enter opens the app; renderer
// apps stay strictly foreground-only. Sanitized here; cleared on uninstall.
const widgets = new Map(); // appId -> { title, subtitle }
function setWidget(appId, w) {
  if (!w || typeof w !== "object" || (!w.title && !w.subtitle)) widgets.delete(appId);
  else
    widgets.set(appId, {
      title: String(w.title || "").slice(0, 120),
      subtitle: String(w.subtitle || "").slice(0, 160),
    });
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send("widgets", widgetList());
    } catch (e) {}
  }
}
function widgetList() {
  return [...widgets.entries()].map(([id, w]) => ({ id, ...w }));
}

// ---- plugin host API + loader ----
// The scoped surface a plugin gets. Deliberately small: config + pairing + a
// supervised-child runner + "bring the launcher forward" + a couple of helpers.
// A plugin never sees `win`, `mpv`, or the manifest registry directly.
const host = {
  base: BASE,
  config, // config store (rawSpotify / setSpotify / publicConfig)
  pairing: { register: pairing.register }, // let a plugin register its own pairing page(s) (kind -> provider)
  BrowserWindow, // for a plugin that needs its own window (Spotify OAuth)
  json: jsonRes, // (res, obj) -> JSON response
  log: (...a) => console.log("[plugin]", ...a),
  childEnv: () => ({ ...process.env, ...WL_ENV }), // spawn env with the session's Wayland vars
  audioSink: () => audioSink, // detected HDMI sink node.name (set by ensureAudio)
  showLauncher, // (hash) -> stop other playback + bring launcher forward
  navTo, // (id) -> open an app by id (e.g. a plugin foregrounds its app on a cast)
  onConfigChange: (cb) => {
    if (typeof cb === "function") configListeners.push(cb);
  },
  // Register a plugin's HTTP routes under a path prefix. `table` is keyed
  // "METHOD /subpath" (e.g. "GET /state"); the generic server tries these before
  // its own built-in routes. Called from a plugin factory (before serve()).
  registerRoutes: (prefix, table) => {
    pluginRoutes.push({ prefix, table });
  },
  spawnService: (name, spec) => supervisor.spawn(name, spec),
  stopService: (name) => supervisor.stop(name),
  restartService: (name, delay) => supervisor.restart(name, delay),
};

// Require each manifest-declared plugin whose deps resolve. Runs synchronously
// (before serve()) so routes are registered (via host.registerRoutes in the
// factory) before the launcher's first request; daemons start later in
// startPlugins() (after audio).
// Load ONE app's service plugin (require + run its factory so it registers its
// routes via host.registerRoutes). Returns the plugin object, or null if it has
// no valid service, ships no package plugin.js, its deps are missing, or it is
// already loaded. Does NOT start the daemon - the caller decides when (boot:
// startPlugins; runtime hot-load: right away).
function loadOnePlugin(m) {
  const name = m.service;
  if (!name) return null;
  if (loadedPluginIds.has(m.id)) return null;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    console.warn("[plugin] bad service name for", m.id, "->", name);
    return null;
  }
  // A service plugin ships INSIDE the app package (~/.tvbox/apps/<id>/plugin.js);
  // the shell has no first-party plugins anymore. A manifest with a service but
  // no package dir is malformed - skip it.
  if (!m._dir) {
    console.warn("[plugin] skip", m.id, "- declares service", name, "but ships no package plugin.js");
    return null;
  }
  const deps = apps.appDeps(m);
  if (!deps.depsOk) {
    console.warn("[plugin] skip", m.id, "- missing:", deps.missing.join(","));
    return null;
  }
  try {
    const plugin =
      require(path.join(m._dir, "plugin.js"))({
        ...host,
        // per-app widget slot - a plugin can only ever write its OWN card
        widget: { set: (w) => setWidget(m.id, w), clear: () => setWidget(m.id, null) },
      }) || {};
    loadedPlugins.push(plugin);
    loadedPluginIds.add(m.id);
    console.log("[plugin] loaded", m.id, "(" + name + ")");
    return plugin;
  } catch (e) {
    console.warn("[plugin]", m.id, "failed to load:", e.message);
    return null;
  }
}
function loadPlugins() {
  for (const m of apps.getManifests()) loadOnePlugin(m);
}
// Hot-load a plugin whose app just became installable (deps + package present)
// WITHOUT a shell restart: run its factory so its routes register on the live
// server, then start its daemon now. Returns true if the plugin is running (or
// already was). This is why a `service` app no longer needs a full restart to
// activate after install.
function hotLoadPlugin(id) {
  const m = apps.manifestById(id);
  if (!m || !m.service) return false;
  if (loadedPluginIds.has(id)) return true;
  const plugin = loadOnePlugin(m);
  if (!plugin) return false;
  try {
    if (plugin.start) plugin.start();
    console.log("[plugin] hot-started", id);
  } catch (e) {
    console.warn("[plugin] hot-start", id, "failed:", e.message);
  }
  return true;
}
function startPlugins() {
  for (const p of loadedPlugins) {
    try {
      if (p.start) p.start();
    } catch (e) {
      console.warn("[plugin] start:", e.message);
    }
  }
}
function stopPlugins() {
  for (const p of loadedPlugins) {
    try {
      if (p.stop) p.stop();
    } catch (e) {}
  }
  supervisor.stopAll();
}

app.whenReady().then(() => {
  try {
    execFile("pkill", ["-9", "-f", "tvbox-mpv.sock"], () => {});
  } catch (e) {} // reap orphan mpv from a previous run
  apps.loadManifests();
  // Core pairing kinds (box features). App-specific kinds (iptv, spotify,
  // keyboard) are registered by their package plugin's factory via
  // host.pairing.register - they ship in the app package, not the shell.
  pairing.register("photos", require("./pairing/photos"));
  pairing.register("backup", backupPairing);
  // A restore replaced config.json + user apps - plugins only read credentials
  // at boot, so restart the shell shortly after (the phone page + TV UI get a
  // few seconds to show "restored").
  backupPairing.onRestored(() => {
    restoredAt = Date.now();
    setTimeout(() => restartShell("backup restored"), 4000);
  });
  // isIdle includes "no install in flight": the OTA auto-apply must never
  // restart the shell under a half-finished app provision (store.install has
  // already swapped the manifest by then, so the nightly would never retry).
  updater.init({ isIdle: () => boxIdle() && installing.size === 0, restart: () => restartShell("update applied") });
  loadPlugins(); // require plugins + register their routes (deps-gated)
  apps.installAll((s) => console.log("[install]", s));
  serve();
  // Re-apply the saved display mode (the compositor boots at the EDID preferred
  // mode; a user who forced e.g. 1080p wants it back after a restart).
  {
    const d = config.rawDisplay();
    if (d && d.mode)
      display.applyKey({ ...process.env, ...WL_ENV }, d.mode, (ok) =>
        console.log("[display] boot apply", d.mode, ok ? "ok" : "failed"),
      );
  }
  win = new BrowserWindow({
    fullscreen: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  // Surface the renderer console (launcher + local app pages: livetv/spotify/plex)
  // in the shell log, so an app that fails to render/init is diagnosable over ssh
  // (~/.tvbox/shell.log) instead of showing only a black screen.
  win.webContents.on("console-message", (ev) => {
    console.log(
      "[renderer:" + (CONSOLE_TAG[ev.level] || "?") + "]",
      ev.message,
      ev.sourceId ? "(" + ev.sourceId + ":" + ev.lineNumber + ")" : "",
    );
  });
  // BT remotes (e.g. Fire TV) send Back as KEY_BACK -> DOM BrowserBack/GoBack.
  // The launcher/sdk accept those directly, but a webclient app's own UI (the
  // Plex HTPC client) only understands the CEC remote's form (Backspace). While
  // an app owns this window, swallow the browser key and re-inject a real
  // Backspace through the input pipeline (a trusted event - synthetic DOM
  // events are not guaranteed to be honored). Never while the launcher is
  // showing (currentAppId null) - it handles BrowserBack itself. The injected
  // Backspace re-enters this handler but doesn't match, so no loop.
  win.webContents.on("before-input-event", (e, input) => {
    if (!currentAppId || (input.key !== "BrowserBack" && input.key !== "GoBack")) return;
    e.preventDefault();
    if (input.type !== "keyDown" && input.type !== "keyUp") return;
    if (input.type === "keyDown") console.log("[input] " + input.key + " -> Backspace (app " + currentAppId + ")");
    win.webContents.sendInputEvent({ type: input.type === "keyDown" ? "keyDown" : "keyUp", keyCode: "Backspace" });
  });
  win.loadURL(BASE + "/tvbox/"); // boot into the HOME launcher
  win.focus();
  // Keep a black backdrop behind the page by default (only removed during active
  // video) so the transparent window never reveals the desktop. insertCSS is
  // per-document, so re-arm on every navigation (launcher <-> app).
  // The first successful load is also the OTA health signal: it commits a
  // freshly flipped update (clears the rollback markers, syncs infra files).
  win.webContents.on("did-finish-load", () => {
    win.tvboxStyleInjected = false;
    ensureStyle(win);
    setVideoMode(false, win);
    updater.onLauncherLoaded();
  });
  // Background-apps policy hooks (registry lives in appwindows.js).
  appwins.init({
    enabled: () => {
      const a = config.rawApps();
      return !(a && a.background === false);
    },
    memInfo,
    foregroundId: () => currentAppId,
  });
  setInterval(() => appwins.ramGuardTick(), 60 * 1000); // evict hidden apps under memory pressure
  updater.startSchedulers(); // boot check + 6h re-check + nightly idle auto-apply
  setInterval(appsAutoTick, 30 * 60 * 1000); // nightly registry app auto-update (same window)
  setTimeout(btBatteryTick, 5 * 60 * 1000); // early check after boot, then half-hourly
  setInterval(btBatteryTick, 30 * 60 * 1000);
  // Start plugin daemons once the HDMI sink is the default (librespot needs it).
  ensureAudio(() => startPlugins());
  // MQTT bridge (now-playing publish + HA integration); no-op if not provisioned.
  // (The command handler is added by the voice-control work.)
  applyMqttConfig();
  ir.applyConfig(); // IR blaster hub; no-op if not configured
  console.log("[main] window up");
});

app.on("window-all-closed", () => {
  stopMpv();
  stopPlugins();
  mqttBridge.stop();
  app.quit();
});

// Quit gracefully on signals so localStorage (app logins) flushes and we don't
// leave an orphaned process holding port 8097 across a restart.
process.on("SIGTERM", () => {
  stopMpv();
  stopPlugins();
  mqttBridge.stop();
  app.quit();
});
process.on("SIGINT", () => {
  stopMpv();
  stopPlugins();
  mqttBridge.stop();
  app.quit();
});
