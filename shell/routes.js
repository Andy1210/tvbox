// The box's write API: every POST route, in one place.
//
// This is the surface that changes something - config, apps, power, pairing, the
// remote's keymap - so it is also where the validation lives, and why it is worth
// having on its own rather than spread through the shell's wiring. A route that
// only reads is a GET and stays with the server in main.js.
//
// Everything the shell can do that this needs arrives as `ctx`: windows, app
// switching, the config-change fan-out, the MQTT bridge. Modules with no shell
// state in them are required directly.
const ambient = require("./ambient");
const audio = require("./audio");
const backup = require("./backup");
const backupPairing = require("./pairing/backup");
const bluetooth = require("./bluetooth");
const config = require("./config");
const firetvir = require("./firetvir");
const httpserver = require("./httpserver");
const ir = require("./ir");
const maintenance = require("./maintenance");
const apps = require("./install");
const pairing = require("./pairing");
const phoneremote = require("./phoneremote"); // a phone acting as the remote, on the LAN
const photoshare = require("./photoshare"); // photos a phone cast at the viewer
const removable = require("./removable"); // the USB stick: mount on open, unmount before it is pulled
const shares = require("./shares"); // network shares (SMB over rclone)
const store = require("./store");
const system = require("./system");
const textinput = require("./textinput");
const updater = require("./updater");
const wifiradio = require("./wifiradio");

// `udisksctl` is what mounts a stick, and it is not on every box (udisks2 is a soft
// dep and OTA can never add an apt package), so removable.js asks before it runs.
const browseDeps = { onPath: apps.onPath };

