// tvbox Electron shell. A single fullscreen window that hosts the HOME launcher
// (our React app, served under /tvbox/) and "apps" described by manifests in
// apps/. Web-client apps (e.g. Plex HTPC) are served from their installed
// bundle and composited over mpv, which plays video BEHIND the transparent
// window driven over its JSON IPC. Apps get a capability-scoped bridge
// (preload.js); the remote Home button returns to the launcher from anywhere.
// Run: electron . --ozone-platform=wayland
const { app, BrowserWindow, ipcMain, screen, session } = require("electron");
const { spawn, execFile } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const config = require("./config");
const pairing = require("./pairing");
const playeropts = require("./playeropts"); // app stream terms -> mpv args/commands + the settable-property allowlist
const { redact } = require("./redact"); // an app's console line may carry ITS credentials; the shell's log is a file
const display = require("./display"); // resolution/refresh selection
const displaymode = require("./displaymode"); // adaptive mode: UI mode + per-video claims
const httpserver = require("./httpserver"); // responses, static files, the origin gate
const routes = require("./routes"); // the box's write API: every POST route and its validation
const player = require("./player"); // the shared mpv, its display-mode and HDR claims
const maintenance = require("./maintenance"); // installs, flatpak/bundle refresh, restore reconcile
const system = require("./system"); // network, clock, keyboard, name, About numbers
const hdrout = require("./hdr"); // whether the output should be in PQ for this film
const compositor = require("./compositor"); // the compositor's control socket
const wifiradio = require("./wifiradio"); // the wifi radio as a setting, not just a pairing dip
const textinput = require("./textinput"); // typing into a keyboard-less app (OSK / phone)
const lang = require("./lang"); // what language a remote web app is told it runs in
const audio = require("./audio"); // wpctl sink list + volume (device audio settings)
const bluetooth = require("./bluetooth"); // bluetoothctl pair/connect (audio + input devices)
const ambient = require("./ambient"); // weather + local photos for the idle/ambient screen
const mqttBridge = require("./mqtt"); // MQTT: now-playing publish + command/notify (HA integration)
const mediastate = require("./mediastate"); // mpv + app now-playing + sink -> ONE player state (HA media_player)
const ir = require("./ir"); // IR blaster hub: TV volume/mute over ESPHome or Home Assistant
const appwins = require("./appwindows"); // background-apps window registry + hidden-set policy (LRU/RAM guard)
const nativeapp = require("./native"); // native (non-Electron) apps: RetroArch et al own the screen AND the input
const fileserver = require("./fileserver"); // the box's folders over WebDAV (rclone, no root)
const browse = require("./browse"); // local + USB media: which roots exist, and listing one
const images = require("./images"); // photo thumbnails + view renders, and their cache
const photoshare = require("./photoshare"); // photos a phone cast at the viewer
const shares = require("./shares"); // network shares (SMB over rclone, no root), mounted per config
const miracast = require("./miracast"); // screen mirroring: the unprivileged half of a Wi-Fi Display sink
const firetvir = require("./firetvir"); // Fire TV remote IR programming (venv deps + irdb codesets + BLE tool)
const diag = require("./diag"); // what this box says about itself to the fleet (version, rollback, link, heat)
const apps = require("./install"); // manifests + install-recipe runner (shared with the tvbox CLI)
const store = require("./store"); // app-store registry client (manifest-only apps -> ~/.tvbox/apps)
const appfetch = require("./appfetch"); // capability: scoped server-side fetch (data proxy), origin-locked + SSRF-guarded
const netguard = require("./netguard"); // shared loopback/LAN/public host classification + lanIp
const appdata = require("./appdata"); // capability: per-app key/value storage under ~/.tvbox/appdata
const updater = require("./updater"); // OTA self-update (versions/ + `current` symlink flip)
const boothealth = require("./boothealth"); // "this boot reached the launcher" - the root-side safe-mode counter reads it
const backup = require("./backup"); // encrypted settings backup/restore (phone pairing page)
const backupPairing = require("./pairing/backup");
const reconcile = require("./reconcile"); // re-acquire what a restore could not carry (packages, deps, bundles)
const identity = require("./identity"); // per-box identity (hostname, derived device names)
const { Supervisor } = require("./service_supervisor"); // generic supervised child procs (plugins use it)
const pkg = require("./package.json"); // shell version (About/diagnostics)

const { PORT } = require("./constants");
const BASE = "http://localhost:" + PORT;
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

let win = null;
let currentAppId = null; // which app is FOREGROUND (null = launcher); drives focus + video-mode targeting

// The compositor cannot work out which of the launcher and an app owns the screen:
// both are windows of this process. It needs to know, because the remote's Back
// key is rewritten for an app (the app UIs only act on Backspace) and left alone
// for the launcher, which handles the browser key itself.
function setForegroundApp(id) {
  currentAppId = id;
  compositor.setFocus(id ? "app" : "launcher", id || null);
}
// A native app is MEANT to own the screen. Separate from nativeapp.running(): a
// stop() only asks (SIGTERM), and the process can outlive the request by a moment,
// so raising our own window must key off the intent, not the process. Cleared
// synchronously by every path that takes the screen back.
let nativeForeground = false;
// Which app's own UI the native process was launched FROM, when that app has one
// (RetroArch: our games grid starts the emulator per game). Its window is what the
// screen goes back to when the process exits, instead of HOME - the user came from
// a list of games and expects to land back in it. null for an app that IS its
// native program, where there is no window to return to.
let nativeHostApp = null;
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
// `streams` is the app's own track decision (a media client that resolved which
// audio/subtitle stream to play server-side, e.g. Plex): 0-based ordinals within
// their type, `sub: -1` = subtitles off, `subFile` = a sidecar subtitle URL.
// null anywhere = "no opinion", which leaves mpv's own selection alone.
const queued = { url: null, startPos: 0, streams: null };

// The box counts as idle for a self-initiated restart (nightly auto-update)
// only when nothing is on screen or audible: no mpv, launcher focused, and the
// last now-playing report isn't "playing" (librespot audio has no mpv process
// to look at). HIDDEN app windows don't block idleness - they're muted/paused,
// and the restart simply drops them (they reload on next launch).
function boxIdle() {
  return !player.running() && !currentAppId && !(nowPlaying && nowPlaying.state === "playing");
}
// Is the box free to start something substantial? Idle as above, no install in
// flight, and none of the shell's OWN background maintenance running. The last
// part is not redundant: the nightly app auto-update spends its registry download
// before any app is marked installing, so "idle and nothing installing" would call
// the box free while it is already saturating the link. maintenance.js owns those
// flags and answers for all of them. Everything that starts background work asks
// this - the OTA auto-apply, the bundle refresh, the app auto-update, and a plugin
// through `host.idle()` - so the answers cannot drift apart.
function boxFree() {
  return boxIdle() && !maintenance.busy();
}
// Restart the shell in-place: quit cleanly (localStorage flush, plugin stop);
// the session's respawn loop relaunches run-shell.sh, which follows the `current` symlink.
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
// ---- LAN file server (WebDAV) ----
// Copying a screensaver image onto the box, or a console BIOS into the folder an
// emulator reads, is not something a TV can do - and should not need ssh. The module
// owns the decisions (which folders are offered, what gets served, refusing to serve
// without a password); this is the wiring: config in, supervisor out.
// PATH matters here (rclone lands in ~/.tvbox/bin, which install.js prepends);
// the Wayland vars do not - this serves files, it draws nothing.
const fileserverDeps = { onPath: apps.onPath, childEnv: () => ({ ...process.env }), supervisor };
// Same reason for the same one field: `udisksctl` is what mounts a stick and it is
// not on every box (udisks2 is a soft dep, and OTA can never add an apt package),
// so browse.js asks before it runs anything. `shares` is a function rather than a
// list because a share can be added while the box is running.
const browseDeps = { onPath: apps.onPath, shares: () => config.rawShares() };

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
}

// Why there is no picture, as a status the UI can tell apart: a missing box
// dependency is something a person can fix, and a file this box cannot decode is
// not. The body stays empty - the caller is an <img>.
const IMAGE_ERROR_STATUS = { no_ffmpeg: 501, unsupported: 415, timeout: 504, failed: 500 };
function imageError(res, reason) {
  res.writeHead(IMAGE_ERROR_STATUS[reason] || 404, { "X-Tvbox-Reason": String(reason || "not_found") });
  res.end();
}
const sharesDeps = {
  onPath: apps.onPath,
  childEnv: () => ({ ...process.env }),
  supervisor,
};
// Mount what is configured (and unmount what is not) - on boot, and after every
// change to the list.
function applyShares() {
  const r = shares.apply(config.rawShares(), sharesDeps);
  if (!r.ok) console.warn("[shares] not mounted:", r.error);
  else if (r.mounted.length) console.log("[shares] mounting", r.mounted.join(", "));
  return r;
}
let rcloneInstalling = false;

// Screen mirroring. The radio half is root's and runs behind a systemd unit
// (miracast.js); what happens here is the other end of it - when frames start
// arriving, the shared player is pointed at the FIFO they are being written to,
// and when they stop it is let go again.
//
// Deliberately built where it is used rather than at module level: main.js has
// been killed once by an object assembled out of consts declared further down
// the file, and nothing in the test suite would catch it a second time.
// Whether mirroring is what is on the screen right now. Not the same as "armed":
// a sink can be up and waiting with a film still playing behind the Settings
// page someone armed it from.
let mirrorOnScreen = false;
const mirroring = miracast.create({
  log: (...a) => console.log("[miracast]", ...a),
  onEvent: (ev) => {
    if (ev.type === "streaming") {
      // A mirrored phone is live: there is no seeking and nothing to resume, so
      // it starts at zero and fullscreen like any other film. mpv reads the FIFO
      // as an ordinary file, which is what keeps this out of player.js entirely.
      ensureAudio(() => player.launch(ev.fifo, 0, false, null, null));
      // Get the launcher out of the way. mpv plays BEHIND this window, so
      // whatever page started mirroring - the Settings one, in practice - is
      // drawn straight over the phone's screen until the page is dropped and
      // the window made transparent.
      pushNav("mirroring");
      setVideoMode(true);
      mirrorOnScreen = true;
    }
    // Only undo what mirroring actually did. `stopped` is emitted by every
    // stop() - including a disarm from Settings and the pair-timeout - and
    // `peer-gone` fires for a source that drops before a single frame arrives.
    // Without this guard, disarming a sink nobody ever used would stop the mpv
    // playing someone's film and throw the viewer off the page they were on.
    if ((ev.type === "peer-gone" || ev.type === "stopped") && mirrorOnScreen) {
      mirrorOnScreen = false;
      player.stop();
      setVideoMode(false);
      pushNav("home");
    }
    if (ev.type === "error") console.warn("[miracast]", ev.message);
  },
});

// Tell the launcher which full-screen surface to show. Safe before the window
// exists (mirroring cannot be armed then) and safe after it has gone.
function pushNav(dest) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("tvbox-nav", { dest });
  } catch (e) {}
}

function applyFileserver() {
  try {
    return applyFileserverInner();
  } catch (e) {
    // The settings POST calls this synchronously; one feature's bad day must not be
    // the shell's last.
    console.warn("[fileserver] apply failed:", e.message);
    return { ok: false, error: "failed" };
  }
}
function applyFileserverInner() {
  const cfg = config.rawFileserver();
  if (!cfg.enabled) {
    fileserver.stop(fileserverDeps);
    return { ok: true, stopped: true };
  }
  const r = fileserver.start(cfg, fileserverDeps);
  if (!r.ok) {
    fileserver.stop(fileserverDeps); // never leave a half-started share behind
    console.warn("[fileserver] not started:", r.error);
  } else {
    console.log("[fileserver] serving", r.shared.length, "folder(s) on", r.url || ":" + r.port);
  }
  return r;
}

