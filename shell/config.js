// tvbox config store. Shell-owned ~/.tvbox/config.json (Pi-local, never
// committed, chmod 600 - may hold IPTV credentials). The launcher reads a
// SECRET-FREE view via GET /tvbox/api/config and writes via POST; the parental
// PIN is stored hashed and verified server-side so the renderer never sees it.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const identity = require("./identity"); // per-box identity: hostname-derived device names

const FILE = path.join(os.homedir(), ".tvbox", "config.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    return {};
  }
}
function save(cfg) {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // enforce perms on every write (mode only applies at creation, and masks by umask)
  try {
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(FILE, 0o600);
  } catch (e) {
    /* best effort */
  }
}
function sha(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function timingEq(aHex, bHex) {
  const a = Buffer.from(String(aHex || ""), "hex"),
    b = Buffer.from(String(bHex || ""), "hex");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function iptvConfigured(iptv) {
  if (!iptv || !iptv.mode) return false;
  if (iptv.mode === "xtream") return !!(iptv.xtream && iptv.xtream.base && iptv.xtream.user);
  if (iptv.mode === "m3u") return !!(iptv.m3u && iptv.m3u.url);
  return false;
}

// Secret-free view for the launcher (no passwords, no PIN hash).
function publicConfig() {
  const c = load();
  const iptv = c.iptv || {};
  return {
    iptv: {
      mode: iptv.mode || null,
      xtream: iptv.xtream ? { base: iptv.xtream.base || "", user: iptv.xtream.user || "" } : null,
      m3u: iptv.m3u ? { url: iptv.m3u.url || "", epgUrl: iptv.m3u.epgUrl || "" } : null,
      configured: iptvConfigured(iptv),
    },
    setup: { done: !!(c.setup && c.setup.done) },
    parental: {
      pinSet: !!(c.parental && c.parental.pinHash),
      lockedGroups: (c.parental && c.parental.lockedGroups) || [],
      requirePin: !!(c.parental && c.parental.requirePin), // gate installs/sensitive settings in the UI
    },
    spotify: {
      // The derived default, not "": two boxes cloned from one backup would
      // otherwise both show the same (or no) name in the Connect picker, where
      // they are then indistinguishable. identity.js owns the derivation.
      deviceName: (c.spotify && c.spotify.deviceName) || identity.defaultSpotifyName(),
      hasCredentials: !!(c.spotify && c.spotify.clientId && c.spotify.clientSecret),
      // Spotify Connect is opt-in: the librespot daemon (which advertises the
      // box on the LAN) runs only once enabled, even though the binary now ships
      // in the image. Default off - this is "installed" for the built-in app.
      enabled: !!(c.spotify && c.spotify.enabled),
    },
    audio: {
      sink: (c.audio && c.audio.sink) || null, // manual default-sink override (node.name); null = auto-detect
    },
    player: {
      // preferred track languages for the shared mpv player ("" = stream default)
      audioLang: (c.player && c.player.audioLang) || "",
      subLang: (c.player && c.player.subLang) || "",
    },
    ambient: {
      enabled: !(c.ambient && c.ambient.enabled === false), // default on
      idleMinutes: (c.ambient && c.ambient.idleMinutes) || 5,
      city: (c.ambient && c.ambient.city) || "",
      sleepMinutes: (c.ambient && c.ambient.sleepMinutes) || 0, // 0 = never; N = CEC TV-off after N min on the screensaver
      bing: !!(c.ambient && c.ambient.bing), // mix Bing's daily wallpapers into the slideshow (opt-in)
    },
    mqtt: {
      // secret-free: never expose the broker password to the launcher
      configured: !!(c.mqtt && c.mqtt.host && c.mqtt.username),
      host: (c.mqtt && c.mqtt.host) || "",
      port: (c.mqtt && c.mqtt.port) || null, // null = the default (1883)
      username: (c.mqtt && c.mqtt.username) || "",
      hasPassword: !!(c.mqtt && c.mqtt.password), // whether one is stored, never the value
      // The id the bridge ACTUALLY uses, derived from the hostname when unset -
      // it is the topic segment every message travels under, so showing "" here
      // would hide the one field that must differ between two boxes.
      deviceId: (c.mqtt && c.mqtt.deviceId) || identity.defaultDeviceId(),
    },
    phoneRemote: {
      // Off until someone turns it on - this is the one surface that injects
      // keys into whatever is on screen. The paired phones themselves come from
      // /tvbox/api/phoneremote, never from here: a token hash has no business in
      // the config the launcher reads.
      enabled: !!(c.phoneRemote && c.phoneRemote.enabled),
      paired: Array.isArray(c.phoneRemote && c.phoneRemote.phones) ? c.phoneRemote.phones.length : 0,
    },
    update: {
      // OTA self-update (updater.js); feed URL itself stays box-local
      auto: !(c.update && c.update.auto === false), // default on
      appsAuto: !(c.update && c.update.appsAuto === false), // nightly registry app updates, default on
    },
    wifi: {
      // Wi-Fi regulatory country (ISO 3166-1 alpha-2). Applied at boot by the
      // root-side tvbox-wifi-country service (the shell has no root); "" = the
      // image default.
      country: (c.wifi && c.wifi.country) || "",
      // On unless the owner turned it off: a box that never touched this setting
      // must keep the radio it came up with.
      radio: !(c.wifi && c.wifi.radio === false),
    },
    bluetooth: {
      // Turn L2CAP Enhanced Retransmission Mode off for ALL Bluetooth links.
      // Default false = the kernel default (ERTM on). Applied by the root-side
      // tvbox-bt-ertm service; see its comment for why this is a toggle and not
      // simply on. Escape-hatch for controllers whose ERTM handling is broken.
      // Strict `=== true`, not a coercion: tvbox-bt-ertm greps config.json for a
      // literal JSON true/false, so anything else there means OFF to the applier -
      // and the row must not claim "on" while the radio is left alone.
      disableErtm: (c.bluetooth && c.bluetooth.disableErtm) === true,
    },
    ui: {
      // launcher preferences. hourFormat: "auto" (locale default) | "12" | "24"
      hourFormat: (c.ui && ["12", "24"].includes(c.ui.hourFormat) && c.ui.hourFormat) || "auto",
      navSounds: !(c.ui && c.ui.navSounds === false), // D-pad ticks, default on
      // The launcher's chosen locale, mirrored here BY the launcher (its i18n store
      // is the source of truth and lives in the renderer). The shell needs it for
      // things the renderer can't do: the phone pairing pages' language, and the
      // language a remote web app is told it's running in (shell/lang.js).
      locale:
        c.ui && typeof c.ui.locale === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(c.ui.locale)
          ? c.ui.locale
          : "",
    },
    remote: {
      // Per-device button remap + Power-button policy, consumed by
      // remote_input_bridge.py. Not a secret - exposed as-is. Default (no
      // entries) = every remote passes through unchanged.
      devices: sanitizeDevices(c.remote && c.remote.devices),
      power: sanitizePower(c.remote && c.remote.power),
    },
    ir: publicIr(c.ir),
    apps: {
      // background apps (appwindows.js): leaving an app hides its window for
      // instant resume; false = the old destroy-on-leave behavior (rollback lever)
      background: !(c.apps && c.apps.background === false),
    },
  };
}

// What the remote's Power button does (mirrors POWER_VALUES in the bridge).
const REMOTE_POWER = ["tv", "tv_and_box", "ignore"];
function sanitizePower(p) {
  return REMOTE_POWER.includes(p) ? p : "tv"; // default: TV off (CEC) only
}

// Actions the remap can bind, mirroring ACTION_KEY in remote_input_bridge.py.
// Codes are evdev keycodes (ints); anything else is dropped - the renderer
// writes this from the shell-reported learn captures.
const REMOTE_ACTIONS = [
  "up",
  "down",
  "left",
  "right",
  "ok",
  "back",
  "home",
  "playpause",
  "stop",
  "rewind",
  "fastforward",
  "prev",
  "next",
  "volume_up",
  "volume_down",
  "mute",
  // special: no key emitted - the bridge acts (TV power toggle / open Settings
  // / cycle running apps)
  "power",
  "settings",
  "appswitcher",
  "back_to_box",
];
// Dynamic app-launch remap actions ("app:<id>" - launch that app). The id
// charset mirrors the bridge's APP_ACTION_RE and the nav endpoint's guard.
const REMOTE_APP_ACTION = /^app:[a-z0-9_-]{1,32}$/;
// One IR action through the blaster ("ir:<name>", IR_ACTIONS below). Mirrors the
// bridge's IR_ACTION_RE. The NAME is deliberately not checked against IR_ACTIONS here:
// the button binding and the blaster's action mapping are edited on different screens,
// and dropping the binding because the mapping is not there yet would lose it silently -
// the bridge reports an unmapped action at press time instead.
const REMOTE_IR_ACTION = /^ir:[a-z0-9_]{1,32}$/;
function sanitizeDevices(devices) {
  const out = {};
  if (!devices || typeof devices !== "object") return out;
  for (const [id, entry] of Object.entries(devices)) {
    if (typeof id !== "string" || !id || id.length > 80 || !entry || typeof entry !== "object") continue;
    const rawkm = entry.keymap && typeof entry.keymap === "object" ? entry.keymap : {};
    const keymap = {};
    for (const a of Object.keys(rawkm)) {
      if (!REMOTE_ACTIONS.includes(a) && !REMOTE_APP_ACTION.test(a) && !REMOTE_IR_ACTION.test(a)) continue;
      if (!Array.isArray(rawkm[a])) continue;
      // 2048 covers real evdev codes (< 0x300) AND the bridge's virtual hidraw
      // bands (0x300 app buttons, 0x400 consumer-report buttons)
      const codes = rawkm[a].filter((c) => Number.isInteger(c) && c >= 0 && c < 2048).slice(0, 6);
      if (codes.length) keymap[a] = codes;
      if (Object.keys(keymap).length >= 32) break; // cap per device
    }
    const name = typeof entry.name === "string" ? entry.name.slice(0, 80) : "";
    // irPassthrough: this remote blasts the TV with its OWN IR (programmed
    // Fire TV remote) - the bridge must not divert its volume keys too.
    const irPassthrough = entry.irPassthrough === true;
    if (Object.keys(keymap).length || name || irPassthrough)
      out[id] = { name, keymap, ...(irPassthrough ? { irPassthrough: true } : {}) };
    if (Object.keys(out).length >= 20) break; // cap
  }
  return out;
}

function setIptv(iptv) {
  const c = load();
  c.iptv = iptv || {};
  save(c);
}

function setParental({ pin, lockedGroups, requirePin }) {
  const c = load();
  c.parental = c.parental || {};
  if (pin !== undefined) {
    if (pin) {
      // salted so equal PINs don't share a hash; empty pin clears it
      c.parental.pinSalt = crypto.randomBytes(16).toString("hex");
      c.parental.pinHash = sha(c.parental.pinSalt + pin);
    } else {
      c.parental.pinHash = null;
      c.parental.pinSalt = null;
    }
  }
  if (lockedGroups !== undefined) c.parental.lockedGroups = Array.isArray(lockedGroups) ? lockedGroups : [];
  if (requirePin !== undefined) c.parental.requirePin = !!requirePin;
  save(c);
}

function verifyPin(pin) {
  const p = load().parental;
  if (!p || !p.pinHash) return false;
  // pre-salt configs stored sha(pin) - still verified; re-saving the PIN upgrades
  const h = p.pinSalt ? sha(p.pinSalt + pin) : sha(pin);
  return timingEq(h, p.pinHash);
}

// Raw IPTV (incl. credentials) for the Live TV provider only.
function rawIptv() {
  const iptv = load().iptv;
  return iptvConfigured(iptv) ? iptv : null;
}

function setSpotify(spotify) {
  const c = load();
  c.spotify = { ...c.spotify, ...spotify };
  // Same rule as setMqtt's deviceId, for the same reason: a name that only echoes
  // this box's derived default is left unset so the derivation stays live and a
  // clone of this box doesn't inherit it as a deliberate choice. See identity.js.
  if (c.spotify.deviceName && c.spotify.deviceName === identity.defaultSpotifyName()) delete c.spotify.deviceName;
  save(c);
}
// Null while Spotify is entirely unconfigured (the daemon is opt-in). Once the
// section exists, the device name is always answered - derived from the hostname
// when the user never chose one, so each box announces itself as itself.
function rawSpotify() {
  const s = load().spotify;
  return s ? { ...s, deviceName: s.deviceName || identity.defaultSpotifyName() } : null;
}

// Manual audio default-sink override (node.name). audio-default.sh honors it if
// the sink is present, else auto-detects; empty/null clears the override.
function setAudio(audio) {
  const c = load();
  c.audio = { ...c.audio, ...audio };
  save(c);
}
function rawAudio() {
  return load().audio || null;
}

// Ambient/screensaver settings (enable, idle timeout, weather city).
function setAmbient(ambient) {
  const c = load();
  c.ambient = { ...c.ambient, ...ambient };
  save(c);
}
function rawAmbient() {
  return load().ambient || null;
}

// MQTT broker connection (host/port/username/password/deviceId) - the full,
// secret-bearing config for the mqtt client. Set from Settings → Network (or by
// hand in config.json); the bridge only starts once host AND username are set.
function rawMqtt() {
  const m = load().mqtt;
  return m && m.host && m.username ? m : null;
}

// MQTT broker settings from the launcher UI. Whitelisted like setUi: only the
// known fields persist, sanitized. An empty host clears the whole section
// (integration off). An empty password keeps the stored one, so re-saving the
// other fields never wipes the secret; a non-empty password replaces it.
function setMqtt(mqtt) {
  const c = load();
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const host = str(mqtt && mqtt.host, 200);
  if (!host) {
    delete c.mqtt;
    save(c);
    return;
  }
  const prev = c.mqtt && typeof c.mqtt === "object" ? c.mqtt : {};
  const port = Number(mqtt && mqtt.port);
  const username = str(mqtt && mqtt.username, 200);
  // the deviceId becomes an MQTT topic segment - keep it topic/discovery-safe
  // (same character class as mqtt.js safeId, so topics match the discovery id)
  let deviceId = str(mqtt && mqtt.deviceId, 200).replace(/[^a-zA-Z0-9_-]/g, "_");
  // A value equal to this box's derived default is NOT stored, and that is
  // load-bearing rather than tidiness. publicConfig reports the derived id so the
  // user can see which topic the box publishes on, and the settings form saves the
  // whole section back - so saving any MQTT field would otherwise freeze today's
  // hostname into an explicit deviceId. A later rename would then keep publishing
  // under the old name, and a clone of that box would read the frozen value as a
  // name its owner chose and inherit it verbatim: two boxes, one topic tree.
  // Leaving it unset keeps the derivation live, and the effective value is the same.
  if (deviceId && deviceId === identity.defaultDeviceId()) deviceId = "";
  const password =
    mqtt && typeof mqtt.password === "string" && mqtt.password ? mqtt.password.slice(0, 200) : prev.password;
  c.mqtt = {
    host,
    ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {}),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(deviceId ? { deviceId } : {}),
  };
  save(c);
}

// Generic reader/writer for a config-driven remote web-app whose URL is stored
// under a named config section as { baseUrl } (declared by the manifest's
// runtime.urlConfig, e.g. a self-hosted Jellyfin). Kept app-agnostic.
function appConfig(key) {
  if (!key || !/^[a-z0-9_]+$/i.test(key)) return null;
  const v = load()[key];
  return v && typeof v === "object" ? v : null;
}
// Onboarding done. Kept here rather than only in the launcher's localStorage,
// which can read empty through no fault of the user (an Electron instance that
// lost Chromium's storage lock) and would then walk a configured box through
// setup again.
function setSetupDone() {
  const c = load();
  // Idempotent: the launcher re-confirms this on a start where its own copy went
  // missing, and `at` has to keep saying when onboarding was FINISHED (it is also a
  // pointless disk write otherwise).
  if (c.setup && c.setup.done) return true;
  c.setup = { done: true, at: Date.now() };
  save(c); // save() throws on a real failure; it has no return value
  return true;
}

// The LAN file server (WebDAV). The password lives here like every other secret -
// config.json is chmod 600 - and never reaches the launcher: it asks
// /tvbox/api/fileserver, which reports whether one is SET, not what it is.
//
// `pass` follows the same rule as the other credential forms: omitted keeps what is
// stored, "" clears it. Clearing it stops the server, since it must not serve
// without one.
function setFileserver(fileserver) {
  const c = load();
  const cur = c.fileserver || {};
  const f = fileserver || {};
  const next = {
    enabled: f.enabled === undefined ? !!cur.enabled : !!f.enabled,
    user: (f.user === undefined ? cur.user : String(f.user).trim()) || "",
    port: Number(f.port === undefined ? cur.port : f.port) || 0,
    folders: Array.isArray(f.folders) ? f.folders.filter((x) => typeof x === "string").slice(0, 64) : cur.folders || [],
    pass: f.pass === undefined ? cur.pass || "" : String(f.pass),
  };
  c.fileserver = next;
  save(c);
  return next;
}
function rawFileserver() {
  return (load() || {}).fileserver || {};
}

// App shares: the folders installed apps declare (appshares.js), offered read-only
// to another box, and the boxes this one has been paired with. Two credentials live
// here, and neither is the user's: `token` is what this box hands a peer, and a
// peer entry carries the one that box handed us. config.json is chmod 600 like the
// rest, and the launcher only ever learns whether a token is set.
//
// `enabled` is the list of share ids that are actually offered - an empty list is
// how the whole thing is off, so there is no second switch to disagree with it.
function peerOk(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.host === "string" &&
    typeof p.token === "string" &&
    // The name that key was minted under. A row from before keys were per box has
    // no user and its token opens nothing, so dropping it is what stops Settings
    // listing a box that can never be read - the release notes say to pair again.
    typeof p.user === "string" &&
    p.user &&
    Number.isInteger(Number(p.port))
  );
}
const appshares = require("./appshares"); // only for the shape of a stored key
// A credential handed out, as it is kept: never the secret itself.
function issuedOk(x) {
  return (
    x &&
    typeof x.id === "string" &&
    x.id &&
    typeof x.user === "string" &&
    /^box-[a-f0-9]{6,32}$/.test(x.user) &&
    typeof x.hash === "string" &&
    // The one place that decides the format is the one that writes the file. A
    // literal here would silently drop every key the day that changes, and a box
    // would lose every peer with nothing in the log to say why.
    x.hash.startsWith(appshares.HASH_PREFIX)
  );
}
function setAppshares(appshares) {
  const c = load();
  const cur = c.appshares || {};
  const a = appshares || {};
  const next = {
    enabled: Array.isArray(a.enabled) ? a.enabled.filter((x) => typeof x === "string").slice(0, 64) : cur.enabled || [],
    port: Number(a.port === undefined ? cur.port : a.port) || 0,
    token: a.token === undefined ? cur.token || "" : String(a.token),
    // Replaced whole, like the share list: a peer is removed by sending the list
    // without it, so there is one way in and one way out. The NEWEST are kept - a
    // full list must not turn the next pairing into one that reports success and
    // stores nothing.
    peers: Array.isArray(a.peers) ? a.peers.filter(peerOk).slice(-8) : cur.peers || [],
    // The other direction: a key this box handed to another one, by its hash.
    // Removing an entry is what makes forgetting a box a revocation.
    issued: Array.isArray(a.issued) ? a.issued.filter(issuedOk).slice(-8) : cur.issued || [],
  };
  c.appshares = next;
  save(c);
  return next;
}
function rawAppshares() {
  return (load() || {}).appshares || {};
}

