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
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const config = require("./config");
const pairing = require("./pairing");
const playeropts = require("./playeropts"); // app stream terms -> mpv args/commands + the settable-property allowlist
const { redact } = require("./redact"); // an app's console line may carry ITS credentials; the shell's log is a file
const display = require("./display"); // resolution/refresh selection
const displaymode = require("./displaymode"); // adaptive mode: UI mode + per-video claims
const videoout = require("./videoout"); // which mpv renderer a stream needs
const httpserver = require("./httpserver"); // the transport under the API: responses, static files, the origin gate
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
const firetvir = require("./firetvir"); // Fire TV remote IR programming (venv deps + irdb codesets + BLE tool)
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
const IPC = "/tmp/tvbox-mpv.sock";
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
let mpv = null;
let mpvPip = false; // mpv is in PiP (small top-right) mode, not fullscreen
let playingUrl = null;
let mpvOwnerId = null; // app id whose player broker call launched mpv (video-mode target)
let mpvStartPending = false; // fullscreen mpv launched paused, waiting for the display-mode switch
let mpvSeq = 0; // launch counter, so a stale start-gate timer can't touch a newer launch
let mpvStartedSeq = 0; // the launch whose start handshake already ran
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
  return !mpv && !currentAppId && !(nowPlaying && nowPlaying.state === "playing");
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
// Copying a screensaver image onto the box, or a console BIOS into the folder an
// emulator reads, is not something a TV can do - and should not need ssh. The module
// owns the decisions (which folders are offered, what gets served, refusing to serve
// without a password); this is the wiring: config in, supervisor out.
// PATH matters here (rclone lands in ~/.tvbox/bin, which install.js prepends);
// the Wayland vars do not - this serves files, it draws nothing.
const fileserverDeps = { onPath: apps.onPath, childEnv: () => ({ ...process.env }), supervisor };
let rcloneInstalling = false;

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
    if (apps.onPath("rclone") && config.rawFileserver().enabled) applyFileserver();
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
  if (on) flip(w || appWindow(mpvOwnerId) || win);
  else if (w) flip(w);
  else {
    flip(win);
    for (const [, aw] of appwins.all()) flip(aw);
  }
}