// rclone is a ~20MB download, so it runs out of process like every other no-root
// binary install - the UI polls the status for `rclone`.
function installRclone() {
  if (rcloneInstalling || apps.onPath("rclone")) return false;
  rcloneInstalling = true;
  const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "fileserver-deps"], {
    env: { ...process.env, ...WL_ENV, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  const done = () => {
    rcloneInstalling = false;
    if (!apps.onPath("rclone")) return;
    // Both features run on this one binary, so whichever asked for it, everything
    // waiting on it can start now.
    if (config.rawFileserver().enabled) applyFileserver();
    if (config.rawShares().length) applyShares();
  };
  child.on("error", done);
  child.on("exit", done);
  return true;
}

// ---- app manifests + install (the install-recipe runner lives in install.js,
// shared with the `tvbox` CLI; the shell just queries manifests + serves apps) ----

// Launchable = belongs on HOME: ready status, binary deps present, configured, a
// bundle app has its bundle, and not mid-install. HOME shows ONLY these, so a
// still-installing or not-yet-provisioned app stays in the store (with progress)
// instead of appearing greyed on HOME.
//
// One function, because two callers answer the same question and must not drift:
// the tile list the launcher draws, and the source list the Home Assistant
// media_player offers. A source that HOME would refuse to open must not be
// offered there either.
function appLaunchable(m) {
  const { depsOk } = apps.appDeps(m);
  const rt = m.runtime || {};
  // A remote web-app whose URL comes from config (runtime.urlConfig) is only
  // launchable once that URL is set (e.g. Home Assistant).
  const configured = rt.serve === "remote" && rt.urlConfig ? !!(config.appConfig(rt.urlConfig) || {}).baseUrl : true;
  const installable = !!(m.install && m.install.source);
  return (
    m.status === "ready" &&
    depsOk &&
    configured &&
    !maintenance.isInstalling(m.id) &&
    (!installable || apps.isInstalled(m.id))
  );
}

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
      // running badge + quit affordance, resume is instant via navTo. A native app
      // has no window of ours, so its own process is what "running" means, and it
      // is never backgrounded: it either owns the screen or it has exited.
      running: m.type === "native" ? nativeapp.id() === m.id : !!appwins.get(m.id),
      foreground: m.id === currentAppId,
      // Phone-pairing affordances the app declares (Settings shows a row each).
      // Only kind + label: the launcher starts the session and draws the QR, the
      // app's own plugin owns everything that happens on the phone.
      pairing: Array.isArray(m.pairing) ? m.pairing.map((p) => ({ kind: p.kind, label: p.label })) : undefined,
      depsOk,
      missing,
      depsInstallable, // every missing binary is a no-root download dep -> UI-installable (no CLI)
      installable,
      installed: apps.isInstalled(m.id),
      installing: maintenance.isInstalling(m.id),
      configured,
      ready: appLaunchable(m), // see appLaunchable: the one definition HOME and HA share
      progress: maintenance.progressFor(m.id) || null,
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
  if (on) flip(w || appWindow(player.owner()) || win);
  else if (w) flip(w);
  else {
    flip(win);
    for (const [, aw] of appwins.all()) flip(aw);
  }
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

// Adaptive display mode. The UI draws at the panel's own resolution capped to
// 1080p (a 4K launcher costs bandwidth and heat for nothing), and video claims a
// mode that suits the content - refresh first, so 24p film stops juddering - then
// gives it back. There is no manual resolution setting: any app can claim through
// the `display` capability, and the mpv path below is just the first caller.
// Mode selection lives in display.js (pure, unit-tested), arbitration in
// displaymode.js.
// What the panel can show. Read as a side effect of the mode reads the arbiter
// already does - at startup and on every output change - so nothing extra runs.
let panelResolution = null;
// What the output is CURRENTLY at, which is not the panel's own resolution: the UI
// runs at 1080p on a 4K set. Window rectangles are in these pixels.
let outputSize = null;
let panelHdr = false; // the panel accepts BT2020 + PQ (EDID, read once at startup)
const dmode = displaymode.create({
  getModes: (cb) =>
    display.list((info) => {
      const panel = display.panelResolution(info && info.modes);
      if (panel) panelResolution = panel;
      const current = ((info && info.modes) || []).find((m) => m.current);
      if (current) outputSize = { width: current.width, height: current.height };
      cb(info);
    }),
  applyMode: (output, mode, cb) => display.apply(output, mode, cb),
  log: (m) => console.log("[display]", m),
});
const appClaimId = (id) => "app:" + (id || "launcher"); // an app's own claim id
const displayClaiming = new Set(); // app ids with a claim in flight (one at a time)

// A TV power cycle re-adds the output at the EDID PREFERRED mode (4K on a 4K set),
// undoing whatever we chose, so re-assert on every output change. The event
// payload is stale while the compositor settles: debounce, then let the service re-read
// the live mode - that comparison also stops our own apply from re-triggering us.
function watchDisplayMode() {
  let timer = null;
  const recheck = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      dmode.refresh();
    }, 2000);
  };
  // display-added is a NEW hotplug session (the TV came back), so it re-arms the
  // "it won't stick" budget. display-metrics-changed is not: our own apply emits
  // one, and that must not hand itself a fresh set of retries.
  screen.on("display-added", () => {
    dmode.rearm();
    recheck();
  });
  screen.on("display-metrics-changed", recheck);
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
    if (action === "sleep_if_idle" && !boxIdle()) return httpserver.jsonRes(res, { ok: true, slept: false });
    showLauncher(); // stop playback / leave any remote app, back to Home
    cecPower(false); // TV off via CEC
    return httpserver.jsonRes(res, { ok: true, slept: true });
  }
  const sub = action === "reboot" || action === "poweroff" ? action : null;
  if (!sub) return httpserver.jsonRes(res, { ok: false, error: "bad action" });
  console.log("[power]", sub);
  execFile("systemctl", [sub], { timeout: 8000 }, (e, _o, err) => {
    if (!e) return httpserver.jsonRes(res, { ok: true });
    execFile("sudo", ["-n", "systemctl", sub], { timeout: 8000 }, (e2, _o2, err2) => {
      httpserver.jsonRes(
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

// Only our own pages may issue a state-changing request; httpserver.js says why a
// request with no Origin at all is not one of them.
const OWN_ORIGINS = httpserver.ownOrigins(PORT);

function serve() {
  // What the write API is allowed to reach into. Everything here is the shell's own
  // state or its windows; anything that is a module of its own, routes.js requires
  // directly.
  //
  // Built HERE rather than at module level: half of what it names is declared
  // further down the file, and a module-level literal captures those bindings while
  // they are still in their temporal dead zone - the shell then dies at load with
  // "Cannot access X before initialization", which no unit test sees because none
  // of them can load this file.
  const routeCtx = {
    appIsRunning: (id) => !!appWindow(id),
    applyFileserver,
    applyMqttConfig,
    audioSink: () => audioSink,
    childEnv: () => ({ ...process.env, ...WL_ENV }),
    destroyAppWindow,
    dmode,
    emitConfigChange,
    // The audio route re-runs the sink detection and answers with what it picked,
    // so it needs both halves.
    ensureAudio,
    exitApp,
    fileserverStatus: () => fileserver.status(config.rawFileserver(), fileserverDeps),
    applyShares,
    sharesDeps,
    sharesStatus: () => shares.status(config.rawShares(), sharesDeps),
    mirroring,
    foregroundApp: () => currentAppId,
    handlePower,
    installRclone: () => installRclone() || rcloneInstalling,
    navTo,
    // The launcher's own navigation, for the destinations navTo does not own.
    navToLauncher: (dest) => {
      if (win && !win.isDestroyed()) win.webContents.send("tvbox-nav", { dest });
    },
    publishMediaState,
    publishNowPlaying: (data) => {
      if (mqttCtl) mqttCtl.publish("nowplaying", data, { retain: true });
    },
    remoteBridgeCmd,
    setNowPlaying: (data) => {
      nowPlaying = data;
    },
    setSleepTimer,
    setWidget,
    showLauncher,
    switchApp,
    // The same on-screen note MQTT can push, reachable locally: the voice
    // satellite is a separate process on this box and an answer belongs on the
    // TV, but a spoken one interrupts a film in a way a toast does not.
    notify: handleTvNotify,
  };

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
    // API + plugin POST routes) plus the GETs that have side effects - tv/standby
    // (stops playback) and the firetvir reads (they spawn a python subprocess /
    // bluetoothctl and drive outbound GitHub fetches, so they aren't the
    // side-effect-free reads the open-GET policy assumes). Other read-only GETs
    // stay open - they leak nothing actionable and blocking them would break
    // <img>/no-CORS uses.
    // browse/* is on this list for the same reason firetvir is: both GETs fork a
    // process (lsblk), so they are not the side-effect-free reads the open-GET
    // policy assumes. The cache in removable.js is what actually bounds the cost -
    // an <img> or <iframe> request carries no Origin header for this to catch.
    // photoshare's reads are on the list for the ffmpeg half of the same reason:
    // a thumbnail that is not in the cache yet forks a process to make one.
    const guardedGet =
      p === "/tvbox/api/tv/standby" ||
      p.startsWith("/tvbox/api/firetvir/") ||
      p.startsWith("/tvbox/api/browse/") ||
      p.startsWith("/tvbox/api/photoshare");
    if ((req.method !== "GET" || guardedGet) && httpserver.foreignOrigin(req, OWN_ORIGINS)) {
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
        const route = httpserver.matchPluginRoute(pluginRoutes, "POST", p);
        if (route) {
          try {
            route(req, res, { body: d });
          } catch (e) {
            res.writeHead(500);
            res.end();
          }
          return;
        }
        routes.post(p, d, res, routeCtx);
      });
      return;
    }
    // plugin-registered GET routes (e.g. all of Spotify's) take precedence
    const gRoute = httpserver.matchPluginRoute(pluginRoutes, "GET", p);
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
      httpserver.jsonRes(res, config.publicConfig());
      return;
    }
    if (p === "/tvbox/api/pairing/status") {
      httpserver.jsonRes(res, { phoneConnected: pairing.phoneConnected() });
      return;
    }
    // IR blaster backend health for the settings card (connected/lastError)
    if (p === "/tvbox/api/ir/status") {
      httpserver.jsonRes(res, ir.status());
      return;
    }
    if (p === "/tvbox/api/wifi/status") {
      // The radio state comes from nmcli, not from the config: what the UI shows
      // has to be what the box IS, so a radio something else turned back on does
      // not read as off just because the setting says so.
      system.wifiStatus((s) =>
        system.ethernetStatus((eth) =>
          wifiradio.state({ ...process.env, ...WL_ENV }, (radio) =>
            httpserver.jsonRes(res, { ...s, ethernet: eth, radio: radio === null ? null : radio === "enabled" }),
          ),
        ),
      );
      return;
    }
    if (p === "/tvbox/api/system/region") {
      system.systemRegion((r) => httpserver.jsonRes(res, r));
      return;
    }
    if (p === "/tvbox/api/wifi/list") {
      system.wifiList((n) => httpserver.jsonRes(res, { networks: n }));
      return;
    }
    if (p === "/tvbox/api/system/info") {
      system.systemInfo((i) => httpserver.jsonRes(res, i));
      return;
    }
    if (p === "/tvbox/api/update/status") {
      httpserver.jsonRes(res, updater.status());
      return;
    }
    if (p === "/tvbox/api/backup/status") {
      httpserver.jsonRes(res, { restoredAt });
      return;
    }
    if (p === "/tvbox/api/reconcile/status") {
      httpserver.jsonRes(res, reconcile.state());
      return;
    }
    if (p === "/tvbox/api/backup/pending-localstorage") {
      httpserver.jsonRes(res, backup.pendingLocalStorage());
      return;
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
          ...dmode.state(),
        });
      });
      return;
    }
    if (p === "/tvbox/api/audio/sinks") {
      audio.listSinks({ ...process.env, ...WL_ENV }, (sinks) =>
        httpserver.jsonRes(res, { sinks, override: (config.rawAudio() || {}).sink || null }),
      );
      return;
    }
    if (p === "/tvbox/api/bt/status") {
      bluetooth.status({ ...process.env, ...WL_ENV }, (s) => httpserver.jsonRes(res, s));
      return;
    }
    if (p === "/tvbox/api/bt/devices") {
      bluetooth.list({ ...process.env, ...WL_ENV }, (d) => httpserver.jsonRes(res, { devices: d }));
      return;
    }
    if (p === "/tvbox/api/remote/devices") {
      // Currently-managed remotes (published by the bridge). Merge in the saved
      // keymap per device so the UI shows what's already bound.
      const list = (readBridgeJson("remote-devices.json", { devices: [] }).devices || []).slice(0, 20);
      const saved = (config.rawRemote() || {}).devices || {};
      httpserver.jsonRes(res, {
        devices: list.map((d) => ({ ...d, keymap: (saved[d.id] && saved[d.id].keymap) || {} })),
      });
      return;
    }
    if (p === "/tvbox/api/remote/learned") {
      httpserver.jsonRes(res, { learned: readBridgeJson("remote-learned.json", null) });
      return;
    }
    if (p === "/tvbox/api/ambient/weather") {
      ambient.weather((config.rawAmbient() || {}).city, (w) => httpserver.jsonRes(res, w || {}));
      return;
    }
    if (p === "/tvbox/api/ambient/photos") {
      httpserver.jsonRes(res, { photos: ambient.photos() });
      return;
    }
    if (p === "/tvbox/api/ambient/photo") {
      const name = (req.url || "").split("?")[1] ? new URLSearchParams(req.url.split("?")[1]).get("name") : "";
      return httpserver.serveStatic(res, ambient.PHOTO_DIR, name || "", null); // serveStatic guards the root boundary (no traversal)
    }
    // TV powered off (from the CEC bridge) -> stop playback
    if (p === "/tvbox/api/tv/standby") {
      player.onTvStandby();
      httpserver.jsonRes(res, { ok: true });
      return;
    }
    // Fire TV remote IR programming (Settings → Peripherals; shell/firetvir.js)
    if (p === "/tvbox/api/firetvir/status") {
      firetvir.status((s) => httpserver.jsonRes(res, s));
      return;
    }
    // Which connected remotes are Fire TV / Alexa remotes we can program (expose
    // the keymap GATT service). The remap UI shows the IR feature ONLY for these.
    if (p === "/tvbox/api/firetvir/programmable") {
      firetvir.programmableRemotes((macs) => httpserver.jsonRes(res, { macs }));
      return;
    }
    if (p === "/tvbox/api/firetvir/brands") {
      firetvir.fetchBrands((err, brands) =>
        httpserver.jsonRes(
          res,
          err ? { ok: false, error: String(err.message || err).slice(0, 200) } : { ok: true, brands },
        ),
      );
      return;
    }
    if (p === "/tvbox/api/firetvir/codeset") {
      const q = (req.url || "").split("?")[1];
      const csPath = q ? new URLSearchParams(q).get("path") || "" : "";
      firetvir.fetchCodeset(csPath, (err, cs) => {
        if (err) return httpserver.jsonRes(res, { ok: false, error: String(err.message || err).slice(0, 200) });
        firetvir.checkProtocols(cs.protocols, (perr, supported) =>
          httpserver.jsonRes(res, { ok: true, ...cs, supported: perr ? null : supported }),
        );
      });
      return;
    }
    if (p === "/tvbox/api/fileserver") {
      const st = fileserver.status(config.rawFileserver(), fileserverDeps);
      return httpserver.jsonRes(res, { ...st, installing: rcloneInstalling });
    }
    // What there is to play on the box itself: the user's own folders and each
    // partition of a plugged-in USB stick (browse.js). Read-only; the app that
    // walks them is the registry's `files` package, and mounting is a POST.
    if (p === "/tvbox/api/shares") {
      return httpserver.jsonRes(res, {
        ...shares.status(config.rawShares(), sharesDeps),
        installing: rcloneInstalling,
      });
    }
    // Screen mirroring. `available` is what greys the tile: a box whose radio is
    // carrying its own network cannot do this at all, and saying so up front is
    // better than a button that always fails.
    if (p === "/tvbox/api/miracast") {
      const st = mirroring.state();
      return httpserver.jsonRes(res, {
        armed: mirroring.isArmed(),
        streaming: mirroring.isStreaming(),
        name: st.name || "",
        ssid: st.ssid || "",
        channel: st.channel || "",
      });
    }
    if (p === "/tvbox/api/browse/sources") {
      browse.sources(browseDeps, (s) => httpserver.jsonRes(res, s));
      return;
    }
    if (p === "/tvbox/api/browse/list") {
      const q = (req.url || "").split("?")[1];
      const target = q ? new URLSearchParams(q).get("path") || "" : "";
      browse.list(browseDeps, target, (r) => httpserver.jsonRes(res, r));
      return;
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
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const wantView = p.endsWith("/image");
      browse.file(browseDeps, q.get("path") || "", (r) => {
        if (!r.ok) return imageError(res, r.error);
        const done = (err, out) => (err ? imageError(res, err) : sendImage(res, out));
        if (wantView) images.view(r.path, Number(q.get("w")) || 0, done);
        else images.thumb(r.path, done);
      });
      return;
    }
    // The same two, for photos a phone cast at the viewer. A different containment
    // rule - one flat directory, and a name pattern with no separator in it - so
    // this does not need to be a browse root to be readable.
    if (p === "/tvbox/api/photoshare") {
      return httpserver.jsonRes(res, { names: photoshare.list(), max: photoshare.MAX_ITEMS });
    }
    if (p === "/tvbox/api/photoshare/thumb" || p === "/tvbox/api/photoshare/image") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const file = photoshare.pathFor(q.get("name") || "");
      if (!file) return imageError(res, "not_found");
      const done = (err, out) => (err ? imageError(res, err) : sendImage(res, out));
      if (p.endsWith("/image")) images.view(file, Number(q.get("w")) || 0, done);
      else images.thumb(file, done);
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
            installing: maintenance.isInstalling(e.id),
            progress: maintenance.progressFor(e.id) || null,
            flatpakStatus: maintenance.flatpakStatusFor(e.id), // result of the last manual flatpak update
          }));
          httpserver.jsonRes(res, { ...d, apps: apps2, installing: maintenance.installingIds() });
        })
        .catch((e) => httpserver.jsonRes(res, { apps: [], error: String(e.message || e).slice(0, 120) }));
      return;
    }
    // launcher's app list. Manifests are re-read on every call (a handful of
    // small JSON files) so a dropped-in ~/.tvbox/apps manifest appears as a
    // tile live - no shell restart. Plugins/services still load at boot only.
    if (p === "/tvbox/api/power/sleep-timer") {
      httpserver.jsonRes(res, { at: sleepTimerAt });
      return;
    }
    if (p === "/tvbox/api/widgets") {
      httpserver.jsonRes(res, { widgets: widgetList() });
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
      httpserver.serveStatic(res, LAUNCHER, p.slice("/tvbox/".length), null);
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
    const a = rootWebApp();
    if (!a) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no root app");
      return;
    }
    const root = apps.appDataDir(a.id);
    const entry = (a.runtime && a.runtime.entry) || "index.html";
    if (p === "/") p = "/" + entry;
    httpserver.serveStatic(res, root, p, path.join(root, entry));
  });
  // A restart races the dying instance for the port (the session's respawn loop
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

