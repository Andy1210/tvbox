// The box's files over the network, so a computer can drop screensaver images in,
// copy games across, or put a console BIOS where an emulator expects it. A TV can do
// none of that, and none of it should need ssh.
//
// WebDAV, served by rclone - already the box's no-root network tool (the RetroArch
// package mounts SMB with it). No root anywhere: rclone serves a plain directory as
// the ordinary user, and what it serves is a directory of SYMLINKS built from the
// folders the user picked. rclone follows them (--copy-links), writes included.
//
// Nothing about which folders exist is written down here. They are DISCOVERED
// (contentdirs.js): whatever user data sits in ~/.tvbox (the box's own machinery is
// filtered out by name, so a folder a future app introduces shows up on its own),
// the home directory's own folders, and each installed flatpak app's data dir -
// which is how an emulator's BIOS folder becomes reachable at all. ~/.tvbox itself
// is offered too, with a warning, because it holds the box's settings and the apps'
// logins.
//
// A password is mandatory: this binds to the LAN on purpose, and there is no
// sensible "just for a minute" version of exposing someone's home directory.
const fs = require("fs");
const os = require("os");
const path = require("path");
const contentdirs = require("./contentdirs"); // which folders hold user content
const flatpak = require("./flatpak");

const HOME = os.homedir();
const TVBOX = path.join(HOME, ".tvbox");
const SERVICE = "fileserver"; // supervisor key
// The directory of symlinks rclone serves. Deliberately NOT under ~/.tvbox, which is
// itself one of the folders on offer: a link back to ~/.tvbox would put the share
// root inside the share, and a client walking it would recurse
// (tvbox/fileserver/root/tvbox/fileserver/root/...) forever. ~/.cache is hidden, so
// it is never offered.
const ROOT = path.join(HOME, ".cache", "tvbox", "fileserver-root");
const LEGACY_ROOT = path.join(TVBOX, "fileserver"); // where it used to live
const DEFAULT_PORT = 8098; // 8097 is the shell's HTTP, 8099 the pairing server
// Anything else would fail to bind and then respawn under the supervisor's backoff,
// which looks like "it just doesn't work" from the TV. Privileged ports are out:
// nothing here runs as root.
const MIN_PORT = 1024;
const MAX_PORT = 65535;
// The shell is already listening on these, so rclone would lose the bind and end up
// in the same respawn loop an out-of-range port causes.
const RESERVED_PORTS = new Set([8097, 8099]);
function portOf(v) {
  const n = Number(v);
  const usable = Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT && !RESERVED_PORTS.has(n);
  return usable ? n : DEFAULT_PORT;
}
const DEFAULT_USER = "tvbox";
const MIN_PASSWORD = 8;

// Friendlier, stable, ASCII names for the folders a computer will see. Anything not
// named here keeps its own directory name. These names are also what the launcher
// lists, untranslated: the picker names the folder someone will go looking for in a
// file manager, so a localized label there would name something that isn't served.
const SHARE_NAMES = { ambient: "screensaver", roms: "games" };

// rclone is the same pinned build the RetroArch package installs, so a box that has
// it already needs no second download. Kept here as well because the file server
// must not depend on an optional app being installed (docs/file-server.md).
const RCLONE_DOWNLOAD = {
  bin: "rclone",
  arch: {
    arm64: {
      url: "https://github.com/rclone/rclone/releases/download/v1.74.4/rclone-v1.74.4-linux-arm64.zip",
      sha256: "97685285c9ad6a0cf17d5844115d2a67245af6444db672187074bd9c358de419",
      extract: "rclone-v1.74.4-linux-arm64/rclone",
    },
    x64: {
      url: "https://github.com/rclone/rclone/releases/download/v1.74.4/rclone-v1.74.4-linux-amd64.zip",
      sha256: "fe435e0c36228e7c2f116a8701f01127bb1f694005fc11d1f27186c8bca4115d",
      extract: "rclone-v1.74.4-linux-amd64/rclone",
    },
  },
};

const { isDir, subdirs } = contentdirs;
// A share name has to survive being a path segment on someone else's computer.
const MAX_NAME = 64;
const NAME_RE = new RegExp("^[A-Za-z0-9][A-Za-z0-9._-]{0," + (MAX_NAME - 1) + "}$");
function nameOk(n) {
  return typeof n === "string" && NAME_RE.test(n);
}

// Everything the box could offer, with a stable id per folder. The id is what the
// launcher stores, so it must not change when the list around it does.
function candidates() {
  const out = [];
  const used = new Set();
  const add = (id, dir, name, warn) => {
    if (!isDir(dir) || !nameOk(name)) return;
    // Two folders can share a basename (~/Videos and ~/.tvbox/Videos); the second one
    // gets a suffix rather than silently replacing the first. Resolved HERE, over
    // every candidate in a fixed order, rather than over the picked ones while
    // building the share root: the name is then the same whatever else is shared, so
    // the picker can name what a client will browse and a bookmark cannot move
    // because someone unshared an unrelated folder.
    // The suffix comes out of the name's own length budget, not on top of it: a
    // 64-character folder must not be advertised as a 66-character one.
    let unique = name;
    for (let i = 2; used.has(unique); i++) {
      const suffix = "-" + i;
      unique = name.slice(0, MAX_NAME - suffix.length) + suffix;
    }
    used.add(unique);
    out.push({ id, path: dir, name: unique, warn: !!warn });
  };

  // user content under ~/.tvbox (machinery filtered out, so new folders appear),
  // then the box user's own folders (Videos, Music, … - only if they exist).
  // SHARE_NAMES renames the box's OWN folders only: `~/roms` is the user's, and
  // advertising it as "games" would both mislabel it and move an existing share
  // (a name a computer has bookmarked must not change under it).
  for (const c of contentdirs.userDirs())
    add(c.id, c.path, c.id.startsWith("tvbox:") ? SHARE_NAMES[c.name] || c.name : c.name);
  // each installed flatpak app's data dir: saves, states and the BIOS folder an
  // emulator reads, which is the whole reason this exists
  for (const d of subdirs(path.join(HOME, ".var", "app"))) {
    add("flatpak:" + d, path.join(HOME, ".var", "app", d), flatpak.shortName(d));
  }
  // and the box's own directory, which is not something to hand out lightly
  add("tvbox:.", TVBOX, "tvbox", true);
  return out;
}

