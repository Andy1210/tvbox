// tvbox settings backup/restore. One password-encrypted JSON file that holds
// everything a re-flash loses: config.json (IPTV/Spotify/MQTT credentials,
// parental PIN hash), the user-installed app manifests (~/.tvbox/apps/*.json),
// each app's `storage` capability data (~/.tvbox/appdata/<id>.json), the Spotify
// account tokens, and the launcher's localStorage snapshot (locale, app
// order/hidden, onboarding state - the launcher hands it over, the shell can't
// read renderer storage directly).
//
// The file leaves the box (phone download via the pairing page), so it is
// ALWAYS encrypted: scrypt(password) -> AES-256-GCM. Wrong password = GCM auth
// failure, not garbage output. Restore is merge-free (config.json is replaced
// wholesale) and finishes with a shell restart; the launcher-side localStorage
// lands in restore-localstorage.json and is applied by the launcher on its
// next boot (GET pending -> setItem* -> clear -> reload).
//
// What CANNOT travel in a JSON file - a registry app's own package, its
// flatpaks, the static binaries, an extracted web bundle - is carried
// DECLARATIVELY instead: the payload lists the app ids the box had, and the next
// boot re-acquires them (reconcile.js). So "not in the backup" no longer means
// "gone after a restore".
//
// Still out by design: ambient wallpapers (re-upload from the phone) and web-app
// logins (Plex/YouTube cookies live in per-app Electron partitions).
//
// The payload VERSION stays 1 as fields are added: every reader treats an absent
// field as "this backup didn't carry that", so a new box restores an old file and
// an old box restores a new one (minus what it doesn't know about). Bump it only
// when an existing field changes meaning.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const apps = require("./install");
const appdata = require("./appdata");
const reconcile = require("./reconcile");
const identity = require("./identity");
const pkg = require("./package.json");

const TVBOX = path.join(os.homedir(), ".tvbox");
const CONFIG_FILE = path.join(TVBOX, "config.json");
const RESTORE_LS = path.join(TVBOX, "restore-localstorage.json");
const PENDING_APPFILES = path.join(TVBOX, "restore-appfiles.json");
// Small secret-bearing sidecar files worth carrying across a re-flash.
const EXTRA_FILES = ["spotify-accounts.json", "spotify-refresh-token"];
const MAX_APPDATA = 40; // per-app stores are capped at 256 KB each (appdata.js)
// An app's own declared files (`backup.paths` in its manifest): RetroArch's
// playlists and save files are the case this exists for. Bounded on purpose - the
// file is downloaded by a phone over the LAN and uploaded back through a 25 MB
// request, so this carries save files and settings, not ROMs or cover art. What
// doesn't fit is reported, never silently dropped.
const MAX_APP_FILES_BYTES = 8 * 1024 * 1024;
const MAX_APP_FILE_BYTES = 4 * 1024 * 1024;
const MAX_APP_FILES = 400;
// Marks an entry as one of the app's ~/.tvbox/ sidecars rather than a file under
// its own root. A `/` can never appear in a state file name (install.stateFileOk),
// so the two namespaces cannot collide.
const STATE_PREFIX = "state/";

const FORMAT = "tvbox-backup";
const FORMAT_ENC = "tvbox-backup-encrypted";
const VERSION = 1;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MIN_PASSWORD = 4;