// Network shares (SMB), the other direction of the same idea: the file server hands
// the box's folders OUT, these bring someone else's IN. Credentials live here for
// the same reason - config.json is chmod 600 - and the launcher only ever learns
// whether a password is set. The list is replaced whole: `name` is the mount point
// and therefore the identity, so shares.js resolves what an edit means before the
// list gets here.
// The keyboard layout picked in Settings. It is ALSO set through localectl for
// the running session, but that is all localed does on this image: Raspberry Pi
// OS ships a drop-in making /etc/X11/xorg.conf.d read-only for it, and localed
// then logs "Failed to write X11 keyboard layout, ignoring" and persists
// nothing - so the pick is gone at the next boot. Keeping it here is what a
// root boot unit re-applies (tvbox-keymap, deploy/provision.sh), the same shape
// as the Wi-Fi regulatory country.
function setKeyboard(kb) {
  const layout = String((kb && kb.layout) || "");
  if (!/^[a-z0-9][a-z0-9,_-]{0,31}$/.test(layout)) return null;
  const c = load();
  c.keyboard = { ...c.keyboard, layout };
  save(c);
  return c.keyboard;
}
function rawKeyboard() {
  return load().keyboard || {};
}

// The phone remote (phoneremote.js): whether the LAN listener runs at all, and
// the adopted phones. Raw because the rows carry a token HASH - publicConfig
// below shows names and times only.
function setPhoneRemote(patch) {
  const c = load();
  c.phoneRemote = { ...c.phoneRemote, ...patch };
  save(c);
  return c.phoneRemote;
}
function rawPhoneRemote() {
  return load().phoneRemote || {};
}