// Bring the FOREGROUND shell window (the active app's own window, or the
// launcher) to the front and hand it focus. Shared by playback start and by
// showLauncher. Nothing has to be said about mpv: the compositor keeps every
// window of ours in front of anything else, which is what the transparent UI over
// a playing film depends on.
function raiseWindow() {
  // A native app is the visible toplevel and holds keyboard focus; raising a
  // window of ours over it would both hide the app and steal its input.
  if (nativeForeground) return;
  const w = foregroundWindow();
  if (w && w !== win && !w.isDestroyed()) {
    try {
      if (w.isMinimized()) w.restore();
      w.setAlwaysOnTop(true, "screen-saver");
      w.show();
      w.focus();
      w.moveTop();
    } catch (e) {}
    return;
  }
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    win.setAlwaysOnTop(true, "screen-saver");
    win.show();
    win.focus();
    win.moveTop();
  } catch (e) {}
}
// Stop any other playback and bring the launcher forward, optionally at a hash
// (e.g. "#spotify" so it opens a built-in view). Exposed to plugins via the host
// API - this is how a cast jumps to the Spotify now-playing screen without core
// knowing anything Spotify-specific.
function showLauncher(hash) {
  if (!win || win.isDestroyed()) return;
  const leaving = currentAppId;
  // Unconditionally, NOT `if (leaving)`: while the typing screen is up the app is
  // already backgrounded and currentAppId is null, so a Home press there would have
  // left the session alive - and a live session makes the next focusin a no-op
  // (focused() sees the same app+window and only refreshes its label), i.e. the
  // keyboard would never come up again.
  textinput.dropFor(null);
  setForegroundApp(null);
  player.setPlaying(null);
  player.stop();
  setVideoMode(false);
  // A native app owns the screen, so Home has to END it, not hide it. Drop the
  // intent first: the process outlives the SIGTERM by a moment and raiseWindow
  // below must not stand down for a native app we are already leaving.
  nativeForeground = false;
  nativeHostApp = null; // Home means HOME, not back into the UI the game was started from
  nativeapp.stop();
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
  // Popups belong to an app, but a popup of an app that is ALREADY hidden would
  // otherwise stay on screen over the launcher (backgroundApp only runs for the app
  // being left and for visible ones). Home is the universal escape hatch, so it must
  // clear every one of them.
  for (const [id] of appPopups) hidePopups(id);
}

// ---- per-app windows (background apps) ----
// Registry + hidden-set policy (mute/pause, LRU cap, RAM guard) live in
// appwindows.js; here is only the foreground orchestration. The "exactly ONE
// visible always-on-top toplevel" invariant still holds - hidden windows are
// unmapped in Wayland, so CEC key routing / stacking stay sane.
// Leaving the foreground drops the app's display claim: whatever mode it wanted
// for its video is wrong for whatever is on screen now.
// Park an app window for the duration of the typing screen: hidden and muted, never
// destroyed, and its popups with it.
function hideForTyping(id) {
  const w = appWindow(id);
  hidePopups(id);
  if (!w) return;
  try {
    w.webContents.setAudioMuted(true);
    w.hide();
  } catch (e) {}
}
function unhideForTyping(id) {
  const w = appWindow(id);
  if (!w) return false;
  try {
    w.webContents.setAudioMuted(false);
    w.setAlwaysOnTop(true, "screen-saver");
    w.show();
    w.focus();
    w.moveTop();
  } catch (e) {}
  return true;
}

const backgroundApp = (id) => {
  dmode.releaseIfHolder(appClaimId(id));
  hidePopups(id); // a sign-in popup must not stay on screen over the launcher
  return appwins.background(id);
};
// Leaving an app for real (Home, another app, a crash) drops any pending typing
// session - it could only be delivered to the window that asked for it. The typing
// screen backgrounds the app deliberately, so it calls textinput itself instead.
const leftForeground = (id) => textinput.dropFor(id);
const destroyAppWindow = (id) => {
  dmode.releaseIfHolder(appClaimId(id));
  closePopups(id);
  return appwins.destroy(id);
};

// Bring a running app's window back to the foreground (instant resume). The
// page kept its state; only audio is re-enabled - a paused video stays paused
// for the app/user to resume.
function foregroundApp(id) {
  const w = appWindow(id);
  if (!w) return false;
  applyAppLanguage(id); // the UI language may have changed while this app was away
  if (currentAppId && currentAppId !== id) leftForeground(currentAppId);
  setForegroundApp(id);
  appwins.touch(id);
  try {
    w.webContents.setAudioMuted(false);
  } catch (e) {}
  w.setAlwaysOnTop(true, "screen-saver");
  w.show();
  w.focus();
  w.moveTop();
  // A popup that was up when we left comes back on top of its app (a half-finished
  // sign-in shouldn't vanish because the user checked something else).
  for (const p of popupsOf(id)) {
    try {
      p.webContents.setAudioMuted(false);
      p.setAlwaysOnTop(true, "screen-saver");
      p.show();
      p.focus();
      p.moveTop();
    } catch (e) {}
  }
  for (const [oid, ow] of appwins.all()) if (oid !== id && ow.isVisible()) backgroundApp(oid);
  if (win && !win.isDestroyed()) win.hide(); // exactly one visible toplevel
  return true;
}

