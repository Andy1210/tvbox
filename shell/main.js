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

const crashlog = require("./crashlog"); // the uncaught-exception handler + its log
const bridges = require("./bridgefifo"); // the two uinput bridges' control FIFOs

// Registered BEFORE the rest of the requires, because a module that throws while
// it loads is the failure shape this repo has actually had (a value built at
// module level out of a const declared further down the file, read in its
// temporal dead zone). `supervisor` is reached through a closure for the same
// reason it always was: a crash during load leaves it in its own dead zone, and
// the handler's try is what covers that.
crashlog.install({
  stopServices: () => supervisor.stopAll(),
  exit: (code) => app.exit(code),
});
const config = require("./config");
const pairing = require("./pairing");
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
// The compositor build from which `type_text` REPLACES a field rather than appending
// to it - before this its select-all chord went out without its modifier, so the
// chord's own `a` landed in the field as a character. The typing screen only offers
// a field's existing text back to the user when the running compositor is at least
// this, or that offer would be submitted twice.
const TYPING_REPLACES_MIN_COMPOSITOR = "0.1.10";
// One answer, read by both halves of the typing path - what we ASK the compositor
// for and what we OFFER the user have to agree, or the keyboard opens on text that
// delivery will not replace.
const deliveryReplaces = () => compositor.atLeast(TYPING_REPLACES_MIN_COMPOSITOR);
const lang = require("./lang"); // what language a remote web app is told it runs in
// what a launch may carry: a remote app's url query, a local app's search words
const launchurl = require("./launchurl");
const { withLaunchQuery } = launchurl;
const audio = require("./audio"); // wpctl sink list + volume (device audio settings)
const bluetooth = require("./bluetooth"); // bluetoothctl pair/connect (audio + input devices)
const mqttBridge = require("./mqtt"); // MQTT: now-playing publish + command/notify (HA integration)
const mediastate = require("./mediastate"); // mpv + app now-playing + sink -> ONE player state (HA media_player)
const ir = require("./ir"); // IR blaster hub: TV volume/mute over ESPHome or Home Assistant
const appwins = require("./appwindows"); // background-apps window registry + hidden-set policy (LRU/RAM guard)
const nativeapp = require("./native"); // native (non-Electron) apps: RetroArch et al own the screen AND the input
const fileserver = require("./fileserver"); // the box's folders over WebDAV (rclone, no root)
const appshares = require("./appshares"); // folders an app declares, read-only, to another box
const peers = require("./peers"); // the other box: found, paired with, pulled from
const peerPairing = require("./pairing/peer"); // hands a peer the token for those shares
const photoshare = require("./photoshare"); // photos a phone cast at the viewer
const phoneremote = require("./phoneremote"); // a phone acting as the remote, on the LAN
const shares = require("./shares"); // network shares (SMB over rclone, no root), mounted per config
const miracast = require("./miracast"); // screen mirroring: the unprivileged half of a Wi-Fi Display sink
const remotefinder = require("./remotefinder"); // make a lost remote ring (Remote Pro's buzzer)
const diag = require("./diag"); // what this box says about itself to the fleet (version, rollback, link, heat)
const apps = require("./install"); // manifests + install-recipe runner (shared with the tvbox CLI)
const appfetch = require("./appfetch"); // capability: scoped server-side fetch (data proxy), origin-locked + SSRF-guarded
const netguard = require("./netguard"); // shared loopback/LAN/public host classification + lanIp
const appdata = require("./appdata"); // capability: per-app key/value storage under ~/.tvbox/appdata
const updater = require("./updater"); // OTA self-update (versions/ + `current` symlink flip)
const boothealth = require("./boothealth"); // "this boot reached the launcher" - the root-side safe-mode counter reads it
const backup = require("./backup"); // encrypted settings backup/restore (phone pairing page)
const backupPairing = require("./pairing/backup");
const identity = require("./identity"); // per-box identity (hostname, derived device names)
const { Supervisor } = require("./service_supervisor"); // generic supervised child procs (plugins use it)
const pkg = require("./package.json"); // shell version (About/diagnostics)

// The shell's own decisions, each in a file of its own. Nothing in the test suite
// can load THIS file - it requires electron - so a rule that lives here cannot be
// checked at all; one that lives in a module beside it can.
const appinfo = require("./appinfo"); // what the shell knows about an installed app
const cards = require("./widgets"); // the cards on the HOME screen
const getroutes = require("./getroutes"); // the box's read API
const mediapublish = require("./mediapublish"); // the box as one media_player, on the wire
const notify = require("./notify"); // the note that appears over everything
const playerapi = require("./playerapi"); // what an app's page may do to the shared mpv
const plugins = require("./plugins"); // the plugin registry + loader
const powermenu = require("./powermenu"); // the power menu and the sleep timer
const remotepolicy = require("./remotepolicy"); // where a remote web app may go
const sharing = require("./sharing"); // the box's folders, an app's folders, the other box
const tvcommand = require("./tvcommand"); // a command that arrived from outside the box

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
// The app to return to when the screensaver it asked for is dismissed (see
// showAmbient, far below). Declared up here because setForegroundApp clears it,
// and a `let` further down the file would be in its temporal dead zone for any
// call that happens before this module finishes loading.
let ambientReturnApp = null;