function setShares(shares) {
  const c = load();
  c.shares = (Array.isArray(shares) ? shares : []).slice(0, 32);
  save(c);
  return c.shares;
}
function rawShares() {
  const s = (load() || {}).shares;
  return Array.isArray(s) ? s : [];
}

function setAppConfig(key, val) {
  if (!key || !/^[a-z0-9_]+$/i.test(key)) return false;
  const c = load();
  c[key] = { ...(typeof c[key] === "object" ? c[key] : {}), ...val };
  save(c);
  return true;
}

// On/off switches an app DECLARES in its manifest (`switches`), for an app whose
// own screen cannot hold them - a native app, or a remote site that is not our UI
// (YouTube's own TV page, where the cast receiver has to be turned on somewhere).
//
// They live in one section keyed by app id rather than in a section named after
// the app, because an app id is not a namespace we control: a registry manifest
// with id `update` or `player` would otherwise write the shell's own config
// section. Only booleans, and bounded on both axes, since the writer is a
// manifest.
const MAX_SWITCH_APPS = 64;
const MAX_SWITCHES_PER_APP = 8;
function appSwitches(id) {
  const all = load().appSwitches;
  if (!all || typeof all !== "object") return {};
  if (id === undefined) return all;
  // Own properties only: a lookup for an id that happens to name something every
  // object has would otherwise answer with a function.
  const v = Object.prototype.hasOwnProperty.call(all, id) ? all[id] : null;
  return v && typeof v === "object" ? v : {};
}
// Names that are not properties when assigned to a plain object: `__proto__` sets
// the prototype instead of a key, and the other two are inherited members a lookup
// would answer for a switch nobody declared. Both the app id and the key are object
// keys here, so both are held to this.
const NOT_A_KEY = new Set(["__proto__", "constructor", "prototype"]);
// Forget what an app's switches were set to. Called when the app is uninstalled:
// otherwise a re-install brings a remembered "on" back with nobody pressing
// anything, which for a switch that opens a socket on the LAN is the same surprise
// as a default:true would be.
function clearAppSwitches(id) {
  const c = load();
  if (!c.appSwitches || !Object.prototype.hasOwnProperty.call(c.appSwitches, id)) return false;
  const all = { ...c.appSwitches };
  delete all[id];
  c.appSwitches = all;
  save(c);
  return true;
}
function setAppSwitch(id, key, on) {
  if (!/^[a-z0-9_-]{1,64}$/.test(String(id || "")) || NOT_A_KEY.has(id)) return false;
  if (!/^[a-z0-9_-]{1,32}$/.test(String(key || "")) || NOT_A_KEY.has(key)) return false;
  const c = load();
  const all = c.appSwitches && typeof c.appSwitches === "object" ? { ...c.appSwitches } : {};
  const mine = all[id] && typeof all[id] === "object" ? { ...all[id] } : {};
  if (!(id in all) && Object.keys(all).length >= MAX_SWITCH_APPS) return false;
  if (!(key in mine) && Object.keys(mine).length >= MAX_SWITCHES_PER_APP) return false;
  mine[key] = !!on;
  all[id] = mine;
  c.appSwitches = all;
  save(c);
  return true;
}