// ---- native apps (RetroArch et al) ----
// A native app is not a web page: it maps its OWN fullscreen Wayland toplevel and
// the compositor hands it keyboard focus. So the shell does the opposite of what it
// does for mpv (which stays BEHIND a transparent window and is driven over IPC so
// the launcher keeps focus): every Electron window of ours goes away and
// raiseWindow() stands down until the app exits.
//
// The hide is DELAYED, not immediate: the app needs a couple of seconds to map its
// window, and hiding first would leave the screen black in the gap. The compositor
// keeps our windows above every other client, so what covers the gap is the
// launcher itself, until the delay is up.
const NATIVE_HIDE_DELAY_MS = 2500;
function openNativeApp(m, extraArgs) {
  const deps = apps.appDeps(m);
  if (!deps.depsOk) {
    // Belt and suspenders: the tile is already greyed out via requires, so this
    // only fires if the manifest changed under us. Never leave a black screen.
    console.warn("[native] not launching", m.id, "- missing:", deps.missing.join(","));
    return false;
  }
  textinput.dropFor(null); // a typing session cannot survive into an app we don't own
  player.setPlaying(null);
  player.stop(); // the shared player must not hold the GPU, audio, or a mode claim
  setVideoMode(false);
  if (!nativeapp.start(m, extraArgs)) return false;
  // Where the screen goes when the program exits: this app's own window if it has one
  // (a game started from its grid), else HOME. Set HERE, after the program is really
  // running and in the one place both callers pass through, so a launch that failed
  // cannot leave a return target behind for whatever exits next.
  nativeHostApp = m.type === "native" ? null : m.id;
  setForegroundApp(m.id); // makes boxIdle() false too: no OTA restart mid-game
  nativeForeground = true;
  setTimeout(() => {
    if (!nativeapp.running() || nativeapp.id() !== m.id) return; // exited (or replaced) already
    for (const [id] of appwins.all()) backgroundApp(id);
    if (win && !win.isDestroyed()) win.hide();
  }, NATIVE_HIDE_DELAY_MS);
  return true;
}

// Launch an app's native program with per-launch arguments, on behalf of that
// app's own plugin (host.launchNative). The arguments are the point: a games grid
// starts `retroarch -L <core> <rom>`, which cannot live in the manifest. They are
// validated by native.js's own parser, and the manifest is looked up here rather
// than passed in, so a plugin can only ever launch a program some manifest already
// declares.
function launchNativeFor(id, extraArgs) {
  const m = apps.manifestById(id);
  if (!m || m.status !== "ready" || !(m.runtime && m.runtime.native)) {
    console.warn("[native] no launchable native app:", id);
    return false;
  }
  return openNativeApp(m, extraArgs);
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
// Push the current UI language onto an app's session. Called at launch AND on every
// foreground, because the partition is persistent: a language change while the app sat
// in the background would otherwise leave the server seeing the old header forever.
function applyAppLanguage(id) {
  const m = apps.manifestById(id);
  if (!m || (m.runtime || {}).serve !== "remote") return null;
  const rt = m.runtime || {};
  const wanted = lang.resolve(config.uiLocale(), app.getSystemLocale(), rt.language);
  try {
    const ses = session.fromPartition("persist:remote-" + id);
    ses.setUserAgent(rt.userAgent || ses.getUserAgent(), wanted.accept);
  } catch (e) {
    console.warn("[remote] could not set Accept-Language:", e.message);
  }
  return wanted;
}

function resolveRemoteUrl(m) {
  const rt = m.runtime || {};
  if (rt.urlConfig) return (config.appConfig(rt.urlConfig) || {}).baseUrl || "";
  // A {locale} placeholder in the URL is how a site that keeps its market in the
  // PATH follows the box's language (xbox.com ignores Accept-Language and redirects
  // by IP - measured - so /{locale}/play is the only lever that works there). It is
  // a template, not a pinned market: change the UI language and the next launch
  // follows it.
  const tag = lang.resolve(config.uiLocale(), app.getSystemLocale(), rt.language).tag;
  return lang.expand(rt.url || "", tag);
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
  textinput.dropFor(null); // a session belongs to the app that asked; this isn't it
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
  // Language, both channels: the header here (the server's view) and
  // navigator.language in the preload (the page's view). Set on the session, so
  // subresources and the sign-in popup - which share the partition - agree.
  const wanted = applyAppLanguage(m.id) || { tag: "", accept: "" };
  const ses = session.fromPartition("persist:remote-" + m.id);
  const hosts = allowedRemoteHosts(rt, url);
  // Cookies a manifest asks for (e.g. a site's own locale cookie), with the same
  // {locale} templating as the URL. Restricted to the app's DECLARED origins: a
  // registry manifest must not be able to plant a cookie for an unrelated domain,
  // and the partition is the app's own anyway. Set before the first load, since the
  // point is to influence the first response.
  const cookieJobs = [];
  for (const c of Array.isArray(rt.cookies) ? rt.cookies.slice(0, 8) : []) {
    const cUrl = String((c && c.url) || "");
    let host = "";
    try {
      host = new URL(cUrl).hostname.toLowerCase();
    } catch (e) {
      host = "";
    }
    const allowedHost = host && hosts.some((h) => host === h || host.endsWith("." + h));
    if (!allowedHost || !c.name) {
      console.warn("[remote] cookie skipped (host not in origins):", cUrl, c && c.name);
      continue;
    }
    cookieJobs.push(
      ses.cookies
        .set({
          url: cUrl,
          name: String(c.name),
          value: lang.expand(String(c.value == null ? "" : c.value), wanted.tag),
          domain: c.domain ? String(c.domain) : undefined,
          path: c.path ? String(c.path) : undefined,
          secure: cUrl.startsWith("https:"),
        })
        .catch((e) => console.warn("[remote] cookie failed:", c.name, e.message)),
    );
  }
  const allowed = (u) => {
    try {
      const x = new URL(u);
      const n = x.hostname.toLowerCase();
      return remoteProtoOk(x) && hosts.some((h) => n === h || n.endsWith("." + h));
    } catch (e) {
      return false;
    }
  };
  player.stop();
  setVideoMode(false); // no mpv behind a remote app; drop any prior session
  setForegroundApp(m.id); // identity is per-window (windowAppId); this global only tracks foreground
  // Every remote window gets the sandbox-safe preload now: a capability app needs
  // it for its granted brokers (fetch/storage), and EVERY remote app needs the
  // text-input bridge (a focused field must be able to raise the on-screen
  // keyboard on a TV with no keyboard). The preload only calls contextBridge for
  // an app that declared caps beyond "nav", so a plain site still gets no API
  // surface - just the "a field is focused" signal, which it cannot reach.
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
      preload: path.join(__dirname, "preload-app.js"),
    },
  });
  appwins.register(m.id, w); // capability brokers identify THIS window's app by sender (tvboxAppId)
  const wc = w.webContents;
  wc.on("console-message", (ev) => {
    console.log(
      "[remote:" + (CONSOLE_TAG[ev.level] || "?") + "]",
      redact(ev.message),
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
  // Popups: a sign-in flow needs one. Microsoft's account sign-in (xbox.com ->
  // login.live.com, the PIN/passkey step) is a window.open popup, and denying it
  // meant the button silently did nothing - the flow cannot be completed in-page,
  // because it postMessages back to its opener. So an ALLOWLISTED url gets a real
  // child window with the same hardening and the same session partition (it must
  // share cookies with the app), and anything else is still denied - loudly now.
  const MAX_POPUPS = 2; // a sign-in flow needs one; a loop of window.open() needs none
  wc.setWindowOpenHandler(({ url }) => {
    // Only the app the user is actually looking at may open a window. A background
    // app's page keeps running, and without this it could raise a fullscreen
    // always-on-top window over the launcher - untrusted content owning the screen.
    if (currentAppId !== m.id) {
      console.warn("[remote] blocked popup from a background app:", m.id, url.slice(0, 60));
      return { action: "deny" };
    }
    if (popupsOf(m.id).length >= MAX_POPUPS) {
      console.warn("[remote] popup limit reached for", m.id);
      return { action: "deny" };
    }
    if (!allowed(url)) {
      console.warn("[remote] blocked popup:", url);
      return { action: "deny" };
    }
    console.log("[remote] popup ->", url.slice(0, 80));
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        fullscreen: true, // a 10-foot login screen, not a 400px desktop popup
        frame: false,
        backgroundColor: "#000000",
        autoHideMenuBar: true,
        skipTaskbar: true,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          partition: "persist:remote-" + m.id,
          preload: path.join(__dirname, "preload-app.js"), // the typing bridge: the PIN goes in HERE
        },
      },
    };
  });
  // Guard the child the same way as its opener, and let it be closed like a dialog.
  wc.on("did-create-window", (child, details) => {
    const list = appPopups.get(m.id) || [];
    list.push(child);
    appPopups.set(m.id, list);
    console.log("[remote] popup window for", m.id, String(details.url || "").slice(0, 60));
    const cwc = child.webContents;
    cwc.on("will-navigate", guard);
    cwc.on("will-redirect", guard);
    // One level only: a popup opening its own popup is not part of any sign-in flow
    // we support, and each one is a full-screen window over the app.
    cwc.setWindowOpenHandler(({ url }) => {
      console.warn("[remote] blocked nested popup:", url);
      return { action: "deny" };
    });
    cwc.on("console-message", (ev) => {
      console.log("[popup:" + (CONSOLE_TAG[ev.level] || "?") + "]", redact(ev.message));
    });
    cwc.on("dom-ready", () => {
      cwc.executeJavaScript(NO_WEBAUTHN_JS).catch(() => {}); // the sign-in page lives here
      cwc.executeJavaScript(IDLEHIDE_JS).catch(() => {});
    });
    cwc.on("before-input-event", (e, input) => {
      if (input.type !== "keyDown") return;
      // Home leaves the app entirely; Back closes the popup (it IS the dialog) once
      // the page itself has nowhere left to go.
      if (input.key === "BrowserHome") {
        e.preventDefault();
        showLauncher();
        return;
      }
      // Backspace, not BrowserBack: while an app owns the screen the compositor has
      // already rewritten the remote's Back key, and this popup belongs to an app.
      // Which means a typed Backspace is indistinguishable from the remote's Back -
      // so while a field is focused (this window is a sign-in page, that is most of
      // the time) the key belongs to the field, and only Escape closes the popup.
      if (input.key === "Escape" || (input.key === "Backspace" && !editingPages.has(cwc.id))) {
        // Never let a key handler throw: Back would die with it and the popup would
        // be inescapable.
        let canBack;
        try {
          canBack = !!(cwc.navigationHistory && cwc.navigationHistory.canGoBack());
        } catch (err) {
          canBack = false;
        }
        if (canBack) return; // let the page handle its own history first
        e.preventDefault();
        child.destroy();
      }
    });
    child.on("closed", () => {
      appPopups.set(
        m.id,
        (appPopups.get(m.id) || []).filter((w) => w !== child && !w.isDestroyed()),
      );
      textinput.dropFor(m.id); // a pending typing session belonged to this window
      if (currentAppId === m.id) foregroundApp(m.id); // back to the app underneath
    });
    child.setAlwaysOnTop(true, "screen-saver");
    child.focus();
    child.moveTop();
    // Exactly ONE visible always-on-top toplevel: hide the opener while its popup is
    // up (all our windows share a Wayland app_id, so two mapped windows make focus
    // routing compositor-dependent). It comes back when the popup closes.
    try {
      if (!w.isDestroyed()) w.hide();
    } catch (err) {}
  });
  // WebAuthn is advertised by Chromium but cannot complete here: this Electron has
  // no authenticator UI, so navigator.credentials.get() HANGS - no dialog, no
  // rejection, not even honouring its own timeout (measured on the box:
  // platformAuthenticator=false, get() still pending after 6s). A sign-in page that
  // feature-detects it therefore offers "face / fingerprint / PIN / security key"
  // and then does nothing at all when picked, which is the worst outcome on a TV.
  // So tell the truth: remove the interface so sites fall back to a password (or a
  // device-code flow), and make a direct call reject cleanly instead of spinning
  // forever. Runs on dom-ready, long before any sign-in click.
  const NO_WEBAUTHN_JS =
    "(function(){if(window.__tvnowa)return;window.__tvnowa=1;" +
    "try{delete window.PublicKeyCredential}catch(e){}" +
    "try{var n=function(){var e=new Error('WebAuthn is not available on this device');e.name='NotSupportedError';" +
    "return Promise.reject(e)};if(navigator.credentials){navigator.credentials.get=n;navigator.credentials.create=n}}catch(e){}})();";
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
    wc.executeJavaScript(NO_WEBAUTHN_JS).catch(() => {});
  });
  // Remote Home key (CEC double-tap Back -> BrowserHome) returns to the launcher.
  // The BT remote's Back key needs no translation here any more: the compositor
  // rewrites it while an app owns the screen, so this window already sees the key
  // a remote site (YouTube leanback) knows.
  wc.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "BrowserHome") {
      e.preventDefault();
      showLauncher();
    }
  });
  // If this window goes away for ANY reason while it's still the active app
  // (the site called window.close(), a top-level Back exited it, a crash), the
  // launcher is currently hidden, so recover it instead of dropping to the bare
  // desktop. An intentional return (showLauncher) sets currentAppId=null first,
  // so this is a no-op there; likewise when switching straight to another app.
  const thisAppId = m.id;
  w.on("closed", () => {
    dmode.releaseIfHolder(appClaimId(thisAppId)); // a gone window can't hold the mode
    closePopups(thisAppId); // else a live untrusted renderer outlives its app forever
    leftForeground(thisAppId);
    if (appwins.get(thisAppId) === w) appwins.destroy(thisAppId);
    if (currentAppId === thisAppId) showLauncher();
  });
  w.setAlwaysOnTop(true, "screen-saver");
  // The cookies must be in the jar before the first request, so the load waits for
  // them (they all resolve or log; nothing can reject the chain).
  // Race the cookie writes against a short timer: they exist to influence the FIRST
  // response, but a hanging cookies.set must not leave the box staring at a black
  // always-on-top window.
  Promise.race([Promise.all(cookieJobs), new Promise((r) => setTimeout(r, 1500))]).then(() => {
    if (!w.isDestroyed()) w.loadURL(url, rt.userAgent ? { userAgent: rt.userAgent } : undefined);
  });
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
  textinput.dropFor(null);
  setForegroundApp(m.id);
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
      redact(ev.message),
      ev.sourceId ? "(" + ev.sourceId + ":" + ev.lineNumber + ")" : "",
    );
  });
  // Home is caught main-side here (not only in the renderer) so a hung app can't
  // trap the box - the renderer's own Home handler still works normally. Back needs
  // nothing: the compositor rewrites it while an app owns the screen.
  w.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "BrowserHome") {
      e.preventDefault();
      showLauncher();
    }
  });
  // A crashed/gone renderer doesn't emit "closed", so recover to the launcher
  // explicitly - never leave the box stuck on a dead app window (the launcher
  // is hidden while an app is up).
  w.webContents.on("render-process-gone", () => {
    console.warn("[app:" + m.id + "] render process gone -> launcher");
    const wasForeground = currentAppId === m.id;
    destroyAppWindow(m.id); // drop the dead window so a relaunch starts fresh
    if (wasForeground) showLauncher();
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
    dmode.releaseIfHolder(appClaimId(thisAppId)); // a gone window can't hold the mode
    closePopups(thisAppId); // else a live untrusted renderer outlives its app forever
    leftForeground(thisAppId);
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

// ---- the note that appears over everything ----
// A notification (MQTT, an app, a plugin, the voice satellite's answer) has to be
// visible while an app is fullscreen, and the launcher's window is not: it is
// BEHIND that app. Raising the launcher would show the note and cover the app,
// which is the opposite of what a note is for.
//
// So the note gets a window of its own, and the compositor is told two things about
// it (tvbox-wc >= 0.1.7): the title `tvbox-overlay` puts it in front of everything
// including the rest of the shell, and a placement keeps it SMALL. Small matters -
// every surface here is a scan-out candidate, so a strip at the bottom can take a
// hardware plane, while a fullscreen translucent one over a 4K film is the
// composited pass the whole compositor exists to avoid.
const OVERLAY_TITLE = "tvbox-overlay";
// How much of the screen the strip takes. Enough for two lines at the box's own
// text size, and no more: what is not covered stays the film's.
const OVERLAY_HEIGHT_FRACTION = 0.28;
let overlayWin = null;
let overlayHideTimer = null;
// Whether this box's compositor understands a placement by title. A box on an
// older one would map the note FULLSCREEN - a translucent surface over the whole
// film, which is exactly the cost this design exists to avoid - so the note stays
// in the launcher there instead. null until asked.
let overlayPlaceable = null;

function overlayRect() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const h = Math.max(160, Math.round(height * OVERLAY_HEIGHT_FRACTION));
  return { x: 0, y: Math.max(0, height - h), w: width, h };
}

// Ask for the strip once, and remember the answer. Placed BEFORE the window maps:
// a window is positioned as it appears, so asking afterwards would show it
// fullscreen for a frame first.
function claimOverlayPlacement(done) {
  if (overlayPlaceable !== null) return done(overlayPlaceable);
  if (!compositor.available()) {
    overlayPlaceable = false;
    return done(false);
  }
  compositor.placeWindowByTitle(OVERLAY_TITLE, overlayRect(), (ok, err) => {
    overlayPlaceable = !!ok;
    if (!ok) console.warn("[notify] no overlay window (compositor: " + (err || "refused") + ")");
    done(overlayPlaceable);
  });
}

function ensureOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const rect = overlayRect();
  overlayWin = new BrowserWindow({
    width: rect.w,
    height: rect.h,
    x: rect.x,
    y: rect.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    // Never takes the remote: the compositor keeps key events away from this
    // window as well, but a focusable window would still steal them from the app
    // on any box running an older compositor.
    focusable: false,
    skipTaskbar: true,
    title: OVERLAY_TITLE,
    webPreferences: {
      preload: path.join(__dirname, "overlay", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // a note must draw at once, not at the next tick
    },
  });
  overlayWin.setIgnoreMouseEvents(true);
  // Electron sets the Wayland title from the window title, and a page's <title>
  // would otherwise win: set it again after load so the compositor's rule holds.
  overlayWin.on("page-title-updated", (e) => e.preventDefault());
  // The page sizes its text against the SCREEN, not against this strip: a strip is
  // a fraction of the screen, so a size expressed in the window's own units comes
  // out a fraction of a fraction - the first attempt drew a four-pixel letter.
  overlayWin.loadFile(path.join(__dirname, "overlay", "toast.html"), {
    query: { sh: String(screen.getPrimaryDisplay().size.height) },
  });
  overlayWin.on("closed", () => {
    overlayWin = null;
  });
  // A renderer that died or never loaded is a window that will never show a note
  // again, and one that may be sitting on screen while it fails. Drop it: the next
  // note builds a fresh one, which is the whole cost of recovering here.
  const scrap = (why) => {
    console.warn("[notify] overlay renderer gone (" + why + ") - it will be rebuilt");
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
    const dying = overlayWin;
    overlayWin = null;
    try {
      if (dying && !dying.isDestroyed()) dying.destroy();
    } catch (e) {}
  };
  overlayWin.webContents.on("render-process-gone", (_e, details) => scrap((details && details.reason) || "crashed"));
  overlayWin.webContents.on("did-fail-load", (_e, code, description) => scrap(description || String(code)));
  return overlayWin;
}

function hideOverlay() {
  clearTimeout(overlayHideTimer);
  overlayHideTimer = null;
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) overlayWin.hide();
}