// The compositor cannot work out which of the launcher and an app owns the screen:
// both are windows of this process. It needs to know, because the remote's Back
// key is rewritten for an app (the app UIs only act on Backspace) and left alone
// for the launcher, which handles the browser key itself.
function setForegroundApp(id) {
  currentAppId = id;
  // Whatever moved the screen, the app the screensaver would go back to is no
  // longer a promise worth keeping: the person went somewhere themselves.
  ambientReturnApp = null;
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
// Electron takes a window's Wayland title from the page's own <title>, and the
// compositor reads that title to decide which window is the note - the one drawn
// over everything, including over the note itself, and left out of keyboard focus.
// With an app fullscreen the launcher's own toplevel has been torn down, so a page
// that took that name would leave nothing on screen for the remote to reach.
//
// Wired for every window this process creates rather than at each `new
// BrowserWindow`, because the windows a PAGE opens are not created here: a remote
// app's sign-in popup arrives through `did-create-window`, and `window.open` from
// the launcher or a local app makes one with no call site of ours at all. Those are
// exactly the windows this has to cover. The rule itself is notify.js's, which owns
// the name; the note's own window sets its title deliberately rather than taking one
// from a page, and refuses every update besides.
app.on("browser-window-created", (_event, w) => {
  // A window can be BORN holding the name as well as renamed into it, and only one
  // of the two raises an event to refuse: `window.open`'s feature string reaches the
  // BrowserWindow constructor unfiltered - `title=` included - and a page that never
  // sets a document title never fires a title update at all.
  w.on("page-title-updated", (e, title) => {
    if (!notify.titleAllowed(title)) e.preventDefault();
  });
  // So the other door is shut where it is opened. A window a page opens is not
  // constructed by us, and what a window-open handler returns outranks the feature
  // string the page wrote - so this is the one place the name can be kept from ever
  // being applied. Taking it off the window afterwards is not an alternative:
  // measured, this event fires before the constructor's own title reaches the native
  // window, so a strip here is written over, and one late enough to stick would also
  // take the name off the note, which is the one window entitled to it. Every window
  // the shell constructs is the shell's to name, so nothing else needs a rule.
  //
  // A window that gets a handler of its own later - a remote app's, which also
  // decides which URLs a popup may go to - replaces this one, and names the option
  // too.
  w.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { title: app.getName() },
  }));
});
let nowPlaying = null; // last launcher-reported now-playing (Spotify/Live TV) - gates auto-update idleness
let restoredAt = null; // a backup restore just ran; the launcher polls this to show "restarting"
// The box counts as idle for a self-initiated restart (nightly auto-update)
// only when nothing is on screen or audible: no mpv, launcher focused, and the
// last now-playing report isn't "playing" (librespot audio has no mpv process
// to look at). HIDDEN app windows don't block idleness - they're muted/paused,
// and the restart simply drops them (they reload on next launch).
function boxIdle() {
  // A PAUSED audio-only player does not count. Sound outlives leaving an app now
  // (`soundOutlivesTheScreen`), so pausing an album and pressing Home used to
  // leave mpv loaded for ever - and with it the box permanently "in use", which
  // gates the sleep timer and the nightly update. Nothing is coming out of the
  // speakers and nobody is watching anything; that is idle.
  const playerBusy = player.running() && !(player.isAudioOnly() && player.media.paused);
  return !playerBusy && !currentAppId && !(nowPlaying && nowPlaying.state === "playing");
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
// resolve; it gets a scoped `host` API (built further down) and never touches
// shell internals. The registries an unload has to reach - the plugin objects,
// their routes, their config listeners - live in plugins.js.
const supervisor = new Supervisor(); // shared supervised-child manager for plugins

// ---- the box's folders, an app's folders, and the other box ----
// Copying a screensaver image onto the box, or a console BIOS into the folder an
// emulator reads, is not something a TV can do - and should not need ssh. Which
// folders are offered, what gets served, and the lifecycle of the credential two
// boxes pair on are all sharing.js's; this is what it cannot know by itself.
sharing.init({
  config,
  apps,
  appshares,
  fileserver,
  shares,
  peers,
  identity,
  supervisor,
  // PATH matters here (rclone lands in ~/.tvbox/bin, which install.js prepends);
  // the Wayland vars do not - these serve files, they draw nothing.
  childEnv: () => ({ ...process.env }),
  // rclone is a ~20MB download, so it runs out of process like every other
  // no-root binary install - the UI polls the status for `rclone`.
  installDeps: (done) => {
    const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "fileserver-deps"], {
      env: { ...process.env, ...WL_ENV, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
    });
    child.on("error", done);
    child.on("exit", done);
  },
});

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
  sendToLauncher("tvbox-nav", { dest });
}

// Everything the launcher hears goes through here: a send into a window that has
// gone, or one whose renderer died between the check and the call, must never be
// the thing that takes the shell down.
function sendToLauncher(channel, ...args) {
  if (!win || win.isDestroyed()) return false;
  try {
    // Spread rather than one `payload`: `apps-changed` carries nothing, and
    // forwarding an explicit `undefined` hands the renderer an argument its
    // listener never used to be given.
    win.webContents.send(channel, ...args);
    return true;
  } catch (e) {
    return false;
  }
}

// ---- what the shell knows about an installed app ----
// The install-recipe runner lives in install.js (shared with the `tvbox` CLI) and
// the decisions taken about a manifest - is it launchable, what is a switch set
// to, which capabilities it was granted, where its bridge adapter is - in
// appinfo.js. What is here is the live state those read.
appinfo.init({
  apps,
  config,
  maintenance,
  isPluginLoaded: (id) => plugins.isLoaded(id),
  hasWindow: (id) => !!appwins.get(id),
  nativeAppId: () => nativeapp.id(),
  foregroundId: () => currentAppId,
});
const { appTiles, mediaSources, capsFor, rootWebApp, transparentSelectorFor, bridgePath } = appinfo;

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
      notify.handleTvNotify({ kind: "lowBattery", name: d.name, battery: d.battery });
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