// App-store registries: { registry?: "<index.json url>", sources?: [{url, name?}] }.
// `registry` replaces the official tvbox-apps index (store.js) for a self-hoster;
// `sources` are extra registries merged into the same catalogue after it. The cap
// matches store.js's MAX_EXTRA_SOURCES, and the url is only shape-checked here -
// which schemes and hosts are allowed is store.js's call, made when it reads them,
// so a config file edited by hand meets the same rule as this form.
const MAX_STORE_SOURCES = 10;
function setStore(store) {
  const c = load();
  const next = { ...(typeof c.store === "object" && c.store ? c.store : {}) };
  if (store && typeof store.registry === "string") {
    const r = store.registry.trim();
    if (r) next.registry = r;
    else delete next.registry; // "" is how the form hands the official index back
  }
  // Unattended updates from the primary registry. Per added source the same flag
  // lives on its own entry below; store.js owns what each one defaults to.
  if (store && store.autoUpdate !== undefined) next.autoUpdate = store.autoUpdate !== false;
  if (store && Array.isArray(store.sources)) {
    const seen = new Set();
    next.sources = store.sources
      .map((s) => (typeof s === "string" ? { url: s } : s))
      .filter((s) => s && typeof s.url === "string" && s.url.trim())
      .map((s) => {
        const name = typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 60) : null;
        const e = { url: s.url.trim() };
        if (name) e.name = name;
        if (s.autoUpdate === true) e.autoUpdate = true;
        return e;
      })
      .filter((s) => !seen.has(s.url) && seen.add(s.url))
      .slice(0, MAX_STORE_SOURCES);
  }
  c.store = next;
  save(c);
  return next;
}
function rawStore() {
  return load().store || null;
}

