// Folders an app declares in its manifest, offered read-only to another tvbox on
// the LAN. The reason it exists is save files: a game started in one room should
// be continuable in another, and a household with two boxes has no NAS to put
// them on. A box serves its own, and pulls from a peer on request - never pushes,
// so two boxes playing the same game cannot overwrite each other behind the
// user's back.
//
// Three rules make this different from the LAN file server next door
// (fileserver.js), which exists so a COMPUTER can drop files onto the box:
//
//   * The app does not choose what is shared - its manifest does, and the shell
//     builds the served directory itself. There is no runtime call that takes a
//     path, so an app can only ever offer what was readable before it was
//     installed. `shares.paths` resolve against the app's own root
//     (install.appShareRoot), the same anchor `backup.paths` use.
//   * Read-only, always. Pulling saves needs nothing more, and a writable share
//     would let any peer on the LAN edit an app's data.
//   * Its own credential, not the file server's. The file server's password
//     unlocks everything that box offers, read AND write; a peer that only needs
//     saves gets a token that reaches nothing else and can be revoked on its own.
//
// What this does NOT do: contain a hostile app. An installed app runs with full
// trust and has the network, so it never needed a share to send data anywhere.
// The manifest declaration buys visibility - it is reviewable, listed in
// Settings, and off until someone turns it on - not containment.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const HOME = os.homedir();
// Not under ~/.tvbox: that directory is itself offered by the file server, and a
// share root inside a shared folder makes a client walking it recurse.
const ROOT = path.join(HOME, ".cache", "tvbox", "appshares-root");
const SERVICE = "appshares"; // supervisor key
const DEFAULT_PORT = 8096;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
// The shell (8097, 8100), the file server (8098) and the pairing server (8099)
// are already here; binding onto one of them would leave rclone respawning under
// the supervisor's backoff, which reads as "it just doesn't work" from the TV.
const RESERVED_PORTS = new Set([8097, 8098, 8099, 8100]);
const USER = "tvbox";
const TOKEN_BYTES = 24;

function portOf(v) {
  const n = Number(v);
  const usable = Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT && !RESERVED_PORTS.has(n);
  return usable ? n : DEFAULT_PORT;
}

// A share name is a path segment on this box and a URL segment on the peer that
// fetches it, so it stays in the same alphabet the file server uses for folders.
const MAX_NAME = 64;
const NAME_RE = new RegExp("^[A-Za-z0-9][A-Za-z0-9._-]{0," + (MAX_NAME - 1) + "}$");
function nameOk(n) {
  return typeof n === "string" && NAME_RE.test(n);
}

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// A declared path must still be INSIDE the app's own root once symlinks are
// resolved. The manifest validator already refuses `..` and absolute paths, but
// it cannot see the filesystem: a link planted in the app's directory would
// otherwise widen the share, and rclone follows links (--copy-links).
function contained(root, target) {
  try {
    const r = fs.realpathSync(root);
    const t = fs.realpathSync(target);
    return t === r || t.startsWith(r + path.sep);
  } catch (e) {
    return false;
  }
}