// A notification arrived (MQTT `notify`, POST /tvbox/api/notify, host.notify).
// Draw it in the overlay window so it is seen over whatever is running; `raise`
// still brings the launcher forward, for the notes that are meant to interrupt.
function handleTvNotify(payload) {
  const note = payload || {};
  // A note with no text of its own is one the LAUNCHER writes: `{kind:"lowBattery"}`
  // carries a name and a percentage, and the sentence around them is a localized
  // string that lives there, not here. Drawing it in the overlay would put an empty
  // dark bar over the film - worse than the note staying where it can be read.
  const hasText = !!(String(note.message || "").trim() || String(note.title || "").trim());
  // The launcher draws it only when the strip will not: a compositor that cannot
  // place the strip, or a note the launcher itself writes. Both at once would be
  // two notes on one screen.
  const toLauncher = () => {
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send("tv-notify", note);
      } catch (e) {}
    }
  };
  claimOverlayPlacement((placeable) => {
    if (!placeable || !hasText) return toLauncher();
    try {
      const w = ensureOverlayWindow();
      const show = () => {
        // Re-assert the title, and force it to CHANGE so it is actually sent.
        // Hiding a window tears its xdg_toplevel down; showing it builds a new one,
        // and Chromium does not repeat a title it believes is unchanged - so the
        // second note of a session arrived on a nameless window, which the
        // compositor rightly treated as an ordinary one. Measured: the note then
        // sat in front of the app AND took the remote from it.
        w.setTitle(OVERLAY_TITLE + " ");
        w.setTitle(OVERLAY_TITLE);
        w.showInactive(); // never takes focus, even for a moment
        w.webContents.send("overlay-note", note);
        clearTimeout(overlayHideTimer);
        // A backstop only: the renderer says when it has finished fading out.
        // Without it a renderer that died mid-note would leave a surface on screen.
        const ms = Math.max(1500, Math.min(60000, Number(note.duration) || 6000));
        overlayHideTimer = setTimeout(hideOverlay, ms + 2000);
      };
      if (w.webContents.isLoading()) w.webContents.once("did-finish-load", show);
      else show();
    } catch (e) {
      console.warn("[notify] overlay:", e.message);
    }
  });
  if (note.raise) raiseWindow();
}

// TV power over CEC. The CEC bridge (tvbox-cec user service) owns the adapter
// and its cec-client stdin, so we can't open a second cec-client; instead we
// drop a whitelisted command ("on 0" / "standby 0") into a FIFO the bridge
// forwards to cec-client. O_NONBLOCK so we never hang if the bridge isn't running.
const CEC_CMD_FIFO = "/tmp/tvbox-cec-cmd";
function cecPower(on) {
  if (fifoCmd(CEC_CMD_FIFO, on ? "on 0" : "standby 0", "cec")) console.log("[cec] power", on ? "on" : "off");
}
// FIFOs we've already complained about, so a bridge that simply isn't there (a box
// with no CEC is normal) doesn't fill the log: bridgesCmd runs on a timer for the
// whole of a native-app session. Cleared by the next successful write.
const fifoQuiet = new Set();
// Write a control line to a bridge FIFO. O_NONBLOCK so a bridge that isn't
// running can never hang the shell.
function fifoCmd(fifo, cmd, tag) {
  let fd = null;
  try {
    fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, cmd + "\n");
    fifoQuiet.delete(fifo);
    return true;
  } catch (e) {
    if (!fifoQuiet.has(fifo)) {
      fifoQuiet.add(fifo);
      console.warn("[" + tag + "] cmd failed (bridge running?):", e.message);
    }
    return false;
  } finally {
    // A throwing writeSync would otherwise leak the descriptor, once per attempt.
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {}
    }
  }
}
// Tell BOTH uinput bridges the same thing. Used for "native on"/"native off":
// while a native app owns the screen it also owns keyboard focus, so the Home
// button can't reach any renderer of ours. Each bridge then posts Home to
// /tvbox/api/nav instead of emitting a key, which is the only escape hatch a
// native app has (rule 7: never a dead end on a keyboardless TV). Both bridges
// need it because Home arrives from either one: CEC synthesizes it from a
// double-tap of Back, a BT/USB remote sends it directly.
function bridgesCmd(cmd) {
  fifoCmd(CEC_CMD_FIFO, cmd, "cec");
  fifoCmd(REMOTE_CMD_FIFO, cmd, "remote");
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
  fifoCmd(REMOTE_CMD_FIFO, cmd, "remote");
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

// ---- the box as one media player (Home Assistant) ----
//
// Everything outside the box that wants to know "what is this TV doing" asks one
// question, so there is one answer: a retained `state` topic composed from mpv,
// the foreground app's now-playing report and the audio sink (mediastate.js owns
// the merge rules). The nowplaying topic keeps its old shape beside it - the voice
// assistant reads that one - so nothing that already works has to change.
//
// Every command the box answers, in one list, because it is also what the box
// ADVERTISES: Home Assistant turns it into the entity's supported_features, so an
// older box never shows a button that does nothing.
const TV_COMMANDS = [
  "launch",
  "home",
  "play",
  "pause",
  "stop",
  "next",
  "previous",
  "seek",
  "volume_set",
  "volume_mute",
  "volume_up",
  "volume_down",
  "mute",
  "tv_on",
  "tv_off",
];
let sinkState = { volume: null, muted: false };
let lastMediaState = null;
let mediaPublishTimer = null;
let mediaPublishForced = false;

// Coalesced: mpv reports a position every second and an app can push now-playing in
// bursts, so publishes are batched to the next tick and then filtered by
// worthPublishing (a position that moved less than a few seconds is not news).
function publishMediaState(opts) {
  if (!mqttCtl) return;
  // A forced call that lands inside an already-queued window must not lose its
  // force: re-seeding a fresh broker (applyMqttConfig) is exactly a forced publish,
  // and lastMediaState still holds the previous broker's value, so being folded into
  // a filtered publish would leave the new broker with no retained state at all.
  if (opts && opts.force) mediaPublishForced = true;
  if (mediaPublishTimer) return;
  mediaPublishTimer = setTimeout(() => {
    mediaPublishTimer = null;
    const forced = mediaPublishForced;
    mediaPublishForced = false;
    if (!mqttCtl) return;
    const next = mediastate.compose({
      nowPlaying,
      mpv: player.media,
      volume: sinkState.volume,
      muted: sinkState.muted,
      currentApp: currentAppId,
      sources: mediaSources(),
    });
    if (!forced && !mediastate.worthPublishing(lastMediaState, next)) return;
    lastMediaState = next;
    mqttCtl.publish("state", next, { retain: true });
  }, 200);
}

// The apps a media_player can be switched TO: exactly what HOME would open
// (appLaunchable), so the source list never offers a tile the box would refuse -
// an app mid-install, missing a dep, or a remote app with no URL set yet.
// Bounded, because this goes into a retained payload and then into a Home
// Assistant state attribute.
const MAX_MEDIA_SOURCES = 64;
function mediaSources() {
  return apps
    .getManifests()
    .filter(appLaunchable)
    .map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.name && (m.name.en || m.name.hu) }))
    .filter((s) => s.name)
    .slice(0, MAX_MEDIA_SOURCES);
}

