// tvbox settings backup/restore. One password-encrypted JSON file that holds
// everything a re-flash loses: config.json (IPTV/Spotify/MQTT credentials,
// parental PIN hash), the user-installed app manifests (~/.tvbox/apps/*.json),
// the Spotify account tokens, and the launcher's localStorage snapshot (locale,
// app order/hidden, onboarding state - the launcher hands it over, the shell
// can't read renderer storage directly).
//
// The file leaves the box (phone download via the pairing page), so it is
// ALWAYS encrypted: scrypt(password) -> AES-256-GCM. Wrong password = GCM auth
// failure, not garbage output. Restore is merge-free (config.json is replaced
// wholesale) and finishes with a shell restart; the launcher-side localStorage
// lands in restore-localstorage.json and is applied by the launcher on its
// next boot (GET pending -> setItem* -> clear -> reload).
//
// NOT included by design: app bundles/binaries (reinstall via tile/`tvbox
// deps`), ambient wallpapers (re-upload from the phone), and web-app logins
// (Plex/YouTube cookies live in per-app Electron partitions).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const apps = require("./install");
const pkg = require("./package.json");

const TVBOX = path.join(os.homedir(), ".tvbox");
const CONFIG_FILE = path.join(TVBOX, "config.json");
const RESTORE_LS = path.join(TVBOX, "restore-localstorage.json");
// Small secret-bearing sidecar files worth carrying across a re-flash.
const EXTRA_FILES = ["spotify-accounts.json", "spotify-refresh-token"];

const FORMAT = "tvbox-backup";
const FORMAT_ENC = "tvbox-backup-encrypted";
const VERSION = 1;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MIN_PASSWORD = 4;

// ---- collect ----
// `extra` comes from the launcher (POST /tvbox/api/backup/context before the
// pairing QR appears): { localStorage: "<JSON.stringify(localStorage)>" }.
function collect(extra) {
  const payload = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    shellVersion: pkg.version || "",
    config: readJson(CONFIG_FILE) || {},
    userApps: {},
    files: {},
    localStorage: extra && typeof extra.localStorage === "string" ? extra.localStorage : null,
  };
  try {
    for (const f of fs.readdirSync(apps.USER_APPS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const m = readJson(path.join(apps.USER_APPS_DIR, f));
      if (m) payload.userApps[f.replace(/\.json$/, "")] = m;
    }
  } catch (e) {
    /* no user apps dir yet */
  }
  for (const name of EXTRA_FILES) {
    try {
      payload.files[name] = fs.readFileSync(path.join(TVBOX, name), "utf8");
    } catch (e) {
      /* absent */
    }
  }
  return payload;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

// ---- crypto envelope ----
function encrypt(payload, password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new Error("password too short");
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, SCRYPT);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    format: FORMAT_ENC,
    version: VERSION,
    kdf: { algo: "scrypt", ...SCRYPT, salt: salt.toString("base64") },
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt(envelope, password) {
  if (!envelope || envelope.format !== FORMAT_ENC) throw new Error("not a tvbox backup file");
  if (envelope.version > VERSION) throw new Error("backup from a newer tvbox");
  const k = envelope.kdf || {};
  if (k.algo !== "scrypt") throw new Error("unknown kdf");
  const key = crypto.scryptSync(String(password || ""), Buffer.from(k.salt, "base64"), 32, { N: k.N, r: k.r, p: k.p });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  let text;
  try {
    text = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  } catch (e) {
    throw new Error("wrong password");
  } // GCM auth failure
  const payload = JSON.parse(text);
  if (payload.format !== FORMAT) throw new Error("bad backup payload");
  return payload;
}

// ---- apply (restore) ----
// Replaces config.json, rewrites user app manifests (validated, ids bounded),
// restores the sidecar files and parks the localStorage snapshot for the
// launcher. The caller restarts the shell afterwards (plugins re-read creds at
// boot only).
function apply(payload) {
  if (!payload || payload.format !== FORMAT || payload.version > VERSION) throw new Error("bad backup payload");
  if (payload.config && typeof payload.config === "object") config.replaceAll(payload.config);
  if (payload.userApps && typeof payload.userApps === "object") {
    fs.mkdirSync(apps.USER_APPS_DIR, { recursive: true });
    for (const [id, m] of Object.entries(payload.userApps)) {
      if (!/^[a-z0-9_-]{1,40}$/.test(id)) continue;
      const valid = apps.validateManifest(m, "restore:" + id);
      if (!valid) {
        console.warn("[backup] skipped invalid manifest:", id);
        continue;
      }
      fs.writeFileSync(path.join(apps.USER_APPS_DIR, id + ".json"), JSON.stringify(valid, null, 2) + "\n");
    }
  }
  if (payload.files && typeof payload.files === "object") {
    for (const name of EXTRA_FILES) {
      // fixed allowlist - never write attacker-chosen paths
      if (typeof payload.files[name] === "string")
        fs.writeFileSync(path.join(TVBOX, name), payload.files[name], { mode: 0o600 });
    }
  }
  if (typeof payload.localStorage === "string" && payload.localStorage) {
    fs.writeFileSync(RESTORE_LS, JSON.stringify({ data: payload.localStorage, at: Date.now() }), { mode: 0o600 });
  }
  console.log("[backup] restore applied (from", (payload.hostname || "?") + ",", payload.createdAt + ")");
  return { ok: true };
}

// The launcher polls this on boot and applies the snapshot to its own
// localStorage (locale, app order, …), then clears it and reloads.
function pendingLocalStorage() {
  const j = readJson(RESTORE_LS);
  return j && typeof j.data === "string" ? { data: j.data } : { data: null };
}
function clearPendingLocalStorage() {
  fs.rmSync(RESTORE_LS, { force: true });
}

module.exports = { collect, encrypt, decrypt, apply, pendingLocalStorage, clearPendingLocalStorage, MIN_PASSWORD };