// ---- HTTP: launcher (/tvbox/), app manifests API, and the root web app (Plex) ----
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
    if (data.bluetooth) {
      config.setBluetooth(data.bluetooth); // ERTM off - applied by the root boot unit
      changed.push("bluetooth");
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
    return httpserver.jsonRes(res, { ok: true, config: config.publicConfig() });
  }
  if (p === "/tvbox/api/ui/locale") {
    // The launcher owns the UI language (its i18n store is in the renderer); it
    // mirrors it here so the shell can hand it to things the renderer can't reach:
    // the phone pairing pages and every remote web app's language.
    // Only write when it actually changed: the launcher mirrors on every page load,
    // and showLauncher(hash) reloads it - so this would rewrite config.json each time
    // the user entered Settings from an app.
    const want = String(data.locale || "");
    if (want && want !== config.uiLocale()) config.setUi({ locale: want });
    return httpserver.jsonRes(res, { ok: true, locale: config.uiLocale() });
  }
  if (p === "/tvbox/api/display/refresh") {
    // "Re-detect": recompute the UI mode from the live output and go there. The
    // user's escape hatch if a TV pushed the box somewhere odd - and the only
    // display action left in the UI now that resolution is automatic. rearm() first:
    // a person pressing OK means "try again", even if earlier attempts didn't stick.
    dmode.rearm();
    return dmode.refresh((ok, err) =>
      httpserver.jsonRes(res, ok ? { ok: true } : { ok: false, error: err || "failed" }),
    );
  }
  if (p === "/tvbox/api/audio/default") {
    // persist the override (empty string clears it -> back to auto), then re-apply
    config.setAudio({ sink: String(data.sink || "") });
    return ensureAudio(() => httpserver.jsonRes(res, { ok: true, sink: audioSink }));
  }
  if (p === "/tvbox/api/audio/volume") {
    return audio.setVolume({ ...process.env, ...WL_ENV }, Number(data.id), Number(data.volume), (ok) =>
      httpserver.jsonRes(res, { ok }),
    );
  }
  if (p === "/tvbox/api/ir/send") {
    // IR blaster: abstract TV command (volume_up/volume_down/mute), optionally
    // repeated (steps). Callers: the remote bridge (BT volume keys) + the
    // settings UI test buttons. A dead blaster answers ok:false, never a 500.
    return ir.send(String(data.action || ""), data.steps).then(
      (r) => httpserver.jsonRes(res, r),
      (e) => httpserver.jsonRes(res, { ok: false, error: String((e && e.message) || e) }),
    );
  }
  if (p === "/tvbox/api/nav") {
    // Any navigation ends a typing session: with currentAppId === null (the typing
    // screen backgrounds its app) the branches below wouldn't touch it, leaving a
    // live session, a live pairing code, and an app whose next focused field would
    // silently do nothing.
    textinput.cancel();
    // Launcher/app navigation from the remote bridge (remapped "settings" /
    // "app:<id>" buttons). Settings: launcher already up -> in-page event (no
    // reload); app fullscreen -> leave it and boot the launcher on the target
    // view via the #hash. App launch: navTo (no-ops on unknown/not-ready ids).
    const dest = String(data.dest || "");
    if (dest === "app") {
      const id = String(data.app || "");
      if (!/^[a-z0-9_-]{1,32}$/.test(id)) return httpserver.jsonRes(res, { ok: false, error: "invalid app id" });
      navTo(id);
      return httpserver.jsonRes(res, { ok: true, dest, app: id });
    }
    if (dest === "switch") {
      switchApp(); // cycle through running apps (the appswitcher remap action)
      return httpserver.jsonRes(res, { ok: true, dest, app: currentAppId });
    }
    if (dest !== "home" && dest !== "settings")
      return httpserver.jsonRes(res, { ok: false, error: "unknown dest: " + dest });
    if (currentAppId !== null) showLauncher(dest === "settings" ? "#settings" : "");
    else if (win && !win.isDestroyed()) win.webContents.send("tvbox-nav", { dest });
    return httpserver.jsonRes(res, { ok: true, dest });
  }
  if (p === "/tvbox/api/apps/quit") {
    // HOME's running-apps row: really exit an app (its window and page state are
    // dropped; next launch is a fresh start). Same teardown an app's own "Exit?"
    // dialog gets - one implementation, so both can't drift.
    const id = String(data.id || "");
    if (!appWindow(id)) return httpserver.jsonRes(res, { ok: false, error: "not running" });
    exitApp(id);
    return httpserver.jsonRes(res, { ok: true, id });
  }
  // Fire TV remote IR programming (Settings → Peripherals; shell/firetvir.js)
  if (p === "/tvbox/api/firetvir/deps") {
    return httpserver.jsonRes(res, { ok: firetvir.installDeps() }); // progress is polled via /firetvir/status
  }
  // `plan` = { base, keys: { <key>: { path, second } } } (per-key brands + a
  // second device on a key); a bare `path` is the single-codeset form.
  if (p === "/tvbox/api/firetvir/test") {
    firetvir.testKey(String(data.mac || ""), data.plan || String(data.path || ""), String(data.key || ""), (err, r) =>
      httpserver.jsonRes(res, err ? { ok: false, error: String(err.message || err).slice(0, 200) } : r),
    );
    return;
  }
  if (p === "/tvbox/api/firetvir/program") {
    firetvir.program(String(data.mac || ""), data.plan || String(data.path || ""), String(data.label || ""), (err, r) =>
      httpserver.jsonRes(res, err ? { ok: false, error: String(err.message || err).slice(0, 200) } : r),
    );
    return;
  }
  if (p === "/tvbox/api/firetvir/erase") {
    firetvir.erase(String(data.mac || ""), (err, r) =>
      httpserver.jsonRes(res, err ? { ok: false, error: String(err.message || err).slice(0, 200) } : r),
    );
    return;
  }
  if (p === "/tvbox/api/nowplaying") {
    // launcher pushes the current now-playing (Spotify / Live TV); bridge it to
    // MQTT (retained) for HA, and remember it for the auto-update idle gate.
    nowPlaying = data;
    if (mqttCtl) mqttCtl.publish("nowplaying", data, { retain: true });
    publishMediaState({ force: true }); // the metadata changed: always news
    return httpserver.jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/update/check") {
    updater.check().then((s) => httpserver.jsonRes(res, s));
    return;
  }
  if (p === "/tvbox/api/update/apply") {
    // async: download/npm ci can take minutes - respond now, the UI polls status
    updater.apply();
    return httpserver.jsonRes(res, updater.status());
  }
  if (p === "/tvbox/api/update/clear-failed") {
    return httpserver.jsonRes(res, updater.clearFailed());
  }
  if (p === "/tvbox/api/backup/context") {
    // launcher hands over its localStorage snapshot right before the backup QR
    backupPairing.setContext(data);
    return httpserver.jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/backup/pending-localstorage/clear") {
    backup.clearPendingLocalStorage();
    return httpserver.jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/power") {
    return handlePower(String(data.action || ""), res);
  }
  if (p === "/tvbox/api/ambient/photos/clear") {
    return httpserver.jsonRes(res, { ok: true, removed: ambient.clearPhotos() });
  }
  if (p === "/tvbox/api/ambient/photos/delete") {
    return httpserver.jsonRes(res, { ok: ambient.deletePhoto(String(data.name || "")) });
  }
  if (p === "/tvbox/api/bt/scan") {
    return bluetooth.scan({ ...process.env, ...WL_ENV }, Number(data.seconds) || 8, (devices) =>
      httpserver.jsonRes(res, { devices }),
    );
  }
  if (p.startsWith("/tvbox/api/bt/")) {
    const action = p.slice("/tvbox/api/bt/".length);
    const fn = {
      pair: bluetooth.pair,
      // Same pairing with the wifi radio held down for the attempt - the escape
      // hatch for a BLE remote that will not bond while the shared antenna is busy.
      "pair-quiet": bluetooth.pairQuiet,
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
    if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) return httpserver.jsonRes(res, { ok: false, error: "bad mac" });
    return fn({ ...process.env, ...WL_ENV }, mac, (r) => httpserver.jsonRes(res, r));
  }
  if (p === "/tvbox/api/remote/learn") {
    // Enter learn mode for a device: the bridge captures & reports the next
    // button pressed on it (id may contain spaces -> rest-of-line in the FIFO).
    const id = String((data && data.id) || "").replace(/[\r\n]/g, "");
    if (!id) return httpserver.jsonRes(res, { ok: false, error: "no id" });
    remoteBridgeCmd("learn " + id);
    return httpserver.jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/remote/learn-off") {
    remoteBridgeCmd("learn-off");
    return httpserver.jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/remote/reset") {
    // Clear one remote's remapping (id) or ALL (no id) and reload the bridge.
    // Called by the UI "reset" button and by the bridge's panic gesture (a user
    // who remapped nav away and can't reach this menu with that remote).
    // irPassthrough survives a reset: it describes the remote's own programmed
    // IR hardware, not a button mapping - dropping it would make the bridge
    // divert volume AGAIN on top of the remote's own IR (double steps).
    const id = String((data && data.id) || "").trim();
    const cur = config.rawRemote() || {};
    const devices = {};
    for (const [k, v] of Object.entries(cur.devices || {})) {
      if (id && k !== id) devices[k] = v;
      else if (v && v.irPassthrough) devices[k] = { name: v.name, keymap: {}, irPassthrough: true };
    }
    config.setRemote({ devices });
    remoteBridgeCmd("reload");
    return httpserver.jsonRes(res, { ok: true, cleared: id || "all" });
  }
  if (p === "/tvbox/api/parental/verify") {
    return httpserver.jsonRes(res, { ok: config.verifyPin(String(data.pin || "")) });
  }
  if (p === "/tvbox/api/pairing/start") {
    return httpserver.jsonRes(res, pairing.start(data.locale, data.kind)); // kind: "iptv" (default) | "spotify"
  }
  if (p === "/tvbox/api/pairing/stop") {
    pairing.stop();
    return httpserver.jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/apps/install") {
    return maintenance.startInstall(String(data.id || ""), res);
  }
  if (p === "/tvbox/api/apps/deps") {
    return maintenance.startDeps(String(data.id || ""), res);
  }
  if (p === "/tvbox/api/store/install") {
    const id = String(data.id || "");
    store
      .install(config, id)
      .then((r) => {
        httpserver.jsonRes(res, r);
        // The manifest is on disk; now finish the install (no-root binary deps +
        // bundle) in the SAME action, so the app reaches HOME only once it is
        // actually launchable - no "press the tile to finish" step. provisionFull
        // handles the final service-plugin restart itself, gated on idle.
        if (r.ok) maintenance.provisionFull(id);
      })
      .catch((e) => httpserver.jsonRes(res, { ok: false, error: String(e.message || e).slice(0, 120) }));
    return;
  }
  if (p === "/tvbox/api/store/flatpak-update") {
    return maintenance.startFlatpakUpdate(String(data.id || ""), res);
  }
  if (p === "/tvbox/api/store/uninstall") {
    const id = String(data.id || "");
    if (currentAppId === id) showLauncher();
    destroyAppWindow(id); // a background window must not outlive its app
    setWidget(id, null);
    return httpserver.jsonRes(res, store.uninstall(id));
  }
  if (p === "/tvbox/api/setup/done") {
    // Onboarding state is the BOX's, not the browser's: localStorage can come up
    // empty (see claimSingleInstance) and a configured box must not offer setup
    // again because of that. The launcher still keeps its own copy for the fast path.
    return httpserver.jsonRes(res, { ok: config.setSetupDone() });
  }
  if (p === "/tvbox/api/fileserver") {
    // One writer for the whole form: enable/disable, credentials, folders. Applying
    // is immediate, because a setting nobody can see the effect of is a trap.
    config.setFileserver({
      enabled: data.enabled,
      user: data.user,
      port: data.port,
      folders: data.folders,
      pass: data.pass, // omitted keeps the stored one, "" clears it
    });
    const r = applyFileserver();
    return httpserver.jsonRes(res, {
      ok: !!r.ok,
      error: r.error || null,
      status: fileserver.status(config.rawFileserver(), fileserverDeps),
    });
  }
  if (p === "/tvbox/api/fileserver/install-rclone") {
    return httpserver.jsonRes(res, { ok: true, installing: installRclone() || rcloneInstalling });
  }
  if (p === "/tvbox/api/config/app") {
    // Set a urlConfig app's address: { key, baseUrl } (http/https or empty to clear).
    const key = String(data.key || "");
    const baseUrl = String(data.baseUrl || "").trim();
    if (baseUrl && !/^https?:\/\/\S+$/.test(baseUrl)) return httpserver.jsonRes(res, { ok: false, error: "bad url" });
    return httpserver.jsonRes(res, { ok: config.setAppConfig(key, { baseUrl }) });
  }
  if (p === "/tvbox/api/apps/remove") {
    // Drop an installed web-client bundle (apps-data/<id>). The manifest stays,
    // so the tile reverts to its "installable" state - the UI mirror of
    // `tvbox remove <id>`.
    const id = String(data.id || "");
    const m = apps.manifestById(id);
    if (!m || m.type !== "webclient") return httpserver.jsonRes(res, { ok: false, error: "not removable" });
    if (maintenance.isInstalling(id)) return httpserver.jsonRes(res, { ok: false, error: "install in progress" });
    if (currentAppId === id) showLauncher(); // never yank the bundle out from under the running app
    destroyAppWindow(id); // incl. a hidden background window
    return httpserver.jsonRes(res, { ok: true, removed: apps.removeApp(id) });
  }
  if (p === "/tvbox/api/wifi/connect") {
    return system.wifiConnect(String(data.ssid || ""), String(data.password || ""), !!data.hidden, (r) =>
      httpserver.jsonRes(res, r),
    );
  }
  if (p === "/tvbox/api/power/sleep-timer") {
    return httpserver.jsonRes(res, setSleepTimer(data.minutes)); // 0/absent = cancel
  }
  if (p === "/tvbox/api/wifi/forget") {
    return system.wifiForget(String(data.ssid || ""), (r) => httpserver.jsonRes(res, r));
  }
  // The radio as a lasting choice: on a box that lives on ethernet it only costs
  // Bluetooth airtime, and the two share one antenna. Refuse to turn it off with
  // no wired carrier - the box would leave the LAN and nothing here could undo it.
  if (p === "/tvbox/api/wifi/radio") {
    // A real boolean or nothing at all. `data.on === true` would read every
    // malformed body - a missing field, the STRING "false", a JSON `null` body
    // (which parses, leaving `data` null) - as a request to turn the radio OFF,
    // which is the one direction that can take a box off the network.
    if (!data || typeof data.on !== "boolean") return httpserver.jsonRes(res, { ok: false, error: "bad-request" });
    const on = data.on;
    return system.ethernetStatus((eth) => {
      if (!on && !wifiradio.canDisable(eth)) {
        return httpserver.jsonRes(res, { ok: false, error: "no-ethernet", ethernet: eth });
      }
      wifiradio.setRadio({ ...process.env, ...WL_ENV }, on, (ok) => {
        if (ok) config.setWifi({ radio: on });
        httpserver.jsonRes(res, { ok, radio: on, ethernet: eth });
      });
    });
  }
  if (p === "/tvbox/api/system/timezone") {
    return system.setTimezone(String(data.timezone || ""), (r) => httpserver.jsonRes(res, r));
  }
  if (p === "/tvbox/api/system/keymap") {
    return system.setKeymap(String(data.keymap || ""), (r) => httpserver.jsonRes(res, r));
  }
  if (p === "/tvbox/api/system/hostname") {
    return system.setHostname(String(data.hostname || ""), (r) => httpserver.jsonRes(res, r));
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
const MPV_CLAIM = "shell:mpv"; // claim id for the shell's own player
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
    const guardedGet = p === "/tvbox/api/tv/standby" || p.startsWith("/tvbox/api/firetvir/");
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
        handlePost(p, d, res);
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
      onTvStandby();
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

// ---- mpv control ----
// Player events go to every live window: the driving app (own window now) needs
// them for its UI, the launcher for now-playing state. Listeners that don't
// care simply have no handler registered.
// Player events go to the launcher (now-playing state) and the FOREGROUND app
// only - never a backgrounded app. A hidden app receiving "finished" and
// auto-advancing would start mpv behind an opaque foreground (invisible video +
// phantom audio) and keep the box from ever reporting idle.
function emit(ev) {
  const fg = currentAppId && appWindow(currentAppId);
  for (const w of new Set([win, fg])) {
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send("player-event", ev);
      } catch (e) {}
    }
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
// keepMode: launchMpv's own pre-launch stop, where releasing the display claim
// would put the UI mode back for a second only for the new file to claim again.
function stopMpv(keepMode) {
  // (mpvOwnerId is NOT cleared here: launchMpv calls this on relaunch right
  // after "play" set the owner. Every play re-assigns it, and without a running
  // mpv no first-frame reveal can consume a stale value.)
  if (!keepMode) {
    setHdr(false);
    dmode.release(MPV_CLAIM);
  }
  clearMpvMedia(); // the clock stops with the process (see clearMpvMedia)
  mpvStartPending = false; // no paused-start handshake outlives the process
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
// mpv logs its own COMMAND LINE, and the file it plays is on it - so this file
// gets the media URL with whatever credentials it carries, and nothing here can
// stop that: it is mpv writing, not us. What can be done is who may read it, so
// the file is created 0600 first (mpv truncates an existing file and keeps its
// mode). It is deliberately NOT one of the logs tvbox-diag copies to the boot
// partition.
function mpvLogPath() {
  const p = path.join(os.homedir(), ".tvbox", "mpv.log");
  try {
    // O_NOFOLLOW, so a SYMLINK at this path is refused by the kernel rather than
    // followed - checking with lstat first would leave the gap between the check
    // and the open. It matters because mpv writes wherever this path leads and we
    // would have chmodded that target on the way: ~/.tvbox is reachable through
    // the file server, so "nobody can put a link there" is not a given.
    const fd = fs.openSync(
      p,
      fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      // A fifo or a device would take mpv's writes somewhere of its own too.
      if (!fs.fstatSync(fd).isFile()) return null;
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null; // no log rather than a log we are not sure of; playback is unaffected
  }
  return p;
}

// Where a small player goes when the caller measured no placeholder: the top-right
// quarter, inset. Only a caller that skipped the rect lands here - the Live TV app
// measures its own hole - so this is a shape that looks deliberate rather than one
// anybody depends on.
function pipFallbackRect() {
  if (!outputSize) return null; // no mode read yet: fullscreen is better than a guess
  const w = Math.round(outputSize.width * 0.26);
  const h = Math.round((w * 9) / 16);
  const margin = Math.round(outputSize.width * 0.03);
  return { x: outputSize.width - w - margin, y: margin, w, h };
}

function launchMpv(url, startPos, pip, rect, streams) {
  // Fullscreen relaunch keeps the claim (the next file re-claims immediately, and
  // releasing in between would blank the TV twice); going to PiP gives it back,
  // because there the browse UI is what's on screen.
  stopMpv(!pip);
  const seq = ++mpvSeq; // this launch's identity for every async gate below
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
    // The renderer that works for anything, including software-decoded streams.
    // adaptMpvMode swaps it for the zero-copy output where that one cannot keep
    // up (videoout.js) - the property is settable, so no relaunch.
    "--vo=gpu",
    "--gpu-api=opengl",
    "--hwdec=auto-safe",
    "--input-ipc-server=" + IPC,
    "--start=" + startPos,
    // (the log file is appended below, when there is one we trust)
    "--msg-level=all=error",
  ];
  // PiP (Live TV "browse while watching"): a small window. A Wayland client cannot
  // place itself, so the COMPOSITOR places it - `rect` (device px, measured by the
  // launcher from the on-screen placeholder) makes it match the placeholder exactly
  // at any resolution, and a top-right quarter is the fallback when a caller sends
  // none. It is set before mpv starts, so the window is never fullscreen first.
  //
  // mpv sits BEHIND the (transparent) Electron window and shows through a
  // box-shadow "hole" the browse UI punches, so the launcher keeps keyboard focus
  // (D-pad works) while the video is visible in the hole. The compositor keeps our
  // windows in front for the same reason.
  if (pip) {
    compositor.placeWindow("mpv", rect && rect.w > 0 ? rect : pipFallbackRect());
    args.push("--no-border");
  } else {
    compositor.placeWindow("mpv", null);
    args.push("--no-border");
    // Fullscreen starts PAUSED so the output can be switched to match the video
    // BEFORE it plays (adaptMpvMode -> startMpvPlayback below): a mode change
    // blanks HDMI for a second or two, which belongs before the first frame, not
    // three seconds into the film. PiP never switches - the UI owns the screen there.
    args.push("--pause=yes");
    mpvStartPending = true;
  }
  const logFile = mpvLogPath();
  if (logFile) args.push("--log-file=" + logFile);
  if (audioSink) args.push("--audio-device=pipewire/" + audioSink);
  // Track selection, per axis: what the app decided for itself (Plex resolves
  // audio/subtitle server-side and ships the choice with the item) wins, and
  // Settings > Picture & sound fills in the rest. The app's choice has to be
  // spelled out because mpv's default `sid=auto` turns on any subtitle track
  // carrying the container's default flag, which is how a film played with "no
  // subtitles" in Plex came up with Hungarian subs anyway.
  args.push(...playeropts.streamArgs(streams, config.rawPlayer()));
  // "--" ends option parsing: a URL starting with "-" (or a crafted playlist
  // entry) must always be argv's file position, never an mpv option.
  args.push("--", url);
  mpv = spawn("mpv", args, { env: { ...process.env, ...WL_ENV }, detached: true, stdio: "ignore" });
  const child = mpv;
  console.log("[player] mpv launched pid", mpv.pid, pip ? "(pip)" : "");
  // A spawn that never got off the ground (EACCES, fork failure - ENOENT is already
  // guarded above) emits "error" and no usable "exit". Unhandled it would take the
  // shell down, and it must not leave a paused-start flag or a claim behind either.
  child.on("error", (e) => {
    console.error("[player] mpv spawn failed:", e.message);
    child.removeAllListeners("exit"); // don't report "finished" twice
    if (mpv === child) mpv = null;
    playingUrl = null;
    mpvStartPending = false;
    setVideoMode(false);
    setHdr(false);
    dmode.release(MPV_CLAIM);
    emit({ type: "error" });
    emit({ type: "finished" });
  });
  // One-touch wake: video starting while the TV sleeps should light it up
  // (voice/HA "play X" with the TV off). "on 0" is a no-op on a TV that's
  // already on. The one exception: right after the USER put the TV on standby -
  // the stop we emit as "finished" can make an app auto-play the next item
  // (Plex on-deck), which must not switch the TV back on.
  if (Date.now() - lastTvStandbyAt > 30 * 1000) cecPower(true);
  // Never leave a paused-start film stuck: if the file hasn't loaded (or the IPC
  // observer never came up) within 8s, do the mode handshake anyway. Tied to this
  // launch's sequence number so a stale timer can't shortcut the NEXT film.
  if (!pip) {
    setTimeout(() => {
      if (mpvSeq === seq && mpvStartPending) {
        // The file hasn't loaded (a slow Plex/HLS start) or the IPC observer never
        // came up: play rather than sit on a black screen. Deliberately NOT running
        // the handshake here - it would claim a mode from a stream mpv hasn't opened
        // yet. If the file does load later, the first-frame path still switches.
        console.warn("[player] start gate timed out - playing anyway");
        mpvStartPending = false;
        mpvCmd({ command: ["set_property", "pause", false] });
      }
    }, 8000);
  }
  mpv.on("exit", (code, sig) => {
    console.log("[player] mpv exited code", code, "sig", sig);
    emit({ type: "finished" });
    mpv = null;
    playingUrl = null;
    setVideoMode(false);
    mpvStartPending = false;
    setHdr(false);
    dmode.release(MPV_CLAIM); // film over -> UI mode back (stopMpv covers our own kills)
    // The END of a film is an exit, not a stopMpv - mpv runs without --keep-open.
    // Without this the retained state topic keeps saying "playing" with a frozen
    // position, so Home Assistant shows a film nobody is watching until the next
    // playback, and `seek` would still be aimed at a dead socket.
    clearMpvMedia();
  });
  // mpv grabs keyboard focus when its window maps (and can do so late), which
  // would break D-pad nav - so keep pulling the launcher back to the front +
  // focus for a few seconds. This works for both modes: fullscreen mpv is behind
  // the transparent overlay, and PiP mpv is behind the transparent window showing
  // through the browse UI's hole, so raising the launcher never hides the video.
  [500, 1200, 2000, 3000, 4000].forEach((ms) => setTimeout(raiseWindow, ms));
  setTimeout(() => observeMpv(seq, 0), 900);
}
// What the video actually is, per mpv. `container-fps` is the stream's declared
// rate (not the drifting measured one); dwidth/dheight are the display size after
// aspect correction, with the decoded size as fallback - on the box dwidth came
// back "property unavailable" at the very moment dheight was already readable.
function readVideoProps() {
  const props = ["container-fps", "dwidth", "dheight", "width", "height", "hwdec-current", "video-params/gamma"];
  return Promise.all(props.map((p) => mpvQuery(["get_property", p]))).then(([fps, dw, dh, w, h, hwdec, gamma]) => ({
    fps: Number(fps) || 0,
    width: Number(dw) || Number(w) || 0,
    height: Number(dh) || Number(h) || 0,
    hwdec: typeof hwdec === "string" ? hwdec : "",
    // The transfer function the file was mastered with; "pq" is HDR10/DV.
    gamma: typeof gamma === "string" ? gamma : "",
  }));
}

// The output's colour space rides with the display mode: claimed for a PQ film
// that reaches the plane, released when it ends. Releasing matters as much as
// claiming - an SDR film left on a PQ output looks wrong, and the UI on its
// overlay plane is read as PQ for as long as the claim is held.
let hdrClaimed = false;
function setHdr(on, cb) {
  const next = cb || (() => {});
  if (!!on === hdrClaimed) return next();
  hdrout.claim(on, (ok, err) => {
    if (ok) hdrClaimed = !!on;
    else console.warn("[player] hdr claim failed:", err);
    next();
  });
}

// Match the output to the video, then hand control back to the caller (which
// unpauses). A stream with no declared fps (some live HLS) leaves the mode alone.
// `seq` is the launch this belongs to: reading mpv's properties can take seconds,
// and a claim landing after that film was stopped would leave the launcher (or the
// NEXT film) at the dead one's mode with nothing left to release it.
function adaptMpvMode(seq, done) {
  const claim = (content) => {
    if (mpvSeq !== seq || !mpv) return done(); // stopped or superseded while we read
    const zeroCopy = videoout.zeroCopyVideo(content, mpvPip);
    if (zeroCopy) {
      // `vo` is settable while paused, so this costs nothing visible - it lands in
      // the same paused window as the mode switch, before the first frame.
      mpvCmd({ command: ["set_property", "vo", videoout.ZERO_COPY_VO] });
    }
    // And the output's colour space, before the claim below. Order matters for a
    // reason that outlives any one compositor: the colour space covers the whole
    // output, so it has to be in place before the film's first frame reaches a
    // plane, and the caller unpauses in done().
    setHdr(hdrout.wants(content, zeroCopy, panelHdr), () => {
      if (!(content.fps > 0)) {
        console.log("[player] no container-fps - leaving the display mode alone");
        return done();
      }
      dmode.claim(MPV_CLAIM, content, (r) => {
        // Nothing on this panel divides into the content's rate (a 60Hz-only set and
        // a 24p film): resample instead of juddering. This is what the old manual
        // "match content framerate" toggle did, decided per file now.
        if (r && r.reason === "no-matching-mode") {
          mpvCmd({ command: ["set_property", "video-sync", "display-resample"] });
        }
        done();
      });
    });
  };
  // Nothing in this chain rejects today (mpvQuery resolves null on every failure),
  // but playback must not hang on that staying true: anything thrown in here starts
  // the film immediately instead of waiting for the failsafe.
  const failed = (e) => {
    console.warn("[player] display mode adapt failed:", (e && e.message) || e);
    // We never learned what this file is, and a relaunch keeps the previous
    // claim - so without this an SDR film following an HDR one would play on a
    // PQ output. SDR is the safe answer to a question that got no answer.
    setHdr(false);
    done();
  };
  // Properties that settle late get a few more goes, keeping whatever each read
  // already learned: dwidth/fps come back "property unavailable" for the first
  // second or so after a paused start, and hwdec-current stays unavailable until
  // the decoder has actually run - which is what decides the renderer. Re-read
  // only while something we act on is still missing, so an ordinary file is not
  // held up: below 4K the hwdec answer changes nothing, so it is not waited for.
  const settle = (prev, tries) =>
    readVideoProps().then((c) => {
      const merged = {
        fps: c.fps || prev.fps,
        width: c.width || prev.width,
        height: c.height || prev.height,
        hwdec: c.hwdec || prev.hwdec,
        gamma: c.gamma || prev.gamma,
      };
      // Height counts as missing too: the renderer is chosen from it, and the two
      // axes settle independently (dwidth has come back unavailable at the very
      // moment dheight was already readable, so the reverse can happen as well).
      const missing =
        !(merged.fps > 0 && merged.width > 0 && merged.height > 0) ||
        videoout.hwdecPending(merged, mpvPip) ||
        hdrout.gammaPending(merged, videoout.zeroCopyCandidate(merged, mpvPip));
      if (!missing || tries <= 0) return merged;
      return new Promise((r) => setTimeout(() => r(settle(merged, tries - 1)), 250));
    });
  settle({ fps: 0, width: 0, height: 0, hwdec: "" }, 6).then(claim).catch(failed);
}

// Paused-start handshake: switch the mode, then play. The 6s failsafe is
// load-bearing - if the compositor wedges or the claim never answers, the film must
// still start. (launchMpv arms a second one for "the observer never connected".)
function startMpvPlayback(seq) {
  if (mpvStartedSeq === seq) return; // exactly one handshake per launch
  mpvStartedSeq = seq;
  const go = () => {
    if (mpvSeq !== seq || !mpvStartPending) return; // newer launch, or already playing
    mpvStartPending = false;
    mpvCmd({ command: ["set_property", "pause", false] });
    // A mode switch remaps windows, so pull the app UI back over mpv again.
    [200, 700, 1500].forEach((ms) => setTimeout(raiseWindow, ms));
  };
  setTimeout(go, 6000);
  adaptMpvMode(seq, go);
}

function observeMpv(seq, tries) {
  const s = net.connect(IPC);
  let connected = false;
  let firstPos = false;
  s.on("error", (e) => {
    console.log("[player] observer error", e.code);
    // The observer is what starts playback now (paused launch), so an IPC socket
    // that isn't up yet must be retried rather than dropped - but only for the
    // launch it was started for, or a dead launch's retry chain would attach a
    // second observer to the NEXT mpv.
    if (!connected && mpv && mpvSeq === seq && (tries || 0) < 5)
      setTimeout(() => observeMpv(seq, (tries || 0) + 1), 400);
  });
  s.on("connect", () => {
    connected = true;
    console.log("[player] observer connected");
    // `paused-for-cache`, NOT `core-idle`: core-idle is also true while the USER
    // has it paused, so reporting it as buffering told a client the player was
    // stuck loading for as long as the film sat paused. Plex then spun its loader
    // over the frozen frame and killed the session on its own 120 s
    // BufferingTimeout ("Playback error"), measured on the box.
    ["time-pos", "duration", "pause", "eof-reached", "paused-for-cache"].forEach((p, i) =>
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
          // The file is loaded now (that's what a time-pos means), so its real
          // fps/size are readable: pick a mode for it, then let it play.
          if (!mpvPip) startMpvPlayback(seq);
        }
        emit({ type: "playing" });
        emit({ type: "position", ms: Math.round(m.data * 1000) });
        mpvMedia.active = true;
        mpvMedia.position = m.data;
        publishMediaState();
      } else if (m.name === "duration" && m.data != null) {
        emit({ type: "duration", ms: Math.round(m.data * 1000) });
        mpvMedia.duration = m.data;
        publishMediaState();
      } else if (m.name === "pause") {
        // Observed for the media state only - the renderer learns about pausing
        // from its own player calls.
        mpvMedia.paused = !!m.data;
        publishMediaState({ force: true });
      } else if (m.name === "paused-for-cache") emit({ type: "buffering", on: !!m.data });
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
  playingUrl = null;
  stopMpv();
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
  playingUrl = null;
  stopMpv(); // the shared player must not hold the GPU, audio, or a mode claim
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
  stopMpv();
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
      if (input.key === "Backspace" || input.key === "Escape") {
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
// What mpv is doing right now. Kept here rather than read on demand: the observer
// already streams it (observeMpv), and asking mpv over its socket per publish would
// turn a state topic into a round trip.
const mpvMedia = { active: false, paused: false, position: null, duration: null };
// The clock stops with the process. Both ways mpv can go away have to come through
// here - our own stopMpv AND mpv exiting on its own, which is what the end of a
// film is - or a retained state topic keeps reporting a position for something
// nobody is watching.
function clearMpvMedia() {
  if (!mpvMedia.active) return;
  mpvMedia.active = false;
  mpvMedia.paused = false;
  mpvMedia.position = null;
  mpvMedia.duration = null;
  publishMediaState({ force: true });
}
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
      mpv: mpvMedia,
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
      if (mpvMedia.active && Number.isFinite(pos) && pos >= 0) mpvCmd({ command: ["seek", pos, "absolute"] });
      else if (!Number.isFinite(pos)) console.warn("[mqtt] seek: bad position", cmd && cmd.position);
      break;
    }
    default:
      console.warn("[mqtt] unknown command:", action);
  }
}

ipcMain.on("plog", (_e, p, a) => console.log("[plog]", p, redact(a))); // debug: raw player.* calls from an app

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
    if (mpv && currentAppId !== m.id) {
      playingUrl = null;
      stopMpv();
      setVideoMode(false);
      emit({ type: "finished" });
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
ipcMain.on("kbd:focus", (e, field) => {
  const id = windowAppId(e.sender) || popupAppId(e.sender);
  if (!id || id !== currentAppId) return;
  textinput.focused(id, e.sender, field || {});
});

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
    mpvOwnerId = appIdForSender(e.sender);
    if (mpv && playingUrl === queued.url && !mpvPip) {
      if (mpvStartPending) {
        // Still in the paused-start handshake: the mode switch starts it in a
        // moment. Unpausing here would put the switch INSIDE playback.
        console.log("[player] play during the start handshake - letting it finish");
      } else {
        console.log("[player] resume (already loaded)");
        mpvCmd({ command: ["set_property", "pause", false] });
      }
    } else if (queued.url) {
      playingUrl = queued.url;
      setVideoMode(false);
      ensureAudio(() => launchMpv(queued.url, queued.startPos, false, null, queued.streams));
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
  } else if (action === "select") {
    // Mid-playback version of the queue's `streams`, in the SAME ordinal terms
    // (`track` above speaks mpv track ids, which an app that never saw the track
    // list can't produce). Remembered as well as applied: going to PiP and back
    // RELAUNCHES mpv from `queued.streams`, so a selection only sent to the live
    // player would be quietly undone by the next toggle. Merged per axis - a
    // call that changes only the subtitle must not clear the audio choice.
    for (const command of playeropts.streamCommands(payload)) mpvCmd({ command });
    queued.streams = playeropts.mergeStreams(queued.streams, payload);
  } else if (action === "prop") {
    // One allowlisted playback property (subtitle/audio sync, speed, volume,
    // subtitle look). A refusal is reported, not swallowed: an app that gets
    // "ok" for a setting that never landed has no way to notice.
    const v = playeropts.propValue(payload.name, payload.value);
    if (v === null) return { ok: false, error: "property not allowed or value out of range" };
    mpvCmd({ command: ["set_property", payload.name, v] });
  } else if (action === "pip") {
    // Toggle the current channel between a PiP (at the launcher-measured rect) and
    // fullscreen. PiP needs the window transparent (so mpv behind shows through the
    // hole); fullscreen starts opaque and observeMpv reveals on the first frame.
    if (playingUrl) {
      setVideoMode(!!payload.on);
      ensureAudio(() => launchMpv(playingUrl, 0, !!payload.on, payload.rect, queued.streams));
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
  pairing.register("backup", backupPairing);
  pairing.register("text", require("./pairing/text"));
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
  setHdr(false);
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
  stopMpv();
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