function post(p, data, res, ctx) {
  // The body is whatever the caller sent, and a literal `null` is valid JSON. Every
  // route below reads a field off `data` straight away, so one such request would
  // throw a TypeError with nothing above it to catch: no try/catch around the
  // handler, no `uncaughtException` behind it, and the shell dies. Normalize once.
  if (!data || typeof data !== "object") data = {};
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
      ctx.applyMqttConfig(); // reconnect the bridge to the new broker right away
      changed.push("mqtt");
    }
    if (data.remote) {
      config.setRemote(data.remote); // per-device button remap (sanitized in config.js)
      ctx.remoteBridgeCmd("reload"); // tell the bridge to re-read the keymap
      changed.push("remote");
    }
    if (data.ir) {
      config.setIr(data.ir); // IR blaster backend + action map (sanitized in config.js)
      ir.applyConfig(); // reconnect the backend right away
      ctx.remoteBridgeCmd("reload"); // the bridge re-reads whether volume keys go to IR
      changed.push("ir");
    }
    if (data.apps) {
      config.setApps(data.apps); // background-apps toggle (whitelisted in config.js)
      changed.push("apps");
    }
    ctx.emitConfigChange(changed); // e.g. Live TV drops its channel/EPG cache on a new IPTV source
    return httpserver.jsonRes(res, { ok: true, config: config.publicConfig() });
  }
  if (p === "/tvbox/api/ui/locale") {
    // The launcher owns the UI language (its i18n store is in the renderer); it
    // mirrors it here so the shell can hand it to things the renderer can't reach:
    // the phone pairing pages and every remote web app's language.
    // Only write when it actually changed: the launcher mirrors on every page load,
    // and ctx.showLauncher(hash) reloads it - so this would rewrite config.json each time
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
    ctx.dmode.rearm();
    return ctx.dmode.refresh((ok, err) =>
      httpserver.jsonRes(res, ok ? { ok: true } : { ok: false, error: err || "failed" }),
    );
  }
  if (p === "/tvbox/api/audio/default") {
    // persist the override (empty string clears it -> back to auto), then re-apply
    config.setAudio({ sink: String(data.sink || "") });
    return ctx.ensureAudio(() => httpserver.jsonRes(res, { ok: true, sink: ctx.audioSink() }));
  }
  if (p === "/tvbox/api/audio/volume") {
    return audio.setVolume(ctx.childEnv(), Number(data.id), Number(data.volume), (ok) =>
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
  // Screen mirroring, armed and disarmed by hand. There is no "leave it on"
  // setting on purpose: a group owner beacons continuously, holds a radio this
  // board shares with Bluetooth, and its pairing button is open to whoever
  // presses it - so it is a thing you switch on to use, like an input on a TV.
  if (p === "/tvbox/api/miracast/start") {
    return ctx.mirroring.start((err, st) =>
      httpserver.jsonRes(
        res,
        err ? { ok: false, error: String((err && err.message) || err) } : { ok: true, name: (st && st.name) || "" },
      ),
    );
  }
  if (p === "/tvbox/api/miracast/stop") {
    // A stop that failed leaves the radio taken and the box possibly offline,
    // which is the last thing to report as success.
    return ctx.mirroring.stop((err) =>
      httpserver.jsonRes(res, err ? { ok: false, error: String((err && err.message) || err) } : { ok: true }),
    );
  }
  if (p === "/tvbox/api/notify") {
    // The on-screen note, for a caller ON this box (the voice satellite). MQTT's
    // notify topic reaches the same place; this is the local door, and the HTTP
    // server only listens on loopback. Capped rather than trusted: the launcher
    // draws whatever arrives, and an answer from a language model is not a length
    // anyone has promised.
    ctx.notify({
      title: String(data.title || "").slice(0, 120),
      message: String(data.message || "").slice(0, 400),
      duration: Math.max(0, Math.min(60000, Number(data.duration) || 0)),
      raise: !!data.raise,
    });
    return httpserver.jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/nav") {
    // Any navigation ends a typing session: with ctx.foregroundApp() === null (the typing
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
      ctx.navTo(id);
      return httpserver.jsonRes(res, { ok: true, dest, app: id });
    }
    if (dest === "switch") {
      ctx.switchApp(); // cycle through running apps (the appswitcher remap action)
      return httpserver.jsonRes(res, { ok: true, dest, app: ctx.foregroundApp() });
    }
    if (dest !== "home" && dest !== "settings")
      return httpserver.jsonRes(res, { ok: false, error: "unknown dest: " + dest });
    if (ctx.foregroundApp() !== null) ctx.showLauncher(dest === "settings" ? "#settings" : "");
    else ctx.navToLauncher(dest);
    return httpserver.jsonRes(res, { ok: true, dest });
  }
  if (p === "/tvbox/api/apps/quit") {
    // HOME's running-apps row: really exit an app (its window and page state are
    // dropped; next launch is a fresh start). Same teardown an app's own "Exit?"
    // dialog gets - one implementation, so both can't drift.
    const id = String(data.id || "");
    if (!ctx.appIsRunning(id)) return httpserver.jsonRes(res, { ok: false, error: "not running" });
    ctx.exitApp(id);
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
    ctx.setNowPlaying(data);
    ctx.publishNowPlaying(data);
    ctx.publishMediaState({ force: true }); // the metadata changed: always news
    return httpserver.jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/update/check") {
    updater.check().then(
      (s) => httpserver.jsonRes(res, s),
      // A feed that cannot be reached must answer the Settings screen, not leave
      // the request open until the client gives up.
      (e) => httpserver.jsonRes(res, { ...updater.status(), error: String((e && e.message) || e) }),
    );
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
    return ctx.handlePower(String(data.action || ""), res);
  }
  if (p === "/tvbox/api/ambient/photos/clear") {
    return httpserver.jsonRes(res, { ok: true, removed: ambient.clearPhotos() });
  }
  if (p === "/tvbox/api/ambient/photos/delete") {
    return httpserver.jsonRes(res, { ok: ambient.deletePhoto(String(data.name || "")) });
  }
  if (p === "/tvbox/api/bt/scan") {
    return bluetooth.scan(ctx.childEnv(), Number(data.seconds) || 8, (devices) => httpserver.jsonRes(res, { devices }));
  }
  if (p.startsWith("/tvbox/api/bt/")) {
    const action = p.slice("/tvbox/api/bt/".length);
    const actions = {
      pair: bluetooth.pair,
      // Same pairing with the wifi radio held down for the attempt - the escape
      // hatch for a BLE remote that will not bond while the shared antenna is busy.
      "pair-quiet": bluetooth.pairQuiet,
      connect: bluetooth.connect,
      disconnect: bluetooth.disconnect,
      remove: bluetooth.remove,
    };
    // `action` is a path segment, so the lookup must not reach what every object
    // inherits: `__proto__` answers with a truthy value that cannot be called, and
    // `constructor` with one that can. Own properties only.
    const fn = Object.hasOwn(actions, action) ? actions[action] : null;
    const mac = String(data.mac || "").toUpperCase();
    if (!fn) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) return httpserver.jsonRes(res, { ok: false, error: "bad mac" });
    return fn(ctx.childEnv(), mac, (r) => httpserver.jsonRes(res, r));
  }
  if (p === "/tvbox/api/remote/learn") {
    // Enter learn mode for a device: the bridge captures & reports the next
    // button pressed on it (id may contain spaces -> rest-of-line in the FIFO).
    const id = String((data && data.id) || "").replace(/[\r\n]/g, "");
    if (!id) return httpserver.jsonRes(res, { ok: false, error: "no id" });
    ctx.remoteBridgeCmd("learn " + id);
    return httpserver.jsonRes(res, { ok: true });
  }
  if (p === "/tvbox/api/remote/learn-off") {
    ctx.remoteBridgeCmd("learn-off");
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
    ctx.remoteBridgeCmd("reload");
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
    if (ctx.foregroundApp() === id) ctx.showLauncher();
    ctx.destroyAppWindow(id); // a background window must not outlive its app
    ctx.setWidget(id, null);
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
    const r = ctx.applyFileserver();
    return httpserver.jsonRes(res, {
      ok: !!r.ok,
      error: r.error || null,
      status: ctx.fileserverStatus(),
    });
  }
  if (p === "/tvbox/api/fileserver/install-rclone") {
    return httpserver.jsonRes(res, { ok: true, installing: ctx.installRclone() });
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
    if (ctx.foregroundApp() === id) ctx.showLauncher(); // never yank the bundle out from under the running app
    ctx.destroyAppWindow(id); // incl. a hidden background window
    return httpserver.jsonRes(res, { ok: true, removed: apps.removeApp(id) });
  }
  if (p === "/tvbox/api/wifi/connect") {
    return system.wifiConnect(String(data.ssid || ""), String(data.password || ""), !!data.hidden, (r) =>
      httpserver.jsonRes(res, r),
    );
  }
  if (p === "/tvbox/api/power/sleep-timer") {
    return httpserver.jsonRes(res, ctx.setSleepTimer(data.minutes)); // 0/absent = cancel
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
      wifiradio.setRadio(ctx.childEnv(), on, (ok) => {
        if (ok) config.setWifi({ radio: on });
        httpserver.jsonRes(res, { ok, radio: on, ethernet: eth });
      });
    });
  }
  // A USB stick is mounted when someone opens it on the TV and unmounted from the
  // same screen before it is pulled out - nothing on this box auto-mounts. The
  // device string is checked against what is actually plugged in before it reaches
  // a command line (removable.js), so this route cannot name an arbitrary one.
  if (p === "/tvbox/api/browse/mount") {
    return removable.mount(browseDeps, String(data.device || ""), (r) => httpserver.jsonRes(res, r));
  }
  if (p === "/tvbox/api/browse/unmount") {
    return removable.unmount(browseDeps, String(data.device || ""), (r) => httpserver.jsonRes(res, r));
  }
  // The phone remote. Turning it on is what opens the LAN listener at all, so the
  // toggle and the socket are the same decision - `apply` is not a hint.
  if (p === "/tvbox/api/phoneremote/enable") {
    // Coerced once and reused, so the stored value, the forget and the answer
    // can never disagree about what was asked for.
    const on = !!data.enabled;
    config.setPhoneRemote({ enabled: on });
    if (!on) phoneremote.forgetAll(); // off means the paired phones go too
    phoneremote.apply();
    return httpserver.jsonRes(res, { ok: true, enabled: on, phones: phoneremote.list() });
  }
  // Show a code on the TV so a phone can be adopted. Returns what the QR carries.
  if (p === "/tvbox/api/phoneremote/arm") {
    // Async now: it waits for the socket to bind before it can say where the
    // phone should go.
    return phoneremote.arm((info) =>
      httpserver.jsonRes(res, info ? { ok: true, ...info } : { ok: false, error: "unavailable" }),
    );
  }
  if (p === "/tvbox/api/phoneremote/disarm") {
    phoneremote.disarm();
    return httpserver.jsonRes(res, { ok: true, phones: phoneremote.list() });
  }
  // Letting a paired phone SEE the screen. Separate from the remote on purpose,
  // and it carries its own clock: `minutes` of 0 turns it off now.
  if (p === "/tvbox/api/phoneremote/screen") {
    const until = phoneremote.shareScreen(data.minutes);
    return httpserver.jsonRes(res, { ok: true, until, on: phoneremote.screenOn() });
  }
  if (p === "/tvbox/api/phoneremote/forget") {
    const ok = phoneremote.forget(String(data.id || ""));
    return httpserver.jsonRes(res, { ok, phones: phoneremote.list() });
  }
  // Developer tools. Everything here is for someone working ON the box, which is
  // why it is one screen behind its own door rather than options scattered
  // through Settings.
  //
  // The DevTools endpoint is arbitrary code in the launcher window, and that
  // window has Node in its preload - so it reaches config.json and everything in
  // it. deploy/run-shell.sh consumes this marker on the next start and deletes
  // it, which is what keeps it to ONE boot: a forgotten `touch` surviving every
  // reboot would be a back door with nothing on the TV to show for it.
  if (p === "/tvbox/api/devtools/debugport") {
    return maintenance.setDebugPort(Number(data.port) || 0, (r) => httpserver.jsonRes(res, r));
  }
  // The viewer, saying it is done with the photos a phone cast at it. This is the
  // ordinary way the session ends; the sweep at boot is only for the times the TV
  // was switched off instead.
  if (p === "/tvbox/api/photoshare/clear") {
    return httpserver.jsonRes(res, { ok: true, removed: photoshare.clear() });
  }
  // Network shares (SMB over rclone). The password follows the same contract as
  // every other credential form here: omitted keeps the stored one, "" clears it -
  // a guest share with no password is legitimate, so the two cannot both be falsy.
  // `name` is the mount point and therefore the identity; `original` says which
  // share an edit is editing, so renaming one is not adding a second.
  if (p === "/tvbox/api/shares/save") {
    const list = config.rawShares();
    const original = String(data.original || "");
    const stored = list.find((s) => s.name === original);
    let share;
    try {
      share = shares.shareFrom(data, stored);
    } catch (e) {
      return httpserver.jsonRes(res, { ok: false, error: e.message || "bad_request" });
    }
    const others = list.filter((s) => s.name !== original);
    if (others.some((s) => s.name === share.name)) {
      return httpserver.jsonRes(res, { ok: false, error: "name_taken" });
    }
    if (others.length >= shares.MAX_SHARES) return httpserver.jsonRes(res, { ok: false, error: "too_many" });
    config.setShares([...others, share]);
    ctx.applyShares();
    return httpserver.jsonRes(res, { ok: true, status: ctx.sharesStatus() });
  }
  if (p === "/tvbox/api/shares/remove") {
    const name = String(data.name || "");
    config.setShares(config.rawShares().filter((s) => s.name !== name));
    ctx.applyShares(); // stops the mount that is no longer wanted
    return httpserver.jsonRes(res, { ok: true, status: ctx.sharesStatus() });
  }
  // Try the credentials without mounting anything, and answer with what is there:
  // the shares a server offers (no share name yet) or the folders inside one, so
  // the form can be used to find where the films actually are.
  if (p === "/tvbox/api/shares/test") {
    const stored = config.rawShares().find((s) => s.name === String(data.original || ""));
    if (!data.share) {
      return shares.listShares({ ...data, storedPass: stored && stored.pass }, ctx.sharesDeps, (r) =>
        httpserver.jsonRes(res, r),
      );
    }
    let share;
    try {
      share = shares.shareFrom(data, stored);
    } catch (e) {
      return httpserver.jsonRes(res, { ok: false, error: e.message || "bad_request" });
    }
    return shares.test(share, ctx.sharesDeps, (r) => httpserver.jsonRes(res, r));
  }
  if (p === "/tvbox/api/system/timezone") {
    return system.setTimezone(String(data.timezone || ""), (r) => httpserver.jsonRes(res, r));
  }
  if (p === "/tvbox/api/system/keymap") {
    // Two writes, and both are needed. localectl changes it for the session that
    // is running; the config copy is what survives a reboot, because localed on
    // this image persists nothing (see config.setKeyboard). A box that has not
    // been provisioned since this landed still gets the session behaviour.
    const layout = String(data.keymap || "");
    return system.setKeymap(layout, (r) => {
      // Only a layout the system ACCEPTED is written down. The stored copy is
      // what a root unit re-applies at every boot, so persisting one localectl
      // rejected would hand the next boot a keyboard nobody can type on.
      const stored = r && r.ok ? config.setKeyboard({ layout }) : null;
      httpserver.jsonRes(res, { ...r, stored: !!stored });
    });
  }
  if (p === "/tvbox/api/system/hostname") {
    return system.setHostname(String(data.hostname || ""), (r) => httpserver.jsonRes(res, r));
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

module.exports = { post };