// Power menu actions from Home, and the sleep timer behind them. Why reboot works
// without root, and why `--no-ask-password` is load-bearing, are in powermenu.js.
powermenu.init({
  jsonRes: httpserver.jsonRes,
  boxIdle,
  showLauncher,
  // Sleep means sleep. `showLauncher` deliberately lets sound outlive a screen
  // change, which is right for Home and wrong for this: measured, Power -> Sleep
  // turned the television off and left the album playing into a dark room.
  stopPlayback: () => {
    player.setPlaying(null);
    player.stop();
    setVideoMode(false);
  },
  cecPower: bridges.cecPower,
});

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
    applyAppshares: sharing.applyAppshares,
    adoptShareKey: sharing.adoptShareKey,
    revokeShareKey: sharing.revokeShareKey,
    appsharesStatus: () => appshares.status(config.rawAppshares(), sharing.appsharesDeps()),
    applyFileserver: sharing.applyFileserver,
    applyMqttConfig: mediapublish.applyConfig,
    publishIrDiscovery: mediapublish.publishIrDiscovery,
    irFailed: tvcommand.irFailed,
    audioSink: () => audioSink,
    childEnv: () => ({ ...process.env, ...WL_ENV }),
    destroyAppWindow,
    // For the two paths that REMOVE an app rather than tear its window down: an
    // app that is no longer installed cannot still be playing, so its retained
    // now-playing claim has to go with it. Deliberately not part of
    // destroyAppWindow, which a crashed renderer also reaches - a plugin's daemon
    // outlives that, and `boxIdle` reads the claim to know it is playing.
    clearNowPlaying: clearNowPlayingFor,
    // Uninstalling an app has to stop its plugin: only the plugin can release what
    // it holds (a daemon, a socket on the LAN), and the app's switch disappears from
    // Settings at the same moment - leaving no way to turn it off.
    unloadPlugin: plugins.unload,
    dmode,
    emitConfigChange: plugins.emitConfigChange,
    // The audio route re-runs the sink detection and answers with what it picked,
    // so it needs both halves.
    ensureAudio,
    exitApp,
    fileserverStatus: () => fileserver.status(config.rawFileserver(), sharing.fileserverDeps()),
    applyShares: sharing.applyShares,
    sharesDeps: sharing.sharesDeps(),
    sharesStatus: () => shares.status(config.rawShares(), sharing.sharesDeps()),
    mirroring,
    foregroundApp: () => currentAppId,
    handlePower: powermenu.handlePower,
    installRclone: () => sharing.installRclone() || sharing.isInstallingRclone(),
    navTo,
    // The launcher's own navigation, for the destinations navTo does not own.
    // This path does not go through setForegroundApp (the launcher is already the
    // window on screen), so the screensaver's promise to go back to an app has to
    // be dropped here: somebody pressing Home while it is up means Home, not "and
    // then back into Spotify on the next key".
    navToLauncher: (dest) => {
      ambientReturnApp = null;
      sendToLauncher("tvbox-nav", { dest });
    },
    publishMediaState: mediapublish.publish,
    publishNowPlaying: mediapublish.publishNowPlaying,
    remoteBridgeCmd: bridges.remoteBridgeCmd,
    setNowPlaying: (data) => {
      nowPlaying = data;
      cards.soundWidget(data);
    },
    setSleepTimer: powermenu.setSleepTimer,
    setWidget: cards.setWidget,
    showLauncher,
    switchApp,
    // The same on-screen note MQTT can push, reachable locally: the voice
    // satellite is a separate process on this box and an answer belongs on the
    // TV, but a spoken one interrupts a film in a way a toast does not.
    notify: notify.handleTvNotify,
  };

  // The same for the read API. Everything else a GET needs, getroutes.js requires
  // directly - the split is the one routes.js already draws.
  const getCtx = {
    childEnv: () => ({ ...process.env, ...WL_ENV }),
    dmode,
    mirroring,
    restoredAt: () => restoredAt,
    readBridgeJson,
    sleepTimer: powermenu.sleepTimer,
    widgetList: cards.widgetList,
    appTiles,
    rootWebApp,
    launcherDir: LAUNCHER,
  };

  // A handler that threw AFTER sending its headers cannot be answered again, and
  // writeHead would throw a second time - inside a catch, where nothing is left to
  // catch it, i.e. a route bug would restart the television. Ending the response is
  // what matters either way: without it the caller waits out its own timeout.
  const endWith500 = (res) => {
    try {
      if (!res.headersSent) res.writeHead(500);
    } catch (e) {}
    try {
      res.end();
    } catch (e) {}
  };

  const server = http.createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch (e) {
      // malformed percent-escape (e.g. "GET /%") throws URIError; without this
      // guard one bad URL from any local client would take the shell down (into a
      // restart now, rather than the frozen dialog it used to be - neither is an
      // answer to a bad request).
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad request");
      return;
    }
    // Which plugin route, if any, this GET would reach. Resolved before the gate
    // because the gate consults it, and reused when dispatching.
    const pluginGet = req.method === "GET" ? httpserver.resolvePluginRoute(plugins.routes(), "GET", p) : null;
    // Same-origin gate for everything state-changing: every non-GET (the POST
    // API + plugin POST routes) plus the GETs that have side effects
    // (getroutes.guardedGet says which, and why) - and whatever a plugin
    // declared, for the same reason: only the plugin knows which of its own reads
    // cost something. ONE resolution of the plugin route, reused below to
    // dispatch: asking twice would let the gate be decided against one route and
    // the request served by another.
    const guardedGet = getroutes.guardedGet(p) || !!(pluginGet && pluginGet.guarded);
    if ((req.method !== "GET" || guardedGet) && httpserver.foreignOrigin(req, OWN_ORIGINS)) {
      // Both headers: the whole new class of refusals - a cross-site GET a page
      // made on our behalf - carries NO Origin at all, so logging only that told
      // an app author their request came "from undefined".
      console.warn(
        "[main] rejected cross-origin",
        req.method,
        p,
        "origin=" + (req.headers.origin || "(none)"),
        "sec-fetch-site=" + (req.headers["sec-fetch-site"] || "(none)"),
      );
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
        const route = httpserver.matchPluginRoute(plugins.routes(), "POST", p);
        if (route) {
          try {
            route(req, res, { body: d });
          } catch (e) {
            endWith500(res);
          }
          return;
        }
        // Wrapped like the plugin dispatch above it: every local app shares this
        // origin, so a route that throws is a "restart the television" primitive
        // reachable from any page on the box. A 500 is the honest answer instead.
        try {
          routes.post(p, d, res, routeCtx);
        } catch (e) {
          console.warn("[api] route failed:", p, redact(e.message));
          endWith500(res);
        }
      });
      return;
    }
    // plugin-registered GET routes (e.g. all of Spotify's) take precedence
    if (pluginGet) {
      try {
        pluginGet.fn(req, res, {});
      } catch (e) {
        endWith500(res);
      }
      return;
    }
    // The read API, then the files. Same wrapper as the two dispatches above, and
    // for the same reason: a GET that throws is reachable from any page the box
    // loads.
    try {
      if (getroutes.get(p, req, res, getCtx)) return;
      getroutes.serveFallback(p, res, getCtx);
    } catch (e) {
      console.warn("[api] read route failed:", p, redact(e.message));
      endWith500(res);
    }
  });
  // A restart races the dying instance for the port (the session's respawn loop
  // restarts us within ~1s; the old process may not have released :PORT yet). Without a handler
  // EADDRINUSE is an uncaught exception, which now restarts the shell into the
  // same race - so retry until the port frees up instead.
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
/**
 * Whether what is loaded may keep playing now that the screen is changing.
 *
 * Sound may; a picture may not, and the difference is what the person in the
 * room sees. A film playing behind the launcher is the box lying about what it
 * is showing - so leaving stops it, as it always has. Music is not the screen:
 * walking away while an album plays is a thing people do on purpose, and
 * stopping it here is what made this box's media client the one music player on
 * it you could not leave.
 *
 * It asks nothing about WHICH app is leaving, deliberately. Ownership is not
 * what a screen change decides: an owner test kept the music through Home and
 * then killed it the moment any other app was opened, and killed it again when
 * Home was pressed from an app that was not the one playing. What ends music is
 * something else claiming the player - the next `play` replaces it - or the
 * owning app being quit, which is handled where a window is destroyed.
 */