// ---- collect ----
// `extra` comes from the launcher (POST /tvbox/api/backup/context before the
// pairing QR appears): { localStorage: "<JSON.stringify(localStorage)>" }.
// `opts.clone` marks the file as a SEED for a second box rather than this box's
// own safety copy. The choice is made here, on the source box, by the person who
// knows which one they are doing - the target box cannot tell a re-flash from a
// clone by itself (both have a fresh machine id and, before setup, a default
// hostname), and guessing wrong either renames a box's HA entities or gives two
// boxes one identity.
function collect(extra, opts) {
  const payload = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    hostname: identity.hostname(),
    machineId: identity.machineId(),
    clone: !!(opts && opts.clone),
    shellVersion: pkg.version || "",
    config: readJson(CONFIG_FILE) || {},
    userApps: {},
    apps: appInventory(),
    appdata: collectAppdata(),
    appFiles: collectAppFiles(),
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

// Every app the box has, in BOTH forms - the single manifest above only covers
// `~/.tvbox/apps/<id>.json`, and a registry app that ships its own code is a
// DIRECTORY whose contents (plugin.js, web/…) have no business inside a settings
// file. Recording the id is enough: the registry can rebuild it.
function appInventory() {
  const out = [];
  try {
    for (const m of apps.loadManifests()) out.push({ id: m.id, package: !!m._dir, version: m.version || null });
  } catch (e) {
    /* no apps dir yet */
  }
  return out;
}

// The `storage` capability's per-app data. An app's own settings live here (the
// shell owns the file, the app only sees its own namespace), and nothing else
// would carry them: it is not config.json, and it is not renderer localStorage.
function collectAppdata() {
  const out = {};
  try {
    for (const f of fs.readdirSync(appdata.DIR)) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/, "");
      if (!appdata.safeId(id)) continue;
      const kv = readJson(path.join(appdata.DIR, f));
      if (!kv || typeof kv !== "object" || Array.isArray(kv)) continue;
      out[id] = kv;
      if (Object.keys(out).length >= MAX_APPDATA) break;
    }
  } catch (e) {
    /* no app has used the storage capability yet */
  }
  return out;
}

// Files an app asked to have carried (`backup.paths`), keyed by app id then by
// the path relative to the app's own root. Base64, because a save file is binary.
//
// This is the answer to "an emulator's playlists and saves have to be moved by
// hand": the shell knows nothing about RetroArch, the app's manifest names what
// matters, and the same mechanism serves the next app that has files of its own.
function collectAppFiles() {
  const out = {};
  let bytes = 0;
  let count = 0;
  const skipped = [];
  for (const m of apps.getManifests()) {
    const root = apps.appBackupRoot(m);
    if (!root) continue;
    const files = {};
    // Sidecar state the app's plugin keeps in ~/.tvbox/ - carried under the
    // `state/` prefix so restore knows which root it belongs to.
    for (const name of m.backup.state || []) {
      if (!apps.stateFileOk(m.id, name)) continue;
      try {
        const buf = fs.readFileSync(path.join(TVBOX, name));
        if (buf.length > MAX_APP_FILE_BYTES) {
          skipped.push(m.id + "/" + name);
          continue;
        }
        files[STATE_PREFIX + name] = buf.toString("base64");
        bytes += buf.length;
        count++;
      } catch (e) {
        /* absent */
      }
    }
    for (const rel of m.backup.paths) {
      for (const f of walkFiles(path.join(root, rel), rel)) {
        if (count >= MAX_APP_FILES || bytes + f.size > MAX_APP_FILES_BYTES) {
          skipped.push(m.id + "/" + f.rel);
          continue;
        }
        if (f.size > MAX_APP_FILE_BYTES) {
          skipped.push(m.id + "/" + f.rel);
          continue;
        }
        try {
          files[f.rel] = fs.readFileSync(f.abs).toString("base64");
          bytes += f.size;
          count++;
        } catch (e) {
          /* unreadable - the box keeps working without it */
        }
      }
    }
    if (Object.keys(files).length) out[m.id] = files;
  }
  if (count) console.log("[backup] carrying", count, "app file(s),", Math.round(bytes / 1024), "KB");
  if (skipped.length)
    console.warn(
      "[backup] too big for the backup, NOT carried:",
      skipped.slice(0, 8).join(", "),
      "(+" + Math.max(0, skipped.length - 8) + " more)",
    );
  return out;
}

// One declared path, expanded: a file yields itself, a directory every file under
// it (depth-bounded, symlinks not followed - a link in an app's data dir must not
// pull an arbitrary file into the backup).
function walkFiles(abs, rel, depth) {
  depth = depth || 0;
  if (depth > 6) return [];
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (e) {
    return []; // the app never created it
  }
  if (st.isFile()) return [{ abs, rel, size: st.size }];
  if (!st.isDirectory()) return []; // symlink, socket, device: not ours to carry
  let names;
  try {
    names = fs.readdirSync(abs);
  } catch (e) {
    return [];
  }
  return names.flatMap((n) => walkFiles(path.join(abs, n), rel + "/" + n, depth + 1));
}