// Which app is in front changes through half a dozen paths (launch, resume,
// native app, HOME, the typing screen), so the state topic is re-composed on a
// slow tick instead of at every one of them: composing is pure and in-memory, and
// worthPublishing drops the result when nothing moved. Media events themselves
// don't wait for this - they publish immediately.
const MEDIA_TICK_MS = 5000;
const SINK_TICK_MS = 20000; // wpctl is a process spawn; the volume is not urgent
// Nothing in the fleet payload changes by the second (a version, a link rate, a
// temperature), and it costs three spawns, so it is published slowly. The topic is
// retained, so a subscriber never waits for the next one.
const DIAG_TICK_MS = 5 * 60 * 1000;

// The sink's volume/mute, refreshed on a timer rather than per publish: wpctl is a
// process spawn, and nothing else on the box changes the volume between ticks
// without going through us.
// The box's own output volume, set from outside (MQTT / Home Assistant). Targets
// the DEFAULT sink, because that is what "the box's volume" means; the caller
// never has to know a wireplumber node id. `volume` is 0..1.
function setBoxVolume(action, cmd) {
  const env = { ...process.env, ...WL_ENV };
  audio.defaultSink(env, (sink) => {
    if (!sink) return console.warn("[mqtt]", action, "- no audio sink");
    const done = (ok) => {
      if (!ok) console.warn("[mqtt]", action, "failed on sink", sink.id);
      refreshSinkState(); // report what it actually became, not what was asked for
    };
    if (action === "volume_set") audio.setVolume(env, sink.id, Number(cmd && cmd.volume), done);
    else audio.setMuted(env, sink.id, cmd && cmd.mute !== undefined ? !!cmd.mute : "toggle", done);
  });
}

function refreshSinkState() {
  // Only while something is listening. listSinks is `wpctl status` plus two more
  // spawns per sink, and a box that never touches Home Assistant has no reason to
  // pay three processes a minute forever - least of all during a film or a game.
  if (!mqttCtl) return;
  audio.defaultSink({ ...process.env, ...WL_ENV }, (sink) => {
    const next = {
      volume: sink && typeof sink.volume === "number" ? sink.volume : null,
      muted: !!(sink && sink.muted),
    };
    if (next.volume === sinkState.volume && next.muted === sinkState.muted) return;
    sinkState = next;
    publishMediaState();
  });
}

// What this box looks like to whoever is watching all of them (docs/fleet-view.md).
// Retained, so a dashboard that subscribes tomorrow still sees last night's
// rollback; and only while MQTT is configured, for the same reason refreshSinkState
// is gated - it spawns nmcli and gdbus, which a box nobody watches should not pay.
function publishDiag() {
  if (!mqttCtl) return;
  // Guarded on both sides of the asynchronous hop: this catch only ever sees a
  // synchronous failure, because collect answers through execFile callbacks, and an
  // exception raised there would reach the Electron main process rather than here.
  try {
    diag.collect({ system, updater }, (payload) => {
      try {
        if (mqttCtl) mqttCtl.publish("diag", payload, { retain: true });
      } catch (e) {
        console.warn("[diag] publish:", e.message);
      }
    });
  } catch (e) {
    console.warn("[diag] collect:", e.message);
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
  if (mqttCtl) {
    mqttCtl.announce({
      name: identity.hostname(),
      hostname: identity.hostname(),
      version: pkg.version || "",
      // The command vocabulary the box answers. Home Assistant turns it into the
      // entity's supported_features, so a box on an older release doesn't advertise
      // a button that does nothing.
      commands: TV_COMMANDS,
    });
    // Read the volume now rather than waiting out the 20 s tick: MQTT may have been
    // configured minutes after boot, and a media_player whose slider starts blank
    // reads as broken.
    refreshSinkState();
    publishMediaState({ force: true });
    publishDiag(); // the fleet payload, now rather than at the first tick
  }
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
      player.cmd({ command: ["set_property", "pause", true] });
      forwardCommand(cmd);
      break;
    case "play":
    case "resume":
      player.cmd({ command: ["set_property", "pause", false] });
      forwardCommand(cmd);
      break;
    case "stop":
      player.setPlaying(null);
      player.stop();
      setVideoMode(false);
      // With a reason, because this is a stop and not the end of the item: an app
      // that auto-advances on `finished` (Plex on-deck) would otherwise start the
      // next episode for someone who just pressed stop on their phone.
      player.emit({ type: "finished", reason: "stopped" });
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
    // The box's OWN output volume, deliberately separate from the three above:
    // those drive the TV's amplifier over IR and have no absolute value to set,
    // this is the sink the box plays through. A media_player entity's volume
    // slider means this one.
    case "volume_set":
    case "volume_mute":
      setBoxVolume(action, cmd);
      break;
    case "seek": {
      // Absolute, in seconds - only meaningful while WE hold the clock (mpv);
      // an app playing its own audio has no position for us to move. A non-numeric
      // position would reach mpv as JSON `null` (NaN does not survive stringify),
      // so it is rejected here rather than sent. A real number, not a coercion:
      // Number(null) and Number("") are both 0, i.e. a silent seek to the start.
      const pos = cmd && typeof cmd.position === "number" ? cmd.position : NaN;
      if (player.media.active && Number.isFinite(pos) && pos >= 0) player.cmd({ command: ["seek", pos, "absolute"] });
      else if (!Number.isFinite(pos)) console.warn("[mqtt] seek: bad position", cmd && cmd.position);
      break;
    }
    default:
      console.warn("[mqtt] unknown command:", action);
  }
}

ipcMain.on("plog", (_e, p, a) => console.log("[plog]", p, redact(a))); // debug: raw player.* calls from an app
// The note has finished fading out. Hiding it is the shell's job, not the page's:
// a window it cannot hide is a surface the compositor still has to deal with.
ipcMain.on("overlay-done", (e) => {
  if (overlayWin && !overlayWin.isDestroyed() && e.sender === overlayWin.webContents) hideOverlay();
});

// Which window a webContents belongs to: null = the launcher window, an app id
// = that app's own window, undefined = unknown/stale sender (no identity, no
// caps). Every identity/capability decision keys off THIS, never the global
// foreground id - a hidden app keeps ITS OWN identity, so a background call is
// scoped to its own caps/origins/storage (no confused deputy).
// Sign-in popups a remote app opened (window.open), per app id. They are NOT app
// windows - the app keeps exactly one - but they share its identity, session and
// visibility: an OAuth popup is the same app to every broker, hides and comes back
// with it, and dies with it.
const appPopups = new Map(); // appId -> BrowserWindow[]
function popupsOf(id) {
  const list = appPopups.get(id) || [];
  const live = list.filter((w) => w && !w.isDestroyed());
  if (live.length) appPopups.set(id, live);
  else appPopups.delete(id);
  return live;
}
function hidePopups(id) {
  for (const w of popupsOf(id))
    try {
      w.webContents.setAudioMuted(true); // hidden means silent, same as an app window
      w.hide();
    } catch (e) {}
}
function closePopups(id) {
  for (const w of popupsOf(id))
    try {
      w.destroy();
    } catch (e) {}
  appPopups.delete(id);
}

function windowAppId(sender) {
  if (win && !win.isDestroyed() && sender === win.webContents) return null;
  for (const [, w] of appwins.all()) if (sender === w.webContents) return w.tvboxAppId;
  return undefined;
}

// Which app a POPUP belongs to. Deliberately separate from windowAppId: that one feeds
// capsFor / the capability brokers, and a sign-in popup is a THIRD-PARTY origin
// (login.live.com) inside the app's partition - it must not inherit the app's
// fetch/storage brokers just because its opener declared them. The typing bridge is
// the only thing that needs this, and it grants nothing.
function popupAppId(sender) {
  for (const [id] of appPopups) for (const w of popupsOf(id)) if (sender === w.webContents) return id;
  return undefined;
}