// Every share every installed app declares, with a stable id per share. The id is
// what the enable list and a peer's bookmark store, so it must not move when the
// list around it changes: `<app id>/<name>`, and the name comes from the declared
// path rather than its position in the array.
function entries(manifests, shareRootOf) {
  const out = [];
  for (const m of manifests || []) {
    const rels = m && m.shares && Array.isArray(m.shares.paths) ? m.shares.paths : null;
    if (!rels || !rels.length) continue;
    const root = shareRootOf(m);
    if (!root) continue; // names a flatpak it does not depend on
    const exclude = Array.isArray(m.shares.exclude) ? m.shares.exclude.filter((x) => typeof x === "string") : [];
    const used = new Set();
    for (const rel of rels) {
      const dir = path.join(root, rel);
      // Two declared paths can end in the same segment (…/saves and …/gc/saves);
      // the second gets a suffix out of the name's own length budget rather than
      // replacing the first.
      let name = path.basename(rel);
      if (!nameOk(name)) continue;
      for (let i = 2; used.has(name); i++) {
        const suffix = "-" + i;
        name = path.basename(rel).slice(0, MAX_NAME - suffix.length) + suffix;
      }
      used.add(name);
      out.push({
        id: m.id + "/" + name,
        appId: m.id,
        appName: m.name || m.id,
        name,
        path: dir,
        // Carried on the entry rather than looked up at pull time: the pull already
        // resolves the destination from the manifest, and both must come from the
        // same reading of it.
        exclude,
        // A folder an app has not created yet is still a valid declaration - it
        // appears in Settings, greyed out, instead of vanishing from the list the
        // moment an emulator has not saved anything.
        present: isDir(dir) && contained(root, dir),
      });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// Build the directory rclone serves: <app id>/<share name> -> the app's folder,
// and nothing else. Rebuilt from scratch every time, so a share someone turned
// off cannot linger as a live symlink.
function buildRoot(all, enabledIds) {
  const want = new Set(Array.isArray(enabledIds) ? enabledIds : []);
  const picked = all.filter((e) => want.has(e.id) && e.present);
  // A permissions or disk problem here belongs to this feature, not to the
  // caller: start() runs straight from an HTTP handler, and a throw would take
  // the shell down with it.
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
  } catch (e) {
    console.warn("[appshares] could not prepare the share root:", e.message);
    return { root: ROOT, shared: [], error: "share_failed" };
  }
  const shared = [];
  for (const e of picked) {
    try {
      fs.mkdirSync(path.join(ROOT, e.appId), { recursive: true });
      fs.symlinkSync(e.path, path.join(ROOT, e.appId, e.name));
      shared.push({ id: e.id, appId: e.appId, name: e.name, path: e.path });
    } catch (err) {
      console.warn("[appshares] could not share", e.path, "-", err.message);
    }
  }
  return { root: ROOT, shared };
}

let live = null; // { port, shared } while served

// Start (or restart) the server. Refuses without a token and without anything to
// serve: an empty share is a LAN-exposed socket for nothing.
function start(cfg, deps) {
  const c = cfg || {};
  const port = portOf(c.port);
  if (!c.token) return { ok: false, error: "token_missing" };
  if (!deps.onPath("rclone")) return { ok: false, error: "rclone_missing" };
  const all = deps.entries();
  const { shared, error } = buildRoot(all, c.enabled);
  if (error) return { ok: false, error };
  if (!shared.length) return { ok: false, error: "nothing_shared" };
  deps.supervisor.spawn(SERVICE, {
    // Through the environment, never argv: any process on the box can read a
    // command line.
    env: { ...deps.childEnv(), RCLONE_USER: USER, RCLONE_PASS: String(c.token) },
    argv: () => [
      "rclone",
      "serve",
      "webdav",
      ROOT,
      "--addr",
      ":" + port,
      "--read-only", // a peer pulls; nothing on the LAN may write an app's data
      "--copy-links", // the share root is symlinks, so they have to be followed
      "--dir-cache-time",
      "10s", // the app writes into these folders while they are served
      "--realm",
      "tvbox",
    ],
    stdio: ["ignore", "ignore", "pipe"],
    log: (m) => console.log("[appshares]", m),
  });
  live = { port, shared };
  return { ok: true, port, shared };
}

function stop(deps) {
  if (deps && deps.supervisor) deps.supervisor.stop(SERVICE);
  live = null;
  // Leave no live view of an app's folders behind.
  fs.rmSync(ROOT, { recursive: true, force: true });
}

// What the launcher shows. Never the token: it is a credential, and the pairing
// hand-off is the only thing that should ever repeat it.
function status(cfg, deps) {
  const c = cfg || {};
  const all = (deps && deps.entries && deps.entries()) || [];
  const enabled = new Set(Array.isArray(c.enabled) ? c.enabled : []);
  return {
    enabled: !!c.enabled && enabled.size > 0,
    running: !!live,
    port: portOf(c.port),
    hasToken: !!c.token,
    rclone: !!(deps && deps.onPath && deps.onPath("rclone")),
    shares: all.map((e) => ({
      id: e.id,
      appId: e.appId,
      appName: e.appName,
      name: e.name,
      present: e.present,
      on: enabled.has(e.id),
    })),
    serving: live ? live.shared.map((s) => s.id) : [],
  };
}

module.exports = {
  ROOT,
  SERVICE,
  DEFAULT_PORT,
  USER,
  portOf,
  nameOk,
  newToken,
  contained,
  entries,
  buildRoot,
  start,
  stop,
  status,
};