// Is any existing component of `out` below `root` a symlink? The prefix guard in
// restoreAppFiles compares resolved STRINGS, which says nothing about what is on
// disk: a link at `<root>/saves` pointing at ~/.ssh would pass it and the write
// would follow the link out. lstat so the link itself is what gets inspected, and
// walk downwards from the root so a link at any depth is caught.
function symlinkOnPath(root, out) {
  const rel = path.relative(root, out);
  if (!rel || rel.startsWith("..")) return true; // not under the root: refuse rather than reason about it
  let at = root;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    try {
      if (fs.lstatSync(at).isSymbolicLink()) return true;
    } catch (e) {
      return false; // does not exist yet - nothing to follow, and mkdir will create it
    }
  }
  return false;
}

function isDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// Write back what collectAppFiles gathered, under the same per-app root. Every
// path is re-derived from the manifest ON THIS BOX and pinned inside that root, so
// a tampered backup cannot name a file outside the app it claims to be.
//
// Returns the ids it could place. An app whose manifest is not on the box yet -
// a registry package arrives during reconciliation, not during the restore - is
// left for the next pass rather than dropped.
function restoreAppFiles(appFiles) {
  let n = 0;
  const handled = [];
  for (const [id, files] of Object.entries(appFiles)) {
    const m = apps.manifestById(id);
    const root = m && apps.appBackupRoot(m);
    if (!root || !files || typeof files !== "object") continue;
    handled.push(id);
    const allowed = m.backup.paths;
    for (const [rel, b64] of Object.entries(files)) {
      if (typeof b64 !== "string") continue;
      // Which root this entry belongs to is decided HERE from the manifest on this
      // box, never from the backup: a `state/` entry is one of the app's own
      // ~/.tvbox/ sidecars (id-prefixed name, no separators), anything else must
      // sit under a path the manifest declares and resolve inside the app's root.
      let out;
      // `base` is the directory the entry is confined to, and it differs per branch -
      // the symlink walk below has to be told which one, or a state sidecar (which
      // lives in ~/.tvbox, not under the app root) reads as an escape attempt.
      let base;
      if (rel.startsWith(STATE_PREFIX)) {
        const name = rel.slice(STATE_PREFIX.length);
        if (!apps.stateFileOk(id, name) || !(m.backup.state || []).includes(name)) continue;
        out = path.join(TVBOX, name);
        base = TVBOX;
      } else {
        if (!allowed.some((p) => rel === p || rel.startsWith(p + "/"))) continue;
        out = path.resolve(root, rel);
        // STRICTLY under the root, never the root itself. `saves/..` passes the
        // allowlist above (it starts with "saves/") and resolves to the root, so
        // allowing `out === root` would let a crafted payload write a FILE where the
        // app's directory belongs - and `~/.var/app/<ref>` as a regular file is a
        // flatpak that can never be installed again without hand-deleting it.
        if (!out.startsWith(root + path.sep)) continue;
        base = root;
      }
      try {
        const buf = Buffer.from(b64, "base64");
        if (buf.length > MAX_APP_FILE_BYTES) continue;
        // The resolved-prefix guard above is a guard on the PATH STRING; a symlink
        // anywhere along it would still land the write outside the root. lstat, not
        // stat, for exactly that reason - and every existing component is checked,
        // not only the target.
        if (symlinkOnPath(base, out)) {
          console.warn("[backup] skipped", id + "/" + rel, "- a symlink is on that path");
          continue;
        }
        // A payload may name a declared path that is a DIRECTORY on this box
        // (`paths: ["saves"]`, entry `"saves"`): collect only ever emits files under
        // it, so that entry is crafted, and writing a file over an app's save
        // directory is not something a restore should do.
        if (isDir(out)) {
          console.warn("[backup] skipped", id + "/" + rel, "- a directory lives there");
          continue;
        }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        // 0600 like every other restored file: the documented example
        // (retroarch-share.json) holds network-share credentials, and its own writer
        // goes out of its way to chmod it. A restore must not be the thing that
        // widens it.
        fs.writeFileSync(out, buf, { mode: 0o600 });
        fs.chmodSync(out, 0o600); // mode only applies at creation; an existing file keeps its own
        n++;
      } catch (e) {
        console.warn("[backup] could not restore", id + "/" + rel + ":", e.message);
      }
    }
  }
  if (n) console.log("[backup] restored", n, "app file(s)");
  return { written: n, handled };
}

