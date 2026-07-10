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
    ambient: {
      enabled: !(c.ambient && c.ambient.enabled === false), // default on
      idleMinutes: (c.ambient && c.ambient.idleMinutes) || 5,
      city: (c.ambient && c.ambient.city) || "",
      sleepMinutes: (c.ambient && c.ambient.sleepMinutes) || 0, // 0 = never; N = CEC TV-off after N min on the screensaver
    },
    mqtt: {
      // secret-free: never expose the broker password to the launcher
      configured: !!(c.mqtt && c.mqtt.host && c.mqtt.username),
      host: (c.mqtt && c.mqtt.host) || "",
      deviceId: (c.mqtt && c.mqtt.deviceId) || "",
    },
    update: {
      // OTA self-update (updater.js); feed URL itself stays box-local
      auto: !(c.update && c.update.auto === false), // default on
    },
    ui: {
      // launcher preferences. hourFormat: "auto" (locale default) | "12" | "24"
      hourFormat: (c.ui && ["12", "24"].includes(c.ui.hourFormat) && c.ui.hourFormat) || "auto",
    },
    remote: {
      // Per-device button remap + Power-button policy, consumed by
      // remote_input_bridge.py. Not a secret - exposed as-is. Default (no
      // entries) = every remote passes through unchanged.
      devices: sanitizeDevices(c.remote && c.remote.devices),
      power: sanitizePower(c.remote && c.remote.power),
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
];
function sanitizeDevices(devices) {
  const out = {};
  if (!devices || typeof devices !== "object") return out;
  for (const [id, entry] of Object.entries(devices)) {
    if (typeof id !== "string" || !id || id.length > 80 || !entry || typeof entry !== "object") continue;
    const rawkm = entry.keymap && typeof entry.keymap === "object" ? entry.keymap : {};
    const keymap = {};
    for (const a of REMOTE_ACTIONS) {
      if (!Array.isArray(rawkm[a])) continue;
      const codes = rawkm[a].filter((c) => Number.isInteger(c) && c >= 0 && c < 1024).slice(0, 6);
      if (codes.length) keymap[a] = codes;
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

function setParental({ pin, lockedGroups }) {
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
// secret-bearing config for the mqtt client. Provisioned out-of-band (a `tvbox`
// broker user), not via the launcher UI.
function rawMqtt() {
  const m = load().mqtt;
  return m && m.host && m.username ? m : null;
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

// Launcher UI preferences (clock format). Whitelisted so junk can't persist.
function setUi(ui) {
  const c = load();
  const hf = ui && ["auto", "12", "24"].includes(ui.hourFormat) ? ui.hourFormat : undefined;
  c.ui = { ...c.ui, ...(hf ? { hourFormat: hf } : {}) };
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
  setAudio,
  rawAudio,
  setAmbient,
  rawAmbient,
  rawMqtt,
  setUpdate,
  rawUpdate,
  setRemote,
  rawRemote,
  replaceAll,
};