// OTA update settings: { auto?: bool, feed?: "<update.json url>" } - feed is a
// self-host override (updater.js ships the GitHub Releases default).
function setUpdate(update) {
  const c = load();
  c.update = { ...c.update, ...update };
  save(c);
}
function rawUpdate() {
  return load().update || null;
}

// Shared-player preferences (mpv --alang/--slang). ISO 639 codes or "".
function setPlayer(player) {
  const c = load();
  const norm = (v) => (typeof v === "string" && /^([a-z]{2,3})?$/.test(v) ? v : undefined);
  const a = norm(player && player.audioLang);
  const su = norm(player && player.subLang);
  c.player = {
    ...c.player,
    ...(a !== undefined ? { audioLang: a } : {}),
    ...(su !== undefined ? { subLang: su } : {}),
  };
  save(c);
}
function rawPlayer() {
  return load().player || null;
}

// Wi-Fi regulatory country - two uppercase letters or "" (clear).
function setWifi(wifi) {
  const c = load();
  const cc = wifi && typeof wifi.country === "string" ? wifi.country.toUpperCase() : undefined;
  if (cc !== undefined && /^([A-Z]{2})?$/.test(cc)) c.wifi = { ...c.wifi, country: cc };
  // A REAL boolean only - this takes parsed JSON off the HTTP API, and coercing
  // would let the string "false" turn the radio off (same rule as setBluetooth).
  if (wifi && typeof wifi.radio === "boolean") c.wifi = { ...c.wifi, radio: wifi.radio };
  save(c);
}
function rawWifi() {
  return load().wifi || null;
}

