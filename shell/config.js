// tvbox config store. Shell-owned ~/.tvbox/config.json (Pi-local, never
// committed, chmod 600 - may hold IPTV credentials). The launcher reads a
// SECRET-FREE view via GET /tvbox/api/config and writes via POST; the parental
// PIN is stored hashed and verified server-side so the renderer never sees it.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

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
    parental: {
      pinSet: !!(c.parental && c.parental.pinHash),
      lockedGroups: (c.parental && c.parental.lockedGroups) || [],
      requirePin: !!(c.parental && c.parental.requirePin), // gate installs/sensitive settings in the UI
    },
    spotify: {
      deviceName: (c.spotify && c.spotify.deviceName) || "",
      hasCredentials: !!(c.spotify && c.spotify.clientId && c.spotify.clientSecret),
      // Spotify Connect is opt-in: the librespot daemon (which advertises the
      // box on the LAN) runs only once enabled, even though the binary now ships
      // in the image. Default off - this is "installed" for the built-in app.
      enabled: !!(c.spotify && c.spotify.enabled),
    },
    display: {
      mode: (c.display && c.display.mode) || null,
      matchFramerate: !!(c.display && c.display.matchFramerate),
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
      deviceId: (c.mqtt && c.mqtt.deviceId) || "",
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
    },
    ui: {
      // launcher preferences. hourFormat: "auto" (locale default) | "12" | "24"
      hourFormat: (c.ui && ["12", "24"].includes(c.ui.hourFormat) && c.ui.hourFormat) || "auto",
      navSounds: !(c.ui && c.ui.navSounds === false), // D-pad ticks, default on
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
];
// Dynamic app-launch remap actions ("app:<id>" - launch that app). The id
// charset mirrors the bridge's APP_ACTION_RE and the nav endpoint's guard.
const REMOTE_APP_ACTION = /^app:[a-z0-9_-]{1,32}$/;
function sanitizeDevices(devices) {
  const out = {};
  if (!devices || typeof devices !== "object") return out;
  for (const [id, entry] of Object.entries(devices)) {
    if (typeof id !== "string" || !id || id.length > 80 || !entry || typeof entry !== "object") continue;
    const rawkm = entry.keymap && typeof entry.keymap === "object" ? entry.keymap : {};
    const keymap = {};
    for (const a of Object.keys(rawkm)) {
      if (!REMOTE_ACTIONS.includes(a) && !REMOTE_APP_ACTION.test(a)) continue;
      if (!Array.isArray(rawkm[a])) continue;
      const codes = rawkm[a].filter((c) => Number.isInteger(c) && c >= 0 && c < 1024).slice(0, 6);
      if (codes.length) keymap[a] = codes;
      if (Object.keys(keymap).length >= 32) break; // cap per device
    }
    const name = typeof entry.name === "string" ? entry.name.slice(0, 80) : "";
    if (Object.keys(keymap).length || name) out[id] = { name, keymap };
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
  save(c);
}
function rawSpotify() {
  return load().spotify || null;
}

// Display mode + "match content framerate" (mpv display-resample) toggle.
// Merges so the mode-apply route and the framerate toggle don't clobber each other.
function setDisplay(display) {
  const c = load();
  c.display = { ...c.display, ...display };
  save(c);
}
function rawDisplay() {
  return load().display || null;
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
  const deviceId = str(mqtt && mqtt.deviceId, 200).replace(/[^a-zA-Z0-9_-]/g, "_");
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
function setAppConfig(key, val) {
  if (!key || !/^[a-z0-9_]+$/i.test(key)) return false;
  const c = load();
  c[key] = { ...(typeof c[key] === "object" ? c[key] : {}), ...val };
  save(c);
  return true;
}

// App-store registry override: { registry: "<index.json url>" }. Default is the
// official tvbox-apps index (store.js); self-hosters point this elsewhere.
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
  save(c);
}
function rawWifi() {
  return load().wifi || null;
}

// Launcher UI preferences (clock format). Whitelisted so junk can't persist.
function setUi(ui) {
  const c = load();
  const hf = ui && ["auto", "12", "24"].includes(ui.hourFormat) ? ui.hourFormat : undefined;
  const ns = ui && typeof ui.navSounds === "boolean" ? ui.navSounds : undefined;
  c.ui = { ...c.ui, ...(hf ? { hourFormat: hf } : {}), ...(ns !== undefined ? { navSounds: ns } : {}) };
  save(c);
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
  c.remote = { devices: sanitizeDevices(devices), power: sanitizePower(power) };
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
const IR_ACTIONS = ["volume_up", "volume_down", "mute"];
const IR_BACKENDS = ["esphome", "homeassistant"];
const ESPHOME_DEFAULT_PORT = 6053;

function sanitizeIrActions(a) {
  const out = {};
  if (!a || typeof a !== "object") return out;
  for (const k of IR_ACTIONS) {
    const v = typeof a[k] === "string" ? a[k].trim().slice(0, 100) : "";
    if (v) out[k] = v;
  }
  return out;
}
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
  const h = ir.homeassistant;
  return !!(h && h.url && h.token && Object.keys(sanitizeIrActions(h.actions)).length);
}

// Secret-free view: the encryption key / HA token are write-only (has* flags).
function publicIr(ir) {
  const c = ir && typeof ir === "object" ? ir : {};
  const e = c.esphome && typeof c.esphome === "object" ? c.esphome : {};
  const h = c.homeassistant && typeof c.homeassistant === "object" ? c.homeassistant : {};
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

  if (!next.esphome && !next.homeassistant) delete c.ir;
  else c.ir = next;
  save(c);
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
  publicConfig,
  setIptv,
  setParental,
  verifyPin,
  rawIptv,
  setSpotify,
  rawSpotify,
  appConfig,
  setAppConfig,
  rawStore,
  setDisplay,
  rawDisplay,
  setUi,
  setPlayer,
  rawPlayer,
  setWifi,
  rawWifi,
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
  setApps,
  rawApps,
  replaceAll,
};