function soundOutlivesTheScreen() {
  return player.running() && player.isAudioOnly();
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
  if (!soundOutlivesTheScreen()) {
    player.setPlaying(null);
    player.stop();
    setVideoMode(false);
  }
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
  for (const id of appwins.visibleIds()) if (id !== leaving) backgroundApp(id);
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
/**
 * An app's window has gone - by request, by eviction, or by crashing.
 *
 * Its sound goes with it, and so does its card. Music outlives leaving an app
 * now, so the page that owns the queue is the only thing that can move it on or
 * stop it: without this a dropped window leaves mpv playing (or paused, with a
 * phone's Resume reaching nothing) and HOME naming a track nobody can reach.
 */
function appWindowGone(id) {
  if (id == null) return;
  // Was the shared player OURS for this app? Then stopping it below really does
  // end the sound, and the claim has to go with it - which is not true of a
  // plugin's own daemon (librespot), the case `clearNowPlayingFor` is kept off
  // this path for: `boxIdle` reads the claim to know Spotify is playing, and
  // clearing it here would let the box sleep the television mid-song.
  const oursWasPlaying = player.owner() === id && player.running();
  if (oursWasPlaying) {
    player.setPlaying(null);
    player.stop();
  }
  cards.clearSoundWidget(id);
  if (oursWasPlaying) clearNowPlayingFor(id);
  cards.appsChanged();
}

// The now-playing claim, dropped when the app that made it is QUIT.
//
// Nothing else clears it - it is only ever assigned from an app's POST - so a box
// that has not played anything since it booted still reported the last song of
// the previous session, which is what decided where a forwarded transport command
// went. But it must NOT be cleared by the teardown hook: that fires for the LRU
// cap, the memory guard and a crashed renderer, and a plugin's daemon outlives
// all three (librespot is not mpv). `boxIdle` reads exactly this claim to know
// that Spotify is playing, so clearing it there let the box sleep the television
// mid-song. The deliberate quit is the one place where the sound really has
// stopped, because `pluginAppClosed` has just stopped it.
function clearNowPlayingFor(id) {
  if (!nowPlaying || String(nowPlaying.app || "") !== String(id)) return;
  nowPlaying = null;
  mediapublish.publishNowPlaying({ app: String(id), state: "idle" });
  mediapublish.publish({ force: true });
}

const destroyAppWindow = (id) => {
  dmode.releaseIfHolder(appClaimId(id));
  closePopups(id);
  // The app's sound goes with the app. Music now survives a screen change
  // (`soundOutlivesTheScreen`), so this is the one place left that ends it: the
  // page that owns the queue is gone, so nothing would ever move it to the next
  // track or stop it, and the ✕ in the Running row would leave an album playing
  // out of a box with no way to reach it.
  // The teardown itself is `onDestroyed`, so the cap, the memory guard and a
  // crashed renderer get it too - this call is only one of the ways in.
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
  for (const oid of appwins.visibleIds()) if (oid !== id) backgroundApp(oid);
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
  // A native program is the one place sound does NOT survive: it takes the whole
  // screen, the GPU and the audio device for itself, and a track playing under a
  // game is a mix nobody chose - unlike a launcher or another app's page, which
  // leave the speakers alone.
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
    for (const id of appwins.runningIds()) backgroundApp(id);
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
// Where a remote app may go, what its URL resolves to and which cookies its
// manifest may plant are remotepolicy.js's; this is the one part that needs a
// window system.
//
// Push the current UI language onto an app's session. Called at launch AND on every
// foreground, because the partition is persistent: a language change while the app sat
// in the background would otherwise leave the server seeing the old header forever.
function applyAppLanguage(id) {
  const m = apps.manifestById(id);
  if (!m || (m.runtime || {}).serve !== "remote") return null;
  const rt = m.runtime || {};
  const wanted = remotepolicy.languageFor(rt);
  try {
    const ses = session.fromPartition("persist:remote-" + id);
    ses.setUserAgent(rt.userAgent || ses.getUserAgent(), wanted.accept);
  } catch (e) {
    console.warn("[remote] could not set Accept-Language:", e.message);
  }
  return wanted;
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
  if (!start || !remotepolicy.remoteProtoOk(start)) {
    console.warn("[nav] remote url not allowed:", url);
    return;
  }
  // Language, both channels: the header here (the server's view) and
  // navigator.language in the preload (the page's view). Set on the session, so
  // subresources and the sign-in popup - which share the partition - agree.
  const wanted = applyAppLanguage(m.id) || { tag: "", accept: "" };
  const ses = session.fromPartition("persist:remote-" + m.id);
  const hosts = remotepolicy.allowedRemoteHosts(rt, url);
  // Cookies the manifest asks for, held to the app's declared origins by
  // remotepolicy.js. Set before the first load, since the point is to influence
  // the first response.
  const wantedCookies = remotepolicy.cookiesFor(rt, hosts, wanted.tag);
  for (const c of wantedCookies.skipped) {
    console.warn("[remote] cookie skipped (host not in origins):", c.url, c.name);
  }
  const cookieJobs = wantedCookies.set.map((c) =>
    ses.cookies.set(c).catch((e) => console.warn("[remote] cookie failed:", c.name, e.message)),
  );
  const allowed = (u) => remotepolicy.navigationAllowed(u, hosts);
  // Sound survives here too. Measured, and it was the one thing that made the
  // rule look arbitrary from the sofa: opening a LOCAL app left the music
  // playing (stopPrevPlayback asks), opening a REMOTE one killed it, because
  // this stop asks nobody.
  if (!soundOutlivesTheScreen()) {
    player.stop();
    setVideoMode(false); // no mpv behind a remote app; drop any prior session
  }
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
        title: app.getName(), // outranks a `title=` the page put in its feature string
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
    // The page a cast paired with went with the window, so the mark is stale: kept, it
    // would spend itself on a clean reload of a page nobody cast to, losing where the
    // person had got to for no reason.
    castLaunched.delete(thisAppId);
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
  for (const oid of appwins.visibleIds()) if (oid !== m.id) backgroundApp(oid);
  if (win && !win.isDestroyed()) win.hide();
}

// Apps whose live page was last loaded with launch data from a cast. Emptied by the
// next ordinary launch of that app, which reloads it clean first: the page a phone
// paired with keeps its session, so it must not be what a person finds when they
// open the app themselves.
const castLaunched = new Set();

// A cast is a request to watch something, and the box may have turned the panel off
// itself (the sleep timer, the screensaver's auto-sleep). Without this the phone
// reports a connected television while the room stays dark. Sent only for a cast:
// an ordinary launch happens because somebody is already looking at the screen, and
// "on" also moves some TVs to this input.
//
// The exception is the person who just turned the television OFF - the same guard the
// player's one-touch wake keeps, because an automatic action must not fight them.
// (What this cannot do is change the input: the CEC bridge only re-asserts active
// source while the TV is already routed to us, deliberately, so a cast to a set
// showing a console opens YouTube on an input nobody is looking at.)
const CAST_WAKE_AFTER_STANDBY_MS = 30 * 1000;
function wakePanelForCast() {
  if (player.msSinceTvStandby() <= CAST_WAKE_AFTER_STANDBY_MS) {
    console.log("[cec] not waking for a cast: the TV was just put on standby");
    return;
  }
  bridges.cecPower(true);
}

// Point an ALREADY OPEN remote app at its launch url. Only a cast needs this: the
// window is kept across leaving an app (background apps), so the page a phone
// connects to would otherwise be the one from the previous session.
//
// The url is rebuilt from the manifest and re-checked against the same protocol
// and host rules openRemoteApp applies, rather than trusted because it was built
// here - `withLaunchQuery` is what keeps a sender's parameters parameters, and this
// is the assertion that nothing else moved.
function reloadRemoteApp(m, query) {
  const rt = m.runtime || {};
  if (m.type !== "webclient" || rt.serve !== "remote") return false;
  const w = appWindow(m.id);
  if (!w || w.isDestroyed()) return false;
  const url = withLaunchQuery(remotepolicy.resolveRemoteUrl(m), query);
  // Re-checked against the same protocol and host rules openRemoteApp applies -
  // one that is not a URL at all fails the same test.
  if (!remotepolicy.navigationAllowed(url, remotepolicy.allowedRemoteHosts(rt, url))) {
    console.warn("[nav] relaunch url not allowed:", url);
    return false;
  }
  console.log("[nav] relaunch", m.id, "with launch data");
  w.loadURL(url, rt.userAgent ? { userAgent: rt.userAgent } : undefined);
  return true;
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
    // The page a cast paired with went with the window, so the mark is stale: kept, it
    // would spend itself on a clean reload of a page nobody cast to, losing where the
    // person had got to for no reason.
    castLaunched.delete(thisAppId);
    leftForeground(thisAppId);
    if (appwins.get(thisAppId) === w) appwins.destroy(thisAppId);
    if (currentAppId === thisAppId) showLauncher();
  });
  const atRoot = rt.mount === "root";
  w.loadURL(BASE + (atRoot ? "/" : "/" + m.id + "/"));
  w.focus();
  w.moveTop();
  for (const oid of appwins.visibleIds()) if (oid !== m.id) backgroundApp(oid);
  if (win && !win.isDestroyed()) win.hide();
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
// Everything outside the box that wants to know "what is this TV doing" asks one
// question, so there is one answer (mediapublish.js), and a command that arrives
// the other way is routed by tvcommand.js. Both are given the shell's own state
// and its windows here; neither of them knows what a BrowserWindow is.
mediapublish.init({
  mqtt: mqttBridge,
  mediastate,
  audio,
  diag,
  identity,
  config,
  system,
  updater,
  player,
  version: pkg.version || "",
  childEnv: () => ({ ...process.env, ...WL_ENV }),
  nowPlaying: () => nowPlaying,
  currentApp: () => currentAppId,
  sources: mediaSources,
  soundWidget: cards.soundWidget,
  onNotify: notify.handleTvNotify,
  onCommand: (cmd) => tvcommand.handle(cmd),
  // What the blaster can send becomes a Home Assistant button each, so anything there -
  // a dashboard, an automation, a voice assistant - can reach a TV input or a soundbar
  // without knowing this box's MQTT topics.
  irActions: () => ir.status().actions,
});

tvcommand.init({
  player,
  ir,
  cecActiveSource: bridges.cecActiveSource,
  notify: notify.handleTvNotify,
  remotefinder,
  mediastate,
  apps,
  launchurl,
  nowPlaying: () => nowPlaying,
  currentApp: () => currentAppId,
  appWindow,
  launcherWebContents: () => (win && !win.isDestroyed() ? win.webContents : null),
  nativeRunning: () => nativeapp.running(),
  navTo,
  showLauncher,
  cecPower: bridges.cecPower,
  setVideoMode,
  setBoxVolume: mediapublish.setBoxVolume,
});

ipcMain.on("plog", (_e, p, a) => console.log("[plog]", p, redact(a))); // debug: raw player.* calls from an app
// The note has finished fading out. Hiding it is the shell's job, not the page's:
// a window it cannot hide is a surface the compositor still has to deal with.
ipcMain.on("overlay-done", (e) => notify.overlayDone(e.sender));

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
// `opts.query` is a per-launch query string for a REMOTE webclient - a plugin
// handing the app the launch data that came with a cast (see withLaunchQuery). It
// is ignored for every other kind of app, because there is nothing to put it on.
function navTo(dest, opts) {
  console.log("[nav]", dest);
  if (dest === "home") {
    showLauncher();
    return true;
  }
  const m = apps.manifestById(dest);
  if (!m || m.status !== "ready") return false;
  const launchQuery = (opts && opts.query) || "";
  // Switching apps silences the one being replaced: its UI is going to the
  // background, and a plugin foregrounding its app on a cast (Spotify Connect)
  // must stop e.g. the IPTV stream it takes over from. Called only on paths
  // that WILL navigate - an unconfigured remote app must not cost the current
  // stream (review F3).
  const stopPrevPlayback = () => {
    if (player.running() && currentAppId !== m.id && !soundOutlivesTheScreen()) {
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
    // A cast carries a session of its own (a fresh pairing code), so resuming the
    // live page is not enough here: the page has to be pointed at the launch url,
    // or the phone stays connected to nothing.
    //
    // Every other launch keeps the live page - EXCEPT the first one after a cast.
    // The kept page is still joined to whoever cast last, so somebody opening the
    // app from HOME would land in a stranger's session, and that session would go
    // on seeing and steering what the television plays.
    if (launchQuery) {
      // The reload IS the cast here: without it the page stays on the previous
      // session, so a caller told "opened" would have a phone connected to somebody
      // else's queue. It can refuse (launch data this app cannot be given), and then
      // nothing about this launch happened.
      if (!reloadRemoteApp(m, launchQuery)) return false;
      castLaunched.add(m.id);
      wakePanelForCast();
    } else if (castLaunched.delete(m.id)) {
      reloadRemoteApp(m, "");
    }
    return true;
  }
  if (m.type === "native") {
    // Its own fullscreen Wayland client, not a page. stopPrevPlayback is folded
    // into openNativeApp: it stops the shared player before handing over the screen.
    openNativeApp(m);
    return true;
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
      const url = withLaunchQuery(remotepolicy.resolveRemoteUrl(m), launchQuery);
      if (url) {
        stopPrevPlayback();
        openRemoteApp(m, url);
        if (launchQuery) {
          castLaunched.add(m.id);
          wakePanelForCast();
        }
        return true;
      }
      // An unset config-driven url, or launch data this app cannot be given. The
      // caller is told, because a cast that opened nothing must not be reported to
      // the phone as a television now showing something.
      console.warn("[nav] remote app not opened:", m.id);
      return false;
    }
    // local bundle -> its own privileged window with the full preload.js SDK
    // (player/fetch/storage/onCommand/onNotify + bridge). A PACKAGE app
    // (serve:"local") serves its own web/ at /<id>/; the legacy single
    // root-mounted bundle (serve:"static", mount:"root", e.g. Plex) is at /.
    // Curated apps run privileged (review is the trust boundary).
    stopPrevPlayback();
    openLocalApp(m);
    return true;
  }
  // (No builtin branch: every app is a webclient package now - either a local
  // web/ bundle served at /<id>/ or a remote site - handled above.)
  return false;
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
  plugins.appClosed(id);
  clearNowPlayingFor(id);
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

// ---- the screensaver, asked for by the app on screen ----
// The ambient screen belongs to the launcher, and the launcher's window is hidden
// whenever an app is in front (exactly one visible toplevel). So the screensaver
// cannot arm behind an app - which is right while the app has something to show,
// and wrong for an app that has nothing: Spotify sitting on "nothing is playing"
// is a static screen the box will hold all night. Such an app asks, and the shell
// brings the launcher forward with the ambient screen on, remembering where to go
// back to. Any key there returns to the app, which was hidden rather than closed,
// so it comes back as it was.
//
// No capability of its own: this is worth what tvbox.home() is worth, and every
// app already has that. What it must not do is fire for an app that is not the
// one on screen, or a background app's timer would take the person out of
// whatever they are actually watching.
function ambientEnabled() {
  const c = config.publicConfig();
  return !!(c && c.ambient && c.ambient.enabled);
}
function showAmbient(fromApp) {
  if (!win || win.isDestroyed()) return false;
  if (!fromApp || fromApp !== currentAppId) return false;
  // Everything showLauncher would take away on the way to a clock. The screen is
  // not the only thing an app can have going: it ENDS a native program (an app
  // that launches one keeps its own hidden window and stays `currentAppId` the
  // whole game), stops the shared player, and mutes the window it hides along
  // with any media playing inside it. So an app is only allowed to ask when
  // nothing of that is running - which is the same rule the app itself is
  // supposed to apply, enforced where it cannot be forgotten.
  if (nativeForeground || nativeapp.running()) return false;
  // A PICTURE is what the launcher would take away; sound is not. Audio-only
  // playback already survives showLauncher (`soundOutlivesTheScreen`), so a
  // paused song on a media player's screen is exactly the still picture this
  // exists for - refusing it left the one screen that can sit there for an hour
  // as the only one the screensaver could not reach. Whether it is worth asking
  // over PLAYING music is the app's decision, not ours: it knows if its own
  // screen is the thing to look at.
  if ((player.running() && !soundOutlivesTheScreen()) || mirrorOnScreen) return false;
  if (!ambientEnabled()) return false;
  showLauncher(); // hides the app's window, and clears ambientReturnApp
  ambientReturnApp = fromApp;
  try {
    win.webContents.send("tvbox-nav", { dest: "ambient" });
  } catch (e) {}
  return true;
}
// Back to the app that asked. A no-op when nothing asked, so the launcher can
// call it on every ambient exit without knowing which kind it was.
//
// The app is re-checked rather than trusted: minutes can pass on that screen, and
// an app can be uninstalled, disabled, or have its window dropped by the RAM
// guard in the meantime. navTo says nothing at all for an id it cannot open, so
// without this the key that dismissed the screensaver would appear to do nothing.
// A dropped window is not that case - navTo reopens the app, from the start
// rather than where it was.
function ambientDone() {
  const id = ambientReturnApp;
  ambientReturnApp = null;
  if (!id) return;
  const m = apps.manifestById(id);
  if (m && m.status === "ready") navTo(id);
  else console.log("[nav] ambient: nothing to go back to (" + id + ")");
}
ipcMain.on("ambient", (e, action) => {
  if (action === "request") showAmbient(windowAppId(e.sender));
  else if (action === "done" && windowAppId(e.sender) === null) ambientDone(); // the launcher only
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

// ---- capability: an app's own shares, and bringing them from another box ----
// The box owns the boundary and the app owns the screen. What an app may offer is
// its manifest's business and switching it on is a person's, in Settings - an app
// package is trusted Node code in the host process, so "the app asks nicely" would
// not be a boundary at all. What belongs to the app is the ACTION: it knows what a
// save is, when someone would want one, and how to say so.
//
// Everything here is therefore scoped to the sender's own app id. It can see the
// boxes this one has paired with and its OWN shares, and it can pull its OWN
// share; another app's is not in the list and is refused if named. The
// destination is never sent - pullAppshare resolves it from the local manifest,
// because a path from a renderer is a path somebody else chose.
ipcMain.handle("app:shares", (e, action, payload) => {
  const id = appIdForSender(e.sender);
  if (!id || !capsFor(id).includes("shares")) return { ok: false, error: "no shares capability" };
  return sharing.appSharesCall(id, action, payload);
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

// Which window is asking decides everything (playerapi.js has the rules): the
// SENDER's own app id, never the global foreground one.
ipcMain.handle("player", (e, action, payload) => playerapi.handle(windowAppId(e.sender), action, payload));

// ---- the cards on the HOME screen ----
// A plugin's own card and the derived one an app gets while its sound plays are
// both widgets.js's; what it needs from here is the launcher and the player.
cards.init({
  send: sendToLauncher,
  playerRunning: () => player.running(),
  playerIsAudioOnly: () => player.isAudioOnly(),
  playerOwner: () => player.owner(),
});

// ---- plugin host API ----
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
  navTo, // (id, {query}) -> open an app by id (a plugin foregrounds its app on a cast)
  // Is that app alive, and is it the one on screen? A plugin that answers a
  // protocol on the LAN has to report its app's state - DIAL asks a receiver
  // whether the app is running before it launches it - and only the shell knows.
  appState: (id) => ({ running: appinfo.appRunning(id), foreground: id === currentAppId }),
  // One note on screen, for anyone on the box: the same toast MQTT pushes and the
  // voice satellite uses for a spoken answer's text. A plugin gets it here; a
  // local app's page can POST /tvbox/api/notify, which is the same door.
  notify: (n) => notify.handleTvNotify(notify.sanitize(n)),
  // Both of these are re-bound per app by the loader, which is what lets an unload
  // take the plugin's listeners and routes with it. Called on the bare host (no
  // app), a registration belongs to nothing and is never removed.
  onConfigChange: plugins.onConfigChange,
  // Register a plugin's HTTP routes under a path prefix. `table` is keyed
  // "METHOD /subpath" (e.g. "GET /state"); the generic server tries these before
  // its own built-in routes. Called from a plugin factory (before serve()).
  // `guard` names the GET routes in `table` that the same-origin gate must cover.
  registerRoutes: plugins.registerRoutes,
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

plugins.init({ apps, host, setWidget: cards.setWidget, switchValue: appinfo.switchValue });

// The three that need a window system, or the shell state around one. Grouped
// here, at the end of the module body, because every const and function they name
// is initialized by this point - the temporal dead zone is what has killed this
// file before.
notify.init({
  BrowserWindow,
  screen,
  compositor,
  sendToLauncher,
  raiseWindow,
});

remotepolicy.init({
  config,
  lang,
  netguard,
  systemLocale: () => app.getSystemLocale(),
});

playerapi.init({
  player,
  capsFor,
  currentApp: () => currentAppId,
  appWindow,
  setVideoMode,
  ensureAudio,
  clearSoundWidget: cards.clearSoundWidget,
});

// Everything the shell holds on behalf of something else, on the way out. The
// supervised children and the file server are the shell's own rather than a
// plugin's, so they are stopped here rather than inside the plugin registry.
function stopPlugins() {
  plugins.stopAll();
  supervisor.stopAll();
  // The IR hub's firetv backend holds a BLE link to the household's remote through a
  // child of its own. A leftover keeps the remote's ONE allowed connection, so the next
  // shell's link can never be established and every blast answers "asleep".
  ir.shutdown();
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
    // Reap an mpv left by a previous run. The pattern is the OPTION, not the
    // socket file name: the socket carries a per-launch sequence number now
    // (`/tmp/tvbox-mpv-15.sock`), so the old `tvbox-mpv.sock` matched nothing
    // and every restart left its player running. Invisible while leaving an app
    // stopped playback anyway; audible the moment sound was allowed to outlive
    // the screen - measured on the box, two orphans playing two different
    // tracks at once over a third that had just been cast.
    // `-f --` before the pattern: it starts with dashes and pkill's own option
    // parser eats it otherwise - measured on the box, the call exited 2 with a
    // usage message and killed nothing at all.
    execFile("pkill", ["-9", "-f", "--", "--input-ipc-server=/tmp/tvbox-mpv"], () => {});
  } catch (e) {}
  apps.loadManifests();
  // Core pairing kinds (box features). App-specific kinds (iptv, spotify,
  // keyboard) are registered by their package plugin's factory via
  // host.pairing.register - they ship in the app package, not the shell.
  pairing.register("photos", require("./pairing/photos"));
  pairing.register("photoshare", require("./pairing/photoshare"));
  pairing.register("backup", backupPairing);
  pairing.register("text", require("./pairing/text"));
  // The one pairing kind whose client is another box rather than a phone. It reads
  // the token straight from the config, so the credential exists in exactly one
  // place and a share turned off between the code appearing and the peer asking
  // takes the answer with it.
  peerPairing.init({
    remember: sharing.rememberPeer,
    issue: sharing.issueShareKey,
  });
  pairing.register("peer", peerPairing);
  // A phone acting as the remote. The FIFO write goes ONLY to the remote bridge:
  // the CEC one forwards what it does not recognise to cec-client's stdin, so a
  // key would arrive there as a CEC command.
  phoneremote.init({
    press: bridges.remoteKey,
    lanIp: () => netguard.lanIp(),
    rawPhoneRemote: config.rawPhoneRemote,
    setPhoneRemote: config.setPhoneRemote,
  });
  try {
    phoneremote.apply(); // off unless the setting says otherwise
  } catch (e) {
    console.warn("[phoneremote] start:", e.message);
  }

  // Whatever a previous session was showing outlived the TV being switched off.
  // The viewer empties this when it closes; boot is what covers everything else.
  // Wrapped because this runs during startup, where an exception does not fail a
  // feature - it fails the shell, and the respawn loop then does it again.
  try {
    photoshare.sweep();
  } catch (e) {
    console.warn("[photoshare] boot sweep:", e.message);
  }
  // Adding a share is the one form here where every field is somebody else's
  // string - an address, a share name, a password - so it gets a phone page too.
  const sharesPairing = require("./pairing/shares");
  sharesPairing.init({ apply: sharing.applyShares, deps: sharing.sharesDeps });
  pairing.register("shares", sharesPairing);
  // Typing for a keyboard-less app. The screen belongs to the launcher (it owns the
  // on-screen keyboard and can draw a QR), so the app is backgrounded for the
  // duration - its page keeps its state AND the focused field, and the text is sent
  // as keystrokes once it's back in front.
  // Read once here rather than on the first focused field: the answer decides
  // whether that field's text is offered back, and a cold read would spend the
  // first typing session of the session answering "no".
  compositor.refreshVersion();
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
    //
    // Asking for the select-all is the SAME decision as offering the field's text
    // back, so both read one answer. Before tvbox-wc 0.1.10 the chord went out
    // without its modifier, which did not merely fail to replace: its own `a`
    // landed in the field as a character, in front of everything the user typed.
    // So on such a box we do not ask for it at all - delivery appends, which is
    // what it effectively did anyway, and an empty field (the sign-in case this
    // was reported from) gets exactly what was typed instead of an `a` and then
    // what was typed.
    typeText: (text) => compositor.typeText(text, { selectAll: deliveryReplaces() }),
    // ...and the same answer decides whether the keyboard may open ON the field's
    // own text: where typing appends, offering it back would submit it twice.
    canReplace: deliveryReplaces,
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
  plugins.loadAll(); // require plugins + register their routes (deps-gated)
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
    noticeCrash();
  });
  // One line on the first launcher load after a crash, and then never again.
  //
  // Nothing else on the television says anything: the log is truncated at every
  // start, the crash file needs ssh and the diagnostics report needs the card. So a
  // crash during a film is indistinguishable from the box quitting films by itself,
  // which is the reading a household would take from it.
  //
  // The note is sent a moment AFTER the load, because the renderer subscribes to it
  // as it mounts and a send at did-finish-load would arrive at nobody. The marker is
  // removed first: a note is worth less than a loop of them.
  function noticeCrash() {
    if (!crashlog.takeNotice()) return;
    setTimeout(() => notify.handleTvNotify({ kind: "crashRestart" }), crashlog.CRASH_NOTICE_DELAY_MS);
  }

  // Background-apps policy hooks (registry lives in appwindows.js).
  appwins.init({
    enabled: () => {
      const a = config.rawApps();
      return !(a && a.background === false);
    },
    memInfo: system.memInfo,
    foregroundId: () => currentAppId,
    // Only while something is actually loaded: `owner` is not cleared when the
    // player stops, so asking it alone would spare an app for the rest of the
    // box's life because it once played a song.
    // PLAYING, not merely loaded: an app that pauses a track would otherwise be
    // immune to the cap and to the memory guard for as long as it liked.
    playingId: () => (player.running() && !player.media.paused ? player.owner() : null),
    onDestroyed: appWindowGone,
  });
  setInterval(() => appwins.ramGuardTick(), 60 * 1000); // evict hidden apps under memory pressure
  nativeapp.init({
    childEnv: () => ({ ...process.env, ...WL_ENV }), // the session's Wayland vars, same as mpv gets
    bridgeCmd: bridges.bridgesCmd, // "native on" / "native off" to both uinput bridges
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
  if (config.rawFileserver().enabled) sharing.applyFileserver(); // the LAN share survives a restart
  sharing.pruneOrphanShareKeys(); // before the server starts, so a stray key is never served
  if ((config.rawAppshares().enabled || []).length) sharing.applyAppshares(); // and so do an app's
  if (config.rawShares().length) sharing.applyShares(); // and so do the shares the box reads FROM
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
  ensureAudio(() => plugins.startAll());
  // MQTT bridge (now-playing publish + HA integration); no-op if not provisioned.
  // (The command handler is added by the voice-control work.)
  mediapublish.applyConfig();
  // A rename changes which MQTT topics the box belongs on, so the bridge has to
  // reconnect with it.
  system.init({ onHostnameChanged: mediapublish.applyConfig });
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
      // And whoever OWNS the player, which is often neither of those: music
      // outlives leaving the app now, so the page that has to hear a track end,
      // move the queue on, and report where it is, is usually hidden. Without it
      // an album stopped after its first track with nobody looking, the position
      // a phone draws froze where the app last saw it, and the box went on
      // claiming to play something that had finished - all measured on the box.
      // NOT gated on the player still running: the event that matters most here
      // is `finished`, and it fires at the moment mpv has gone - so asking
      // whether the player is up would drop exactly the one the queue needs.
      // Measured: with the gate, an album in the background ended after one
      // track. `owner` is reassigned by every play, so a stale one is narrow.
      const owner = appWindow(player.owner());
      for (const w of new Set([win, fg, owner])) {
        if (w && !w.isDestroyed()) {
          try {
            w.webContents.send("player-event", ev);
          } catch (e) {}
        }
      }
    },
    setVideoMode,
    raiseWindow,
    cecPower: bridges.cecPower,
    publishMediaState: mediapublish.publish,
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
    hotLoadPlugin: plugins.hotLoad,
    applyPendingAppFiles: (opts) => backup.applyPendingAppFiles(opts),
    jsonRes: httpserver.jsonRes,
    childEnv: () => ({ ...process.env, ...WL_ENV }),
  });
  ir.applyConfig(); // IR blaster hub; no-op if not configured
  // The MQTT bridge came up above, before the blaster had read its config - so the
  // discovery it published carried no IR buttons. Restate them now that there is
  // something to say. (Only the retained topics from a previous run kept the buttons
  // alive at all, which meant a box configured by hand never got them until somebody
  // opened Settings and saved.)
  mediapublish.publishIrDiscovery();
  // Keep the media state topic honest about which app is in front and how loud the
  // box is; both are cheap and neither is urgent (see mediapublish.js's ticks).
  mediapublish.startTicks();
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
  bridges.bridgesCmd("native off");
  stopPlugins();
  mqttBridge.stop();
  app.quit();
}

app.on("window-all-closed", shutdown);

// Quit gracefully on signals so localStorage (app logins) flushes and we don't
// leave an orphaned process holding port 8097 across a restart.
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