// Bluetooth radio tuning. Only { disableErtm: bool } - the root-side applier
// reads it, the shell just stores it. A REAL boolean only: this takes parsed JSON
// straight off the HTTP API, and coercing would turn the string "false" into a
// global Bluetooth change nobody asked for.
function setBluetooth(bluetooth) {
  const c = load();
  if (bluetooth && typeof bluetooth.disableErtm === "boolean") {
    c.bluetooth = { ...c.bluetooth, disableErtm: bluetooth.disableErtm };
  }
  save(c);
}
function rawBluetooth() {
  return load().bluetooth || null;
}

// Launcher UI preferences (clock format). Whitelisted so junk can't persist.
function setUi(ui) {
  const c = load();
  const hf = ui && ["auto", "12", "24"].includes(ui.hourFormat) ? ui.hourFormat : undefined;
  const ns = ui && typeof ui.navSounds === "boolean" ? ui.navSounds : undefined;
  const lc =
    ui && typeof ui.locale === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(ui.locale) ? ui.locale : undefined;
  c.ui = {
    ...c.ui,
    ...(hf ? { hourFormat: hf } : {}),
    ...(ns !== undefined ? { navSounds: ns } : {}),
    ...(lc ? { locale: lc } : {}),
  };
  save(c);
}
// The UI locale for everything shell-side that needs a language (pairing pages, the
// language a remote app is told). "" until the launcher has mirrored it.
function uiLocale() {
  return (load().ui || {}).locale || "";
}

// Remote button remap + Power policy (consumed by remote_input_bridge.py).
// Merges the provided fields so saving devices doesn't wipe power and vice
// versa; the renderer sends the FULL devices map when it sends devices. Stored
// sanitized.
function setRemote(remote) {
  const c = load();
  const cur = c.remote && typeof c.remote === "object" ? c.remote : {};
  const devices = remote && remote.devices !== undefined ? remote.devices : cur.devices;
  const power = remote && remote.power !== undefined ? remote.power : cur.power;
  c.remote = {
    devices: sanitizeDevices(devices),
    power: sanitizePower(power),
    // hand-edited bridge flag (grab a remote's sibling HID nodes) - no UI
    // writer exists, so every rewrite here must carry it over or a save/reset
    // silently ungrabs those nodes
    ...(cur.captureAllNodes === true ? { captureAllNodes: true } : {}),
  };
  save(c);
}
function rawRemote() {
  return load().remote || null;
}

// ---- IR blaster (ir.js: TV volume over IR when CEC volume doesn't work) ----
// Two backends: "esphome" (native API straight to an ESPHome IR transceiver,
// e.g. the Seeed XIAO Smart IR Mate) and "homeassistant" (each action runs an
// HA script - covers Broadlink & friends without a vendor protocol here).
// Actions live per-backend so switching backends keeps both mappings.
// The house vocabulary of IR actions. The three volume ones are what a remote's volume
// keys are diverted to; the rest exist because a source device cannot reach them any
// other way - CEC has no command that selects a foreign TV input, and a soundbar on its
// own power circuit is not on the CEC bus at all.
//
// It is a CLOSED list on purpose. A publish to an action nothing is mapped to is
// refused rather than sent (ir.js `send`), and a fixed vocabulary is what lets the HA
// buttons carry stable entity ids.
const IR_ACTIONS = [
  "volume_up",
  "volume_down",
  "mute",
  "tv_power",
  // Discrete sockets only. The TV's own Source code (irdb calls it `Input`, and the
  // index still carries it) is deliberately NOT an action here: measured on the
  // living-room LG, it opens the set's input LIST rather than stepping - and that list
  // cannot be driven by any remote the box owns, because those are paired to the BOX,
  // not to the television. So it leaves the screen in a menu somebody has to escape
  // with the TV's own remote, which is worse than offering nothing.
  "input_hdmi1",
  "input_hdmi2",
  "input_hdmi3",
  "input_hdmi4",
  "soundbar_power",
  "soundbar_volume_up",
  "soundbar_volume_down",
  "soundbar_mute",
];
const IR_BACKENDS = ["esphome", "homeassistant", "firetv"];
const ESPHOME_DEFAULT_PORT = 6053;

