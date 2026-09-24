// The last few copies of config.json that a working box ran on.
//
// A backup needs a phone and a plan made before the mistake. This covers the
// ordinary one: a setting changed an hour ago that turned out wrong, or a file a
// power cut left unreadable (config.js moves that aside rather than overwriting
// it). A copy is taken once per shell start, a while after the launcher first
// loaded, and only when it differs from the newest one kept.
//
// The copies hold everything config.json holds, credentials included, so they
// are 0600 in a 0700 directory, and the only route that lists them answers the
// launcher alone (apigate.js: /backup/ is launcher only). A restore goes through
// config.replaceAll, the same door a backup restore uses.
const fs = require("fs");
const os = require("os");
const path = require("path");
const fsutil = require("./fsutil");

const KEEP = 5;
const TAKE_DELAY_MS = 2 * 60 * 1000;
const ID_RE = /^\d{10,16}$/;

let paths = {
  dir: path.join(os.homedir(), ".tvbox", "config-snapshots"),
  config: null, // set lazily from config.js, so a test can point both elsewhere
};

function setPathsForTest(p) {
  paths = { ...paths, ...p };
}

function configFile() {
  return paths.config || require("./config").FILE;
}

function ensureDir() {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(paths.dir, 0o700);
  } catch (e) {}
  const st = fs.lstatSync(paths.dir);
  if (!st.isDirectory()) throw new Error("snapshot path is not a directory");
}

const fileOf = (id) => path.join(paths.dir, "config-" + id + ".json");

/** Newest first: [{ id, at }]. */
function list() {
  let names;
  try {
    names = fs.readdirSync(paths.dir);
  } catch (e) {
    return [];
  }
  return names
    .map((n) => /^config-(\d{10,16})\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => ({ id: m[1], at: Number(m[1]) }))
    .sort((a, b) => b.at - a.at);
}

/**
 * Keep a copy of the current config if it parses and differs from the newest
 * copy. Returns the new id, or null when nothing was written.
 */
function take(now) {
  try {
    const bytes = fs.readFileSync(configFile());
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    ensureDir();
    const newest = list()[0];
    if (newest) {
      try {
        if (fs.readFileSync(fileOf(newest.id)).equals(bytes)) return null;
      } catch (e) {}
    }
    let id = String(now || Date.now());
    if (newest && Number(id) <= newest.at) id = String(newest.at + 1);
    fsutil.writeFileAtomic(fileOf(id), bytes, { mode: 0o600, mkdir: false });
    prune();
    return id;
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("[configsnap] could not keep a copy:", e.message);
    return null;
  }
}

function prune() {
  for (const s of list().slice(KEEP)) {
    try {
      fs.unlinkSync(fileOf(s.id));
    } catch (e) {}
  }
}

/**
 * Put copy `id` back as config.json. The current config is kept as a copy first,
 * so a restore can itself be undone. Returns { ok } or { ok: false, error }.
 */
function restore(id, replaceAll) {
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "bad id" };
  if (!list().some((s) => s.id === id)) return { ok: false, error: "not found" };
  let cfg;
  try {
    const st = fs.lstatSync(fileOf(id));
    if (!st.isFile()) return { ok: false, error: "not a file" };
    cfg = JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
  } catch (e) {
    return { ok: false, error: "unreadable" };
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { ok: false, error: "unreadable" };
  take();
  try {
    replaceAll(cfg);
  } catch (e) {
    return { ok: false, error: "write failed" };
  }
  return { ok: true };
}

module.exports = { take, list, restore, KEEP, TAKE_DELAY_MS, _test: { setPathsForTest } };