// Where the app's declared bridge adapter really lives, or null. A bridge always
// ships INSIDE its app package ("./file.js" next to the manifest): the thing it
// adapts is one client's host API, so it belongs to that client and updates from
// the registry with it. The shell has no bridge of its own. Resolved here rather
// than in the preload because this is the side that knows where a package is
// installed, and the value reaches require(): it is pinned to the package dir,
// no subdirectories and no traversal, and a manifest-only app (no dir of its
// own) simply cannot have one.
function bridgePath(m) {
  const name = (m && m.runtime && m.runtime.bridge) || null;
  if (!name || !m._dir || !/^\.\/[a-z0-9_-]+\.js$/.test(name)) return null;
  const file = path.join(m._dir, name.slice(2));
  return path.dirname(file) === path.resolve(m._dir) && fs.existsSync(file) ? file : null;
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
  const rt = (m && m.runtime) || {};
  e.returnValue = {
    id,
    capabilities: capsFor(id),
    bridge: rt.bridge || null,
    bridgeFile: bridgePath(m),
    // The language the page should believe it is running in - the preload overrides
    // navigator.language(s) with it before the page's own scripts read them.
    language: lang.resolve(config.uiLocale(), app.getSystemLocale(), rt.language).tag,
    // "off" for an app that has its own on-screen keyboard (YouTube's leanback UI):
    // replacing a working keyboard with ours would be a downgrade.
    textInput: rt.textInput === "off" ? "off" : "auto",
    // What the panel can show, which is not what the window system will say while
    // the UI is at 1080p on a 4K set. An app that picks a stream from the screen
    // size needs the panel's answer; what it does with it is the app's business.
    panel: panelResolution,
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
    if (player.running() && currentAppId !== m.id) {
      player.setPlaying(null);
      player.stop();
      setVideoMode(false);
      // Leaving an app mid-film stops it; it did not finish. Without the reason the
      // app it belonged to advances to the next item in the background.
      player.emit({ type: "finished", reason: "stopped" });
    }
    // Leaving a native app for another app ends its process: it has no background
    // state to keep, and letting it live would leave it holding the GPU and audio
    // under whatever we bring forward. Its OWN app is no exception - navigating to
    // the UI a game was launched from means leaving the game, and the two must
    // never be on screen together (exactly one visible toplevel).
    if (nativeapp.running()) {
      nativeForeground = false;
      nativeHostApp = null;
      nativeapp.stop();
    }
  };
  if (appWindow(m.id)) {
    // already running in the background -> instant resume of its live window
    stopPrevPlayback();
    foregroundApp(m.id);
    return;
  }
  if (m.type === "native") {
    // Its own fullscreen Wayland client, not a page. stopPrevPlayback is folded
    // into openNativeApp: it stops the shared player before handing over the screen.
    openNativeApp(m);
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

// The app asked to be torn down - a Plex-HTPC-style "Exit?" dialog confirming over
// QWebChannel, not the user pressing Home. Backgrounding is wrong for this: the app
// would stay in the switcher and re-entering it would land straight back on its own
// exit dialog. So destroy the window; a later launch starts the app fresh.
// Launcher FIRST, then destroy - same order as the uninstall/remove paths above.
// The reverse leaves a gap with no visible window (bare desktop, or a fullscreen
// mpv the app was revealing), because it is showLauncher that stops playback and
// hides the app. It also nulls currentAppId, so the window's own "closed" handler
// can't fire a second launcher.
function exitApp(id) {
  if (!id) return;
  // A native app has no window to destroy: showLauncher stops its process, which
  // IS the quit. Nothing of it survives in the background either way.
  if (nativeapp.id() === id) {
    console.log("[nav] exit", id, "(native)");
    showLauncher();
    return;
  }
  if (!appWindow(id)) return;
  console.log("[nav] exit", id);
  if (currentAppId === id) showLauncher();
  destroyAppWindow(id);
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
// The typing screen's own surface. Deliberately IPC and not an HTTP route: every
// local app bundle is served from the shell's origin, so a same-origin route would
// let ANY local app read the live pairing code and inject keystrokes into whatever
// the foreground app has focused. windowAppId(sender) === null is the launcher, and
// only the launcher owns this screen. (The phone path doesn't come through here at
// all - the pairing provider calls textinput directly, behind its code gate.)
ipcMain.handle("textinput", (e, action, payload) => {
  if (windowAppId(e.sender) !== null) return { ok: false, error: "launcher only" };
  if (action === "status") {
    const st = textinput.status();
    if (st.active) {
      // WHO is asking, from the manifest - the field's own label is page-authored
      // text and must never pass for the shell's own prompt (a page could label a
      // field "Parental PIN" and let our keyboard collect it).
      const m = apps.manifestById(st.app);
      st.appName = (m && typeof m.name === "string" && m.name) || st.app;
    }
    return st;
  }
  if (action === "submit") return textinput.submit((payload || {}).text);
  if (action === "cancel") return textinput.cancel();
  if (action === "phone") return textinput.startPhone(); // user asked for the QR
  return { ok: false, error: "unknown textinput action" };
});

// A field took focus in a remote app. Only the FOREGROUND app may raise the typing
// screen - a background page moving its own focus must not take over the TV.
// Which pages have a text field focused right now. Only one thing reads it, and it
// is not the typing screen: the remote's Back key reaches a page as a Backspace
// (the compositor rewrites it while an app owns the screen), so a page that is
// editing must not have that read as "go back".
const editingPages = new Set();
ipcMain.on("kbd:focus", (e, field) => {
  editingPages.add(e.sender.id);
  const id = windowAppId(e.sender) || popupAppId(e.sender);
  if (!id || id !== currentAppId) return;
  textinput.focused(id, e.sender, field || {});
});
ipcMain.on("kbd:blur", (e) => editingPages.delete(e.sender.id));

ipcMain.on("nav", (e, dest) => {
  // "exit" is app-initiated teardown, so it targets the SENDER's app rather than
  // whatever is foreground - a background app's exit must not close the visible one.
  if (dest === "exit") return exitApp(windowAppId(e.sender));
  navTo(dest);
});

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

// ---- capability: adaptive display mode ----
// "I am about to show video this size at this framerate" - the shell switches the
// output to a mode that suits it and puts the UI mode back on release. For apps
// that play video THEMSELVES (a <video> element, their own player) rather than
// through the shell's mpv, which handles its own claim.
// Same foreground-only rule as `player`: a backgrounded app must never own the
// screen's mode, and the claim is keyed to the sender's app so it can only ever
// release its own. Leaving the app (background/close/Home) releases it too.
ipcMain.handle("display", (e, action, payload) => {
  const senderId = windowAppId(e.sender);
  if (senderId === undefined || senderId !== currentAppId || !capsFor(senderId).includes("display")) {
    return { ok: false, error: "display not permitted (not the foreground app)" };
  }
  const id = appClaimId(senderId);
  if (action === "release") return new Promise((resolve) => dmode.release(id, resolve));
  if (action === "claim") {
    // One claim in flight per app. Without this a page looping claimForVideo()
    // queues thousands of them, and each mode switch blanks the TV - the arbiter
    // caps the switches, but the app shouldn't get to queue them either.
    if (displayClaiming.has(id)) return { ok: false, error: "claim already in flight" };
    displayClaiming.add(id);
    const c = payload || {};
    const content = { width: Number(c.width) || 0, height: Number(c.height) || 0, fps: Number(c.fps) || 0 };
    return new Promise((resolve) =>
      dmode.claim(id, content, (r) => {
        displayClaiming.delete(id);
        resolve(r);
      }),
    );
  }
  return { ok: false, error: "unknown display action" };
});

ipcMain.handle("player", (e, action, payload) => {
  // Only the FOREGROUND window may drive the shared mpv, and only if its app
  // holds the player capability. A backgrounded app must never start/seek
  // playback - it would play behind an opaque foreground (invisible video +
  // phantom audio) and keep the box from reporting idle. IPC is async, so a
  // just-backgrounded app's late play() call arrives here after currentAppId
  // already moved on, and is rejected.
  const senderId = windowAppId(e.sender);
  if (senderId === undefined || senderId !== currentAppId || !capsFor(senderId).includes("player")) {
    return { ok: false, error: "player not permitted (not the foreground app)" };
  }
  payload = payload || {};
  // Where it plays FROM, never the URL. A slice of one looked safe because a Plex
  // token sits late in the query string, but an IPTV URL carries its username and
  // password as PATH segments - right after the host, inside any slice - and this
  // log is what `tvbox-diag --logs` copies onto the boot partition, which any
  // laptop can read. The origin is what a diagnosis actually needs.
  console.log("[player] action", action, payload && payload.url ? httpserver.originOf(payload.url) : "");
  if (action === "queue") {
    queued.url = payload.url;
    queued.startPos = payload.startPos || 0;
    queued.streams = payload.streams || null;
  } else if (action === "play") {
    // remember whose window the video belongs to: the first-frame reveal
    // (setVideoMode(true) in observeMpv) must hit THAT window, not the launcher
    player.setOwner(appIdForSender(e.sender));
    if (player.running() && player.playing() === queued.url && !player.isPip()) {
      if (player.startPending()) {
        // Still in the paused-start handshake: the mode switch starts it in a
        // moment. Unpausing here would put the switch INSIDE playback.
        console.log("[player] play during the start handshake - letting it finish");
      } else {
        console.log("[player] resume (already loaded)");
        player.cmd({ command: ["set_property", "pause", false] });
      }
    } else if (queued.url) {
      player.setPlaying(queued.url);
      setVideoMode(false);
      ensureAudio(() => player.launch(queued.url, queued.startPos, false, null, queued.streams));
    } // fullscreen (also un-PiPs)
  } else if (action === "pause") player.cmd({ command: ["set_property", "pause", true] });
  else if (action === "resume") player.cmd({ command: ["set_property", "pause", false] });
  else if (action === "stop") {
    player.setPlaying(null);
    player.stop();
    setVideoMode(false);
  } else if (action === "seek") player.cmd({ command: ["seek", payload.posSec || 0, "absolute"] });
  else if (action === "tracks") {
    // audio/subtitle tracks of the playing stream, for an in-playback picker
    return player.query(["get_property", "track-list"]).then((list) => ({
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
    if (typeof v === "string" || Number.isFinite(v)) player.cmd({ command: ["set_property", prop, v] });
  } else if (action === "select") {
    // Mid-playback version of the queue's `streams`, in the SAME ordinal terms
    // (`track` above speaks mpv track ids, which an app that never saw the track
    // list can't produce). Remembered as well as applied: going to PiP and back
    // RELAUNCHES mpv from `queued.streams`, so a selection only sent to the live
    // player would be quietly undone by the next toggle. Merged per axis - a
    // call that changes only the subtitle must not clear the audio choice.
    for (const command of playeropts.streamCommands(payload)) player.cmd({ command });
    queued.streams = playeropts.mergeStreams(queued.streams, payload);
  } else if (action === "prop") {
    // One allowlisted playback property (subtitle/audio sync, speed, volume,
    // subtitle look). A refusal is reported, not swallowed: an app that gets
    // "ok" for a setting that never landed has no way to notice.
    const v = playeropts.propValue(payload.name, payload.value);
    if (v === null) return { ok: false, error: "property not allowed or value out of range" };
    player.cmd({ command: ["set_property", payload.name, v] });
  } else if (action === "pip") {
    // Toggle the current channel between a PiP (at the launcher-measured rect) and
    // fullscreen. PiP needs the window transparent (so mpv behind shows through the
    // hole); fullscreen starts opaque and observeMpv reveals on the first frame.
    if (player.playing()) {
      setVideoMode(!!payload.on);
      ensureAudio(() => player.launch(player.playing(), 0, !!payload.on, payload.rect, queued.streams));
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
  json: httpserver.jsonRes, // (res, obj) -> JSON response
  log: (...a) => console.log("[plugin]", ...a),
  childEnv: () => ({ ...process.env, ...WL_ENV }), // spawn env with the session's Wayland vars
  // Is the box free? The very predicate every background job in here waits for
  // (boxFree: nothing on screen or audible, no install, no maintenance of the
  // shell's own), so a plugin's background work waits for the same moment the shell
  // considers free instead of inventing its own test from process lists.
  idle: boxFree,
  audioSink: () => audioSink, // detected HDMI sink node.name (set by ensureAudio)
  showLauncher, // (hash) -> stop other playback + bring launcher forward
  navTo, // (id) -> open an app by id (e.g. a plugin foregrounds its app on a cast)
  // One note on screen, for anyone on the box: the same toast MQTT pushes and the
  // voice satellite uses for a spoken answer's text. A plugin gets it here; a
  // local app's page can POST /tvbox/api/notify, which is the same door.
  notify: (n) =>
    handleTvNotify({
      title: String((n && n.title) || "").slice(0, 120),
      message: String((n && n.message) || "").slice(0, 400),
      duration: Math.max(0, Math.min(60000, Number(n && n.duration) || 0)),
      raise: !!(n && n.raise),
    }),
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
  // Start an app's own native program with per-launch arguments (RetroArch: a core
  // and a ROM). Takes the app id, not a command line: the program still comes from
  // the manifest the shell validated, and the arguments go through native.js's
  // parser. Returns whether it launched, so a UI can say why nothing happened.
  launchNative: (id, extraArgs) => launchNativeFor(id, extraArgs),
  // Is that program running right now, and whose? A UI that launches games needs to
  // know its own state after a reload (its window is hidden while the game runs).
  nativeRunning: () => (nativeapp.running() ? nativeapp.id() : null),
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
  fileserver.stop(null); // the symlinked view of the box's folders is not left behind
}

// Two shells must never run at once. The second one loses the race for Chromium's
// storage lock and silently falls back to an IN-MEMORY localStorage - the launcher
// then reads no setup flag on a fully configured box, offers onboarding, and cannot
// save the answer either, so the box asks again every start. The overlap is normally
// momentary (a predecessor still shutting down), so this WAITS for the lock instead
// of refusing to start; run-shell.sh does the same wait before it counts an OTA boot
// attempt, which is why standing down here is rare enough to just exit.
// Asked exactly once, which is the only supported use: a failed call also notifies
// the holder (that is how it gets `second-instance`), so retrying would both be
// off-label and spam the running shell. Waiting for a predecessor to finish is
// run-shell.sh's job, before it counts an OTA boot attempt; this is the last-resort
// guard for losing the race anyway, and the respawn loop retries in a second.
const EXIT_ALREADY_RUNNING = 79;
// A stray second start (a remapped remote button, a manual launch) should do
// something sane rather than nothing at all.
app.on("second-instance", () => raiseWindow());

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    console.warn("[shell] another shell already holds the storage lock - standing down");
    return app.exit(EXIT_ALREADY_RUNNING);
  }
  try {
    execFile("pkill", ["-9", "-f", "tvbox-mpv.sock"], () => {});
  } catch (e) {} // reap orphan mpv from a previous run
  apps.loadManifests();
  // Core pairing kinds (box features). App-specific kinds (iptv, spotify,
  // keyboard) are registered by their package plugin's factory via
  // host.pairing.register - they ship in the app package, not the shell.
  pairing.register("photos", require("./pairing/photos"));
  pairing.register("photoshare", require("./pairing/photoshare"));
  pairing.register("backup", backupPairing);
  pairing.register("text", require("./pairing/text"));
  // Whatever a previous session was showing outlived the TV being switched off.
  // The viewer empties this when it closes; boot is what covers everything else.
  photoshare.sweep();
  // Adding a share is the one form here where every field is somebody else's
  // string - an address, a share name, a password - so it gets a phone page too.
  const sharesPairing = require("./pairing/shares");
  sharesPairing.init({ apply: applyShares, deps: () => sharesDeps });
  pairing.register("shares", sharesPairing);
  // Typing for a keyboard-less app. The screen belongs to the launcher (it owns the
  // on-screen keyboard and can draw a QR), so the app is backgrounded for the
  // duration - its page keeps its state AND the focused field, and the text is sent
  // as keystrokes once it's back in front.
  textinput.init({
    onShow: (st) => {
      const id = st.app;
      if (!id || !win || win.isDestroyed()) return;
      // hideForTyping, NOT backgroundApp: with config.apps.background=false the latter
      // DESTROYS the window (the documented rollback lever), which would kill the page
      // we are about to type into - and the session with it.
      hideForTyping(id);
      setForegroundApp(null); // the launcher is the foreground surface while typing
      win.show();
      try {
        win.webContents.send("tvbox-nav", { dest: "typing" });
      } catch (e) {}
      raiseWindow();
    },
    onDone: (appId) => {
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send("tvbox-nav", { dest: "home" }); // drop the typing view
        } catch (e) {}
      }
      setForegroundApp(appId);
      if (unhideForTyping(appId)) {
        appwins.touch(appId);
        for (const p of popupsOf(appId)) {
          try {
            p.webContents.setAudioMuted(false);
            p.show();
            p.focus();
            p.moveTop();
          } catch (e) {}
        }
        if (win && !win.isDestroyed()) win.hide(); // exactly one visible toplevel again
      } else {
        setForegroundApp(null);
        showLauncher(); // the app window died while we were typing
      }
    },
    pairingStart: () => {
      const r = pairing.start(config.uiLocale().startsWith("hu") ? "hu" : "en", "text");
      return { url: r.url, code: r.code };
    },
    pairingStop: () => pairing.stop(),
    isForeground: (id) => currentAppId === id,
    // The compositor types into whatever holds the keyboard, which by now is the
    // app window this session belongs to - onDone put it back in front.
    typeText: (text) => compositor.typeText(text, { selectAll: true }),
  });
  // A restore replaced config.json + user apps - plugins only read credentials
  // at boot, so restart the shell shortly after (the phone page + TV UI get a
  // few seconds to show "restored").
  // A restore may carry a name for this box (the "second box" flow gives it its
  // own identity, derived from the name). hostnamectl lives here because it needs
  // the polkit grant provision installs.
  backupPairing.onHostname(
    (name) =>
      new Promise((resolve, reject) =>
        system.setHostname(name, (r) => (r.ok ? resolve(r) : reject(new Error(r.error || "rename refused")))),
      ),
  );
  backupPairing.onRestored(() => {
    restoredAt = Date.now();
    setTimeout(() => restartShell("backup restored"), 4000);
  });
  // boxFree, not boxIdle: the OTA auto-apply must never restart the shell under a
  // half-finished app provision (store.install has already swapped the manifest by
  // then, so the nightly would never retry) - and its 03-06h window is the same one
  // the nightly app auto-update runs in, whose download the `installing` set does
  // not cover.
  updater.init({ isIdle: boxFree, restart: () => restartShell("update applied") });
  loadPlugins(); // require plugins + register their routes (deps-gated)
  apps.installAll((s) => console.log("[install]", s));
  serve();
  // The radio is a stored choice, and nmcli's state survives a reboot - but a box
  // that came back with it on because something else re-enabled it should still
  // honour what the owner asked for. Only ever ENFORCES off, and only with a wired
  // carrier: a box whose ethernet went away keeps its wifi.
  if (config.publicConfig().wifi.radio === false) {
    system.ethernetStatus((eth) => {
      if (!wifiradio.canDisable(eth)) {
        console.warn("[wifi] radio is set off but there is no ethernet - leaving it on");
        return;
      }
      wifiradio.setRadio({ ...process.env, ...WL_ENV }, false, (ok) =>
        console.log("[wifi] radio off (owner setting):", ok ? "applied" : "failed"),
      );
    });
  }
  // A colour space outlives the shell: a compositor left in PQ by a film that
  // was playing when the shell went down would keep the launcher in it. Say no
  // before the first mode change, which is what applies it.
  player.setHdr(false);
  // Put the output at the UI mode: the compositor boots at the EDID preferred
  // mode, which on a 4K set means drawing the launcher at 8.3 Mpixels.
  dmode.refresh();
  // And once, blocking, before any window exists: the refresh above is async, and
  // an app's preload reads the panel resolution exactly once, when its window is
  // created. Losing that race means the app spends its whole life believing the
  // screen is whatever the UI happens to be running at.
  panelResolution = display.panelResolution((display.listSync() || {}).modes);
  // Whether the set can be asked for PQ at all. Read from the EDID once: a TV
  // does not grow the capability while it is plugged in, and a box whose panel
  // cannot do it never touches the compositor's colour space.
  panelHdr = hdrout.panelSupportsHdr();
  console.log("[display] panel HDR:", panelHdr ? "yes" : "no");
  watchDisplayMode();
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
      redact(ev.message),
      ev.sourceId ? "(" + ev.sourceId + ":" + ev.lineNumber + ")" : "",
    );
  });
  win.loadURL(BASE + "/tvbox/"); // boot into the HOME launcher
  win.focus();
  // Keep a black backdrop behind the page by default (only removed during active
  // video) so the transparent window never reveals the desktop. insertCSS is
  // per-document, so re-arm on every navigation (launcher <-> app).
  // The first successful load is also the OTA health signal: it commits a
  // freshly flipped update (clears the rollback markers, syncs infra files) and
  // records that this boot got far enough to have a launcher, which is what keeps
  // the box out of safe mode (deploy/tvbox-safemode.sh).
  win.webContents.on("did-finish-load", () => {
    win.tvboxStyleInjected = false;
    ensureStyle(win);
    setVideoMode(false, win);
    updater.onLauncherLoaded();
    boothealth.markHealthy(pkg.version);
  });
  // Background-apps policy hooks (registry lives in appwindows.js).
  appwins.init({
    enabled: () => {
      const a = config.rawApps();
      return !(a && a.background === false);
    },
    memInfo: system.memInfo,
    foregroundId: () => currentAppId,
  });
  setInterval(() => appwins.ramGuardTick(), 60 * 1000); // evict hidden apps under memory pressure
  nativeapp.init({
    childEnv: () => ({ ...process.env, ...WL_ENV }), // the session's Wayland vars, same as mpv gets
    bridgeCmd: bridgesCmd, // "native on" / "native off" to both uinput bridges
    // The process is gone: its own Quit item, a crash, or our own stop(). Show the
    // launcher only if that app is still what the shell thinks is in front, or the
    // TV is left on a bare desktop with no way out. When we stopped it in order to
    // navigate somewhere else, currentAppId is already the new app and its exit
    // must not yank the screen back to HOME.
    onExit: (id) => {
      nativeForeground = false;
      if (currentAppId !== id) return;
      const back = nativeHostApp;
      nativeHostApp = null;
      // The screen may already be back. Navigating to an app's own UI while its program
      // runs stops that program (one visible toplevel), shows the window, and leaves
      // currentAppId as it was - and this callback arrives a moment later. Without this
      // the intentional stop would be followed by a jump to HOME.
      const win = appWindow(id);
      if (win && !win.isDestroyed() && win.isVisible()) return;
      // An app that launched the program from its own UI gets the screen back (navTo
      // resumes its hidden window, or reopens it if the RAM guard took it): a game that
      // ends should land in the list it was started from. Only while that app is still
      // launchable, though - manifests reload live, and navTo returns without showing
      // anything for an app that has been removed or disabled, which would leave the
      // TV on the bare desktop with every window of ours hidden.
      const m = back === id && apps.manifestById(id);
      if (m && m.status === "ready") navTo(id);
      else showLauncher();
    },
  });
  updater.startSchedulers(); // boot check + 6h re-check + nightly idle auto-apply
  if (config.rawFileserver().enabled) applyFileserver(); // the LAN share survives a restart
  if (config.rawShares().length) applyShares(); // and so do the shares the box reads FROM
  setInterval(maintenance.appsAutoTick, 30 * 60 * 1000); // nightly registry app auto-update (same window)
  // Not gated to the small hours like the registry check: a bundle whose flatpak
  // moved is BROKEN-ish now (the copy is older than the app it talks to), and the
  // work is a local file copy, not a download.
  setTimeout(maintenance.bundleRefreshTick, 2 * 60 * 1000);
  setInterval(maintenance.bundleRefreshTick, 6 * 60 * 60 * 1000);
  // Sooner than the bundle refresh: this is the boot right after a restore, the
  // user is watching an empty HOME, and every tile they expect is behind it. The
  // re-check covers a box that was busy (or offline) at the first attempt.
  setTimeout(maintenance.reconcileTick, 20 * 1000);
  setInterval(maintenance.reconcileTick, 15 * 60 * 1000);
  setTimeout(btBatteryTick, 5 * 60 * 1000); // early check after boot, then half-hourly
  setInterval(btBatteryTick, 30 * 60 * 1000);
  // Start plugin daemons once the HDMI sink is the default (librespot needs it).
  ensureAudio(() => startPlugins());
  // MQTT bridge (now-playing publish + HA integration); no-op if not provisioned.
  // (The command handler is added by the voice-control work.)
  applyMqttConfig();
  // A rename changes which MQTT topics the box belongs on, so the bridge has to
  // reconnect with it.
  system.init({ onHostnameChanged: applyMqttConfig });
  // Say who owns the screen, before anything else can. The compositor outlives the
  // shell - the session's respawn loop restarts only this process - so it can still
  // be holding "an app is in front" from before the restart, and would go on
  // rewriting the remote's Back key for a launcher that handles the browser key
  // itself. Same reason player.js starts its HDR claim as "nothing said yet".
  setForegroundApp(currentAppId);
  // The player is a service, not a window: the shell hands it the four things it
  // cannot know by itself - which windows hear a player event, how to reveal the
  // video, the display-mode arbiter, and what the panel answered.
  player.init({
    sendEvent: (ev) => {
      const fg = currentAppId && appWindow(currentAppId);
      for (const w of new Set([win, fg])) {
        if (w && !w.isDestroyed()) {
          try {
            w.webContents.send("player-event", ev);
          } catch (e) {}
        }
      }
    },
    setVideoMode,
    raiseWindow,
    cecPower,
    publishMediaState,
    dmode,
    panelHdr: () => panelHdr,
    outputSize: () => outputSize,
    audioSink: () => audioSink,
    childEnv: () => ({ ...process.env, ...WL_ENV }),
  });
  // The background jobs need to know whether the box is free and how to reach the
  // shell; nothing in them draws anything.
  maintenance.init({
    boxIdle,
    boxFree,
    restartShell,
    hotLoadPlugin,
    applyPendingAppFiles: (opts) => backup.applyPendingAppFiles(opts),
    jsonRes: httpserver.jsonRes,
    childEnv: () => ({ ...process.env, ...WL_ENV }),
  });
  ir.applyConfig(); // IR blaster hub; no-op if not configured
  // Keep the media state topic honest about which app is in front and how loud the
  // box is; both are cheap and neither is urgent (see MEDIA_TICK_MS).
  setInterval(() => publishMediaState(), MEDIA_TICK_MS);
  refreshSinkState();
  setInterval(refreshSinkState, SINK_TICK_MS);
  setInterval(publishDiag, DIAG_TICK_MS);
  console.log("[main] window up");
});

// Everything the shell must let go of before it exits. A native app is killed
// rather than left behind: it would keep a fullscreen window on the TV with no
// shell to escape it. The bridges are taken out of native mode explicitly too,
// because the app's exit event does not necessarily get to run during shutdown,
// and a bridge left routing Home to a dead shell would swallow the button.
// How long shutdown waits for a native app to save and exit. Long enough for an
// emulator to flush its config and save files, short enough that a restart is not
// visibly stuck. native.js's own escalation timers (3s/6s) are no help here because
// they die with the shell, so at the deadline this path does the hard stop itself
// rather than waiting them out and leaving the app behind.
const NATIVE_SHUTDOWN_WAIT_MS = 2500;
function shutdown() {
  player.stop();
  if (!nativeapp.running()) return finishShutdown();
  // The app was just asked to exit. Quitting immediately would take away the
  // process that owns it before it has written its files, and the escalation
  // timers die with us, so poll briefly for it to go on its own.
  nativeForeground = false;
  nativeapp.stop();
  const deadline = Date.now() + NATIVE_SHUTDOWN_WAIT_MS;
  const wait = setInterval(() => {
    if (!nativeapp.settled() && Date.now() < deadline) return;
    clearInterval(wait);
    if (!nativeapp.settled()) nativeapp.forceStop();
    finishShutdown();
  }, 150);
}
function finishShutdown() {
  bridgesCmd("native off");
  stopPlugins();
  mqttBridge.stop();
  app.quit();
}

app.on("window-all-closed", shutdown);

// Quit gracefully on signals so localStorage (app logins) flushes and we don't
// leave an orphaned process holding port 8097 across a restart.
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