// What a `firetv` action points at: a device KIND in the saved remote plan plus one of
// its keys. Addressing by kind rather than by device id is what keeps "the soundbar's
// power" and "the TV's power" apart while the plan stays editable in the UI - a saved
// plan's device ids change when the published index regroups, a kind does not.
const IR_PLAN_TARGET_RE =
  /^(tv|audio|settop|player|climate|other):(VolumeUp|VolumeDown|Mute|Power|HDMI1|HDMI2|HDMI3|HDMI4|Input)$/;

function sanitizeIrActions(a, valid) {
  const out = {};
  if (!a || typeof a !== "object") return out;
  for (const k of IR_ACTIONS) {
    const v = typeof a[k] === "string" ? a[k].trim().slice(0, 100) : "";
    if (v && (!valid || valid(v))) out[k] = v;
  }
  return out;
}
// A firetv action's value is checked, not just trimmed: it becomes a lookup into the
// remote plan, and an unparseable one would fail per-press with nothing on screen
// having said so.
const sanitizeFiretvActions = (a) => sanitizeIrActions(a, (v) => IR_PLAN_TARGET_RE.test(v));
const IR_MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
// esphome entity object_ids ("signal_select"); junk falls back to the default.
function objectId(v, dflt) {
  return typeof v === "string" && /^[a-z0-9_]{1,64}$/.test(v.trim()) ? v.trim() : dflt;
}

function irConfigured(ir) {
  if (!ir || typeof ir !== "object") return false;
  const backend = IR_BACKENDS.includes(ir.backend) ? ir.backend : "esphome";
  if (backend === "esphome") {
    const e = ir.esphome;
    return !!(e && e.host && Object.keys(sanitizeIrActions(e.actions)).length);
  }
  if (backend === "firetv") {
    const f = ir.firetv;
    return !!(f && IR_MAC_RE.test(String(f.mac || "")) && Object.keys(sanitizeFiretvActions(f.actions)).length);
  }
  const h = ir.homeassistant;
  return !!(h && h.url && h.token && Object.keys(sanitizeIrActions(h.actions)).length);
}

// Secret-free view: the encryption key / HA token are write-only (has* flags).
function publicIr(ir) {
  const c = ir && typeof ir === "object" ? ir : {};
  const e = c.esphome && typeof c.esphome === "object" ? c.esphome : {};
  const h = c.homeassistant && typeof c.homeassistant === "object" ? c.homeassistant : {};
  const f = c.firetv && typeof c.firetv === "object" ? c.firetv : {};
  return {
    configured: irConfigured(c),
    backend: IR_BACKENDS.includes(c.backend) ? c.backend : "esphome",
    esphome: {
      host: e.host || "",
      port: e.port || null, // null = the default (6053)
      hasEncryptionKey: !!e.encryptionKey,
      select: objectId(e.select, "signal_select"),
      button: objectId(e.button, "send"),
      actions: sanitizeIrActions(e.actions),
    },
    homeassistant: {
      url: h.url || "",
      hasToken: !!h.token,
      actions: sanitizeIrActions(h.actions),
    },
    // No secret of its own: the remote is reached over its existing BlueZ bond, so a MAC
    // is the whole credential and it is already visible on the peripherals screen.
    firetv: {
      mac: IR_MAC_RE.test(String(f.mac || "")) ? String(f.mac).toUpperCase() : "",
      actions: sanitizeFiretvActions(f.actions),
    },
  };
}