// A restore parks the app files and they are placed in passes, because the apps
// they belong to do not all exist yet: a package app is fetched from the registry
// afterwards (reconcile.js). Called at boot and again once reconciliation has run;
// `final` drops whatever is left rather than carrying it into the next boot.
function applyPendingAppFiles(opts) {
  const parked = readJson(PENDING_APPFILES);
  const files = parked && parked.appFiles && typeof parked.appFiles === "object" ? parked.appFiles : null;
  if (!files) return { written: 0 };
  apps.loadManifests();
  const { written, handled } = restoreAppFiles(files);
  for (const id of handled) delete files[id];
  const left = Object.keys(files).length;
  if (!left || (opts && opts.final)) {
    if (left) console.warn("[backup] app files never placed (app not installed):", Object.keys(files).join(", "));
    fs.rmSync(PENDING_APPFILES, { force: true });
  } else {
    fs.writeFileSync(PENDING_APPFILES, JSON.stringify({ appFiles: files, at: Date.now() }), { mode: 0o600 });
  }
  return { written };
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
    throw new Error("wrong password", { cause: e });
  } // GCM auth failure
  const payload = JSON.parse(text);
  if (payload.format !== FORMAT) throw new Error("bad backup payload");
  return payload;
}

// ---- apply (restore) ----
// Replaces config.json, rewrites user app manifests (validated, ids bounded),
// restores each app's storage + the sidecar files, parks the localStorage
// snapshot for the launcher, and records the app inventory as the desired state
// the next boot reconciles towards. The caller restarts the shell afterwards
// (plugins re-read creds at boot only) - which is also what starts the
// reconciliation, so it never fights the restore for the same files.
// Is this restore putting the payload back on the box it came from?
//
// Gated on the CLONE flag, like identity.rebrand - and for the same reason
// collect() asks the person on the source box: a re-flash and a clone BOTH
// arrive with a fresh machine id and a default hostname, so the target cannot
// tell them apart by itself. Guessing "different" would be the worse mistake
// here, because restoring a re-flashed box verbatim is the main thing a backup
// is for.
//
// The machine id is still worth reading (collected for a long time, never used,
// and absent from old enough backups): it can only ever force the answer to SAME. A payload
// from this very install is provably not another box's, whatever the seed was
// marked as. It can never make the answer "different", which is what would break
// the re-flash case.
function sameBox(payload) {
  const from = typeof payload.machineId === "string" ? payload.machineId : "";
  if (from && from === identity.machineId()) return true;
  return !payload.clone;
}

