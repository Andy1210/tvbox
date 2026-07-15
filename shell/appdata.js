// tvbox capability: per-app key/value storage (the `storage` capability).
//
// A sandboxed app gets localStorage in its own renderer, but that's tied to the
// window/partition and invisible to the shell (backup, reset). This gives a
// capability app a small, shell-owned kv namespace under ~/.tvbox/appdata/<id>.json,
// persisted, per-app isolated (keyed by the app id, never cross-app), and
// size-capped so a manifest can't fill the SD card. Values are strings, like
// localStorage. Pure-ish (fs only); the id/size guards are the security surface.
const fs = require("fs");
const path = require("path");
const os = require("os");

const DIR = path.join(os.homedir(), ".tvbox", "appdata");
const MAX_BYTES = 256 * 1024; // per-app store cap
const MAX_KEYS = 200;

function safeId(id) {
  return typeof id === "string" && /^[a-z0-9_-]+$/.test(id) ? id : null;
}
function fileFor(id) {
  return path.join(DIR, id + ".json");
}

function readAll(id) {
  const sid = safeId(id);
  if (!sid) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(sid), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // null-prototype copy so keys like "__proto__"/"constructor" are plain data,
    // never touch Object.prototype, and `in`/quota checks aren't fooled by
    // inherited names.
    const obj = Object.create(null);
    for (const k of Object.keys(parsed)) obj[k] = parsed[k];
    return obj;
  } catch (e) {
    return {}; // missing / corrupt -> empty
  }
}

function writeAll(id, obj) {
  const sid = safeId(id);
  if (!sid) return { ok: false, error: "bad app id" };
  const json = JSON.stringify(obj);
  if (Buffer.byteLength(json, "utf8") > MAX_BYTES) return { ok: false, error: "storage quota exceeded" };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileFor(sid), json, { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "write failed" };
  }
}

function get(id, key) {
  const all = readAll(id);
  const v = all[String(key)];
  return typeof v === "string" ? v : null;
}

function set(id, key, value) {
  const k = String(key);
  const v = String(value);
  const all = readAll(id);
  if (!(k in all) && Object.keys(all).length >= MAX_KEYS) return { ok: false, error: "too many keys" };
  all[k] = v;
  return writeAll(id, all);
}

function remove(id, key) {
  const all = readAll(id);
  delete all[String(key)];
  return writeAll(id, all);
}

module.exports = { get, set, remove, readAll, safeId, MAX_BYTES, MAX_KEYS, DIR };