// The launcher sends the FULL block for the backend it edits (mirrors setMqtt):
// an empty host/url clears that block, an empty secret keeps the stored one,
// an omitted block stays untouched. Whitelisted like every other section.
function setIr(ir) {
  const c = load();
  const cur = c.ir && typeof c.ir === "object" ? c.ir : {};
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const next = {
    backend: IR_BACKENDS.includes(ir && ir.backend)
      ? ir.backend
      : IR_BACKENDS.includes(cur.backend)
        ? cur.backend
        : "esphome",
  };

  let esphome = cur.esphome && typeof cur.esphome === "object" ? cur.esphome : null;
  if (ir && ir.esphome !== undefined) {
    const p = ir.esphome;
    const host = str(p && p.host, 200);
    if (!host) esphome = null;
    else {
      const port = Number(p && p.port);
      const prev = esphome || {};
      const encryptionKey =
        p && typeof p.encryptionKey === "string" && p.encryptionKey
          ? p.encryptionKey.slice(0, 200)
          : prev.encryptionKey;
      esphome = {
        host,
        ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {}),
        ...(encryptionKey ? { encryptionKey } : {}),
        ...(prev.password ? { password: prev.password } : {}), // config-file-only legacy auth - never dropped by a UI save
        select: objectId(p && p.select, "signal_select"),
        button: objectId(p && p.button, "send"),
        actions: sanitizeIrActions((p && p.actions) || prev.actions),
      };
    }
  }
  if (esphome) next.esphome = esphome;

  let ha = cur.homeassistant && typeof cur.homeassistant === "object" ? cur.homeassistant : null;
  if (ir && ir.homeassistant !== undefined) {
    const p = ir.homeassistant;
    const url = str(p && p.url, 300);
    if (!url) ha = null;
    else {
      const prev = ha || {};
      const token = p && typeof p.token === "string" && p.token ? p.token.slice(0, 500) : prev.token;
      ha = {
        url,
        ...(token ? { token } : {}),
        actions: sanitizeIrActions((p && p.actions) || prev.actions),
      };
    }
  }
  if (ha) next.homeassistant = ha;

  let firetv = cur.firetv && typeof cur.firetv === "object" ? cur.firetv : null;
  if (ir && ir.firetv !== undefined) {
    const p = ir.firetv;
    const mac = str(p && p.mac, 17).toUpperCase();
    // An OMITTED mac keeps the stored one; only an explicit empty string clears the
    // block. The launcher echoes the whole block back on every action save, and it
    // reads the MAC from `publicIr`, which shows "" for a stored value it cannot
    // validate - so with "absent" and "empty" meaning the same thing, saving an action
    // wiped the remote's address and the backend with it.
    const macGiven = !!(p && p.mac !== undefined);
    if (macGiven && !mac) firetv = null;
    else if (mac && !IR_MAC_RE.test(mac)) console.warn("[config] ignoring an unusable IR remote MAC");
    else
      firetv = {
        mac: mac || (firetv || {}).mac || "",
        actions: sanitizeFiretvActions((p && p.actions) || (firetv || {}).actions),
      };
  }
  if (firetv) next.firetv = firetv;

  // A backend the caller EXPLICITLY chose keeps the section alive even with nothing
  // configured under it yet. Without this the choice is deleted along with the empty
  // section, and since each backend's fields are only rendered once it is selected, a
  // box with no IR set up at all could never reach them - measured: picking `firetv`
  // on a fresh box left the backend on `esphome`, every time. The same trap has always
  // applied to `homeassistant`; the new backend is what made it load-bearing, because
  // it is the one that needs no hardware and so is the first thing a fresh box picks.
  const chosen = !!(ir && IR_BACKENDS.includes(ir.backend));
  if (!next.esphome && !next.homeassistant && !next.firetv && !chosen) delete c.ir;
  else c.ir = next;
  save(c);
}

// Where the published TV-code index lives (shell/irindex.js ships the default). A fork
// that builds its own with scripts/ir-index/ points its boxes at it here - the same
// kind of self-host override as `update.feed`. No setter: nothing in the UI sets it.
function rawFiretvir() {
  return load().firetvir || null;
}

// Full config (incl. secrets) for ir.js - null unless the SELECTED backend is
// usable, with defaults applied so ir.js never re-derives them.
function rawIr() {
  const c = load().ir;
  if (!irConfigured(c)) return null;
  const backend = IR_BACKENDS.includes(c.backend) ? c.backend : "esphome";
  if (backend === "esphome") {
    const e = c.esphome;
    return {
      backend,
      esphome: {
        host: e.host,
        port: Number.isInteger(e.port) ? e.port : ESPHOME_DEFAULT_PORT,
        encryptionKey: e.encryptionKey || "",
        password: e.password || "", // legacy ESPHome API auth; config-file-only (no UI)
        select: objectId(e.select, "signal_select"),
        button: objectId(e.button, "send"),
        actions: sanitizeIrActions(e.actions),
      },
    };
  }
  if (backend === "firetv") {
    const f = c.firetv;
    return { backend, firetv: { mac: String(f.mac).toUpperCase(), actions: sanitizeFiretvActions(f.actions) } };
  }
  const h = c.homeassistant;
  return { backend, homeassistant: { url: h.url, token: h.token, actions: sanitizeIrActions(h.actions) } };
}

// Background-apps behavior (appwindows.js reads it via main.js): only the one
// whitelisted toggle persists.
function setApps(a) {
  const c = load();
  if (a && typeof a.background === "boolean") c.apps = { ...c.apps, background: a.background };
  save(c);
}
function rawApps() {
  return load().apps || null;
}

// Restore path (backup.js): replace the WHOLE config file with the backup's
// copy - restore is deliberately not a merge, the backup is the truth.
function replaceAll(cfg) {
  save(cfg && typeof cfg === "object" ? cfg : {});
}

module.exports = {
  setFileserver,
  rawFileserver,
  setAppshares,
  rawAppshares,
  setShares,
  rawShares,
  setPhoneRemote,
  rawPhoneRemote,
  setKeyboard,
  rawKeyboard,
  setSetupDone,
  publicConfig,
  setIptv,
  setParental,
  verifyPin,
  rawIptv,
  setSpotify,
  rawSpotify,
  appConfig,
  setAppConfig,
  appSwitches,
  setAppSwitch,
  clearAppSwitches,
  setStore,
  rawStore,
  setUi,
  uiLocale,
  setPlayer,
  rawPlayer,
  setWifi,
  rawWifi,
  setBluetooth,
  rawBluetooth,
  setAudio,
  rawAudio,
  setAmbient,
  rawAmbient,
  rawMqtt,
  setMqtt,
  setUpdate,
  rawUpdate,
  setRemote,
  rawRemote,
  setIr,
  rawIr,
  // for the drift test in shell/irbuttons.test.js
  _test: { IR_ACTIONS },
  rawFiretvir,
  setApps,
  rawApps,
  replaceAll,
};