// Build the directory rclone serves: one symlink per picked folder, and nothing
// else. Rebuilt from scratch every time, so an unpicked folder cannot linger.
// Unknown ids are ignored rather than trusted - the id decides a path here.
function buildRoot(ids) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  const picked = candidates().filter((c) => want.has(c.id));
  // A permissions or disk problem here is this feature's business, not the shell's:
  // start() is called straight from the settings POST, so a throw would travel up
  // into the HTTP handler and take the whole process with it.
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.rmSync(LEGACY_ROOT, { recursive: true, force: true }); // only this feature ever made it
    fs.mkdirSync(ROOT, { recursive: true });
  } catch (e) {
    console.warn("[fileserver] could not prepare the share root:", e.message);
    return { root: ROOT, shared: [], error: "share_failed" };
  }
  const shared = [];
  for (const c of picked) {
    // c.name is already unique across every candidate (see candidates()), so there is
    // nothing left to resolve here - which is what makes it the name the picker showed
    try {
      fs.symlinkSync(c.path, path.join(ROOT, c.name));
      shared.push({ id: c.id, name: c.name, path: c.path });
    } catch (e) {
      console.warn("[fileserver] could not share", c.path, "-", e.message);
    }
  }
  return { root: ROOT, shared };
}

// The address to type on a computer. The point is the LAN, so a loopback address
// would be useless here.
function lanUrl(port) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) return "http://" + a.address + ":" + port + "/";
    }
  }
  return null;
}

let live = null; // { port, user, shared } while served

// Start (or restart) the server. Refuses without a password, and without any folder
// picked - an empty share is a LAN-exposed listening socket for nothing.
function start(cfg, deps) {
  const c = cfg || {};
  const port = portOf(c.port);
  const user = c.user || DEFAULT_USER;
  if (!c.pass || String(c.pass).length < MIN_PASSWORD) return { ok: false, error: "password_required" };
  if (!deps.onPath("rclone")) return { ok: false, error: "rclone_missing" };
  const { root, shared, error } = buildRoot(c.folders);
  if (error) return { ok: false, error };
  if (!shared.length) return { ok: false, error: "no_folders" };
  deps.supervisor.spawn(SERVICE, {
    // The credentials go through the environment, never argv: anyone on the box can
    // read a command line.
    env: { ...deps.childEnv(), RCLONE_USER: user, RCLONE_PASS: String(c.pass) },
    // What identifies an instance of THIS server across versions, the same way
    // appshares.js names its own. The exact-argv fallback only clears a leftover
    // from the same release; a shell that died without its teardown (a crash exits
    // now, rather than sitting on a dialog) would otherwise leave the previous
    // release's rclone holding the port, still serving on the OLD password.
    reapPrefix: ["rclone", "serve", "webdav", root],
    argv: () => [
      "rclone",
      "serve",
      "webdav",
      root,
      "--addr",
      ":" + port,
      "--copy-links", // the share root is symlinks; follow them, reads and writes
      "--dir-cache-time",
      "10s", // the box writes into these folders too, so don't hold a stale listing
      "--realm",
      "tvbox",
    ],
    stdio: ["ignore", "ignore", "pipe"],
    log: (m) => console.log("[fileserver]", m),
  });
  live = { port, user, shared };
  return { ok: true, port, shared, url: lanUrl(port) };
}

function stop(deps) {
  if (deps && deps.supervisor) deps.supervisor.stop(SERVICE);
  live = null;
  // Leave no dangling view of the box's folders behind.
  fs.rmSync(ROOT, { recursive: true, force: true });
}

// What the launcher shows: whether it runs, where to reach it, what is shared, and
// everything it could share. Never the password.
function status(cfg, deps) {
  const c = cfg || {};
  const port = portOf(c.port);
  return {
    enabled: !!c.enabled,
    running: !!live,
    user: c.user || DEFAULT_USER,
    hasPass: !!c.pass,
    port,
    url: lanUrl(port),
    folders: Array.isArray(c.folders) ? c.folders : [],
    shared: live ? live.shared.map((s) => s.name) : [],
    rclone: !!(deps && deps.onPath("rclone")),
    minPassword: MIN_PASSWORD,
    candidates: candidates().map((x) => ({ id: x.id, name: x.name, warn: x.warn })),
  };
}

module.exports = {
  DEFAULT_PORT,
  portOf,
  DEFAULT_USER,
  MIN_PASSWORD,
  RCLONE_DOWNLOAD,
  ROOT,
  candidates,
  buildRoot,
  lanUrl,
  start,
  stop,
  status,
};