// The launcher's own keys, and nothing else, when the snapshot came from another
// box.
//
// localStorage is not the launcher's private store: every LOCAL app shares this
// origin (`http://localhost:<port>`), and one of them is mounted at its root, so
// an app's identity and its login sit in the same snapshot. Carrying that to a
// second box is how two tvboxes ended up as ONE Plex device - same client
// identifier, so plex.tv held a single record, whichever registered last owned
// the name, and neither room could be addressed on purpose. It also put an
// account's media login on a box its owner never linked.
//
// The replay is a MERGE (the launcher only ever setItem()s, it never clears), so
// a key left out here is not lost - the app finds nothing under it and mints or
// asks for its own, which is exactly what a second box should do. This mirrors
// what identity.js does for config: what identifies a box is re-derived on the
// box, never copied onto it.
const OWN_PREFIX = "tvbox.";
function ownStorageOnly(raw, same) {
  // Parsed on BOTH paths, not just the filtered one. The launcher's replay does
  // `JSON.parse` inside a try that returns on failure - before it clears the
  // parked file - so a snapshot that cannot parse would sit there being retried
  // and re-failing on every boot, forever. Better to park nothing.
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (e) {
    console.warn("[backup] localStorage snapshot is not JSON - not replayed");
    return "";
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return "";
  if (same) return raw; // verbatim, byte for byte, once it is known to be usable
  const kept = {};
  const dropped = [];
  for (const [k, v] of Object.entries(snapshot)) {
    if (k.startsWith(OWN_PREFIX)) kept[k] = v;
    else dropped.push(k);
  }
  if (dropped.length)
    console.log(
      "[backup] another box's backup: kept " +
        Object.keys(kept).length +
        " launcher key(s), left " +
        dropped.length +
        " app key(s) for this box to make its own",
    );
  return Object.keys(kept).length ? JSON.stringify(kept) : "";
}

function apply(payload) {
  if (!payload || payload.format !== FORMAT || payload.version > VERSION) throw new Error("bad backup payload");
  if (payload.config && typeof payload.config === "object") {
    // A clone seed carries another box's identity. Re-derive the fields that are
    // identity rather than setup (identity.js) before the config lands, so the two
    // boxes never share an MQTT topic segment or a Connect name. A same-box
    // restore keeps everything verbatim - that is the whole point of it.
    let cfg = payload.config;
    if (payload.clone) {
      // The suffix only matters when both boxes still answer to the same name (a
      // freshly flashed one does); machine-id is per install, so it separates them
      // even before anyone names the new box.
      const r = identity.rebrand(cfg, payload.hostname || "", identity.hostname(), identity.machineId().slice(0, 4));
      cfg = r.config;
      for (const c of r.changed) console.log("[backup] clone: " + c.path + " " + c.from + " -> " + c.to);
      if (!r.changed.length) console.log("[backup] clone: no identity field needed re-deriving");
    }
    config.replaceAll(cfg);
  }
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
  if (payload.appdata && typeof payload.appdata === "object") {
    let n = 0;
    for (const [id, kv] of Object.entries(payload.appdata)) {
      if (n >= MAX_APPDATA) break;
      // appdata.replaceAll re-applies the id / size / key-count guards a live
      // write goes through - a backup file is untrusted input until its password
      // verifies, and even then it may come from a box with other apps on it.
      const r = appdata.replaceAll(id, kv);
      if (r.ok) n++;
      else console.warn("[backup] skipped app storage:", id, "-", r.error);
    }
    if (n) console.log("[backup] restored app storage for", n, "app(s)");
  }
  // The parked file is a HANDOFF, not state: it lives between a restore and the
  // launcher's next load. So a restore defines it the way it defines config -
  // wholesale. Leaving an earlier restore's file behind would let the launcher
  // replay a snapshot this restore decided the box should not have, which is the
  // same stale identity one restore later. Both routes reach it: a foreign
  // snapshot that filters down to nothing, and a payload carrying none at all
  // (`tvbox backup` on the CLI has no renderer to collect from).
  const rawLs = typeof payload.localStorage === "string" ? payload.localStorage : "";
  const ls = rawLs ? ownStorageOnly(rawLs, sameBox(payload)) : "";
  if (ls) fs.writeFileSync(RESTORE_LS, JSON.stringify({ data: ls, at: Date.now() }), { mode: 0o600 });
  else clearPendingLocalStorage();
  // Parked rather than written now: an app's files belong under a root derived
  // from ITS manifest, and a registry package's manifest only arrives with the
  // reconciliation below. applyPendingAppFiles places them in passes.
  if (payload.appFiles && typeof payload.appFiles === "object" && Object.keys(payload.appFiles).length) {
    fs.writeFileSync(PENDING_APPFILES, JSON.stringify({ appFiles: payload.appFiles, at: Date.now() }), { mode: 0o600 });
  }
  // The apps themselves cannot travel in the file; their ids can. Everything the
  // box has to re-acquire (packages, flatpaks, downloaded binaries, extracted
  // bundles) is derived from this list on the next boot - see reconcile.js.
  const desired = reconcile.record(payload.apps, "restore");
  if (desired) console.log("[backup] will re-acquire", desired.apps.length, "app(s) after the restart");
  console.log("[backup] restore applied (from", (payload.hostname || "?") + ",", payload.createdAt + ")");
  return { ok: true, reconcile: desired ? desired.apps.length : 0 };
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

module.exports = {
  collect,
  encrypt,
  decrypt,
  apply,
  ownStorageOnly, // exported for its unit test: the filter is the whole guard
  sameBox,
  applyPendingAppFiles,
  pendingLocalStorage,
  clearPendingLocalStorage,
  MIN_PASSWORD,
};
