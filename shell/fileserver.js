// The box's files over the network, so a computer can drop screensaver images in,
// copy games across, or put a console BIOS where an emulator expects it. A TV can do
// none of that, and none of it should need ssh.
//
// WebDAV, served by rclone - already the box's no-root network tool (the RetroArch
// package mounts SMB with it). No root anywhere: rclone serves a plain directory as
// the ordinary user, and what it serves is a directory of SYMLINKS built from the
// folders the user picked. rclone follows them (--copy-links), writes included.
//
// Nothing about which folders exist is written down here. They are DISCOVERED:
// whatever user data sits in ~/.tvbox (the box's own machinery is filtered out by
// name, so a folder a future app introduces shows up on its own), the home
// directory's own folders, and each installed flatpak app's data dir - which is how
// an emulator's BIOS folder becomes reachable at all. ~/.tvbox itself is offered
// too, with a warning, because it holds the box's settings and the apps' logins.
//
// A password is mandatory: this binds to the LAN on purpose, and there is no
// sensible "just for a minute" version of exposing someone's home directory.
const fs = require("fs");
const os = require("os");
const path = require("path");
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
function portOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT ? n : DEFAULT_PORT;
}
const DEFAULT_USER = "tvbox";
const MIN_PASSWORD = 8;

// ~/.tvbox is both the box's working directory and where some user content lives.
// This is the machinery half - filtered out so the rest can be offered without a
// list of what to share (which would go stale the moment an app adds a folder).
const MACHINERY = new Set([
  "apps", // installed app packages
  "apps-data", // extracted web bundles
  "bin", // no-root binaries (rclone, librespot)
  "cache",
  "current", // OTA symlink
  "fileserver", // where the share root used to live (boxes that ran an early build)
  "librespot-cache",
  "pyenv",
  "__pycache__",
  "shell", // the dev tree
  "shell-userdata", // Chromium profile: app logins live here
  "update",
  "versions", // OTA releases
]);
// Friendlier, stable, ASCII names for the folders a computer will see. Anything not
// named here keeps its own directory name.
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

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}
function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    return [];
  }
}
// A share name has to survive being a path segment on someone else's computer.
function nameOk(n) {
  return typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n);
}

// Everything the box could offer, with a stable id per folder. The id is what the
// launcher stores, so it must not change when the list around it does.
function candidates() {
  const out = [];
  const add = (id, dir, kind, name, warn) => {
    if (!isDir(dir) || !nameOk(name)) return;
    out.push({ id, path: dir, kind, name, warn: !!warn });
  };

  // user content under ~/.tvbox (machinery filtered out, so new folders appear)
  for (const d of subdirs(TVBOX)) {
    if (MACHINERY.has(d) || d.startsWith(".")) continue;
    add("tvbox:" + d, path.join(TVBOX, d), SHARE_NAMES[d] ? d : "other", SHARE_NAMES[d] || d);
  }
  // the box user's own folders (Videos, Music, … - only if they exist)
  for (const d of subdirs(HOME)) {
    if (d.startsWith(".")) continue;
    add("home:" + d, path.join(HOME, d), "home", d);
  }
  // each installed flatpak app's data dir: saves, states and the BIOS folder an
  // emulator reads, which is the whole reason this exists
  for (const d of subdirs(path.join(HOME, ".var", "app"))) {
    add("flatpak:" + d, path.join(HOME, ".var", "app", d), "flatpak", flatpak.shortName(d));
  }
  // and the box's own directory, which is not something to hand out lightly
  add("tvbox:.", TVBOX, "tvbox", "tvbox", true);
  return out;
}

// Build the directory rclone serves: one symlink per picked folder, and nothing
// else. Rebuilt from scratch every time, so an unpicked folder cannot linger.
// Unknown ids are ignored rather than trusted - the id decides a path here.
function buildRoot(ids) {
  const want = new Set(Array.isArray(ids) ? ids : []);
  const picked = candidates().filter((c) => want.has(c.id));
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(LEGACY_ROOT, { recursive: true, force: true }); // only this feature ever made it
  fs.mkdirSync(ROOT, { recursive: true });
  const shared = [];
  const used = new Set();
  for (const c of picked) {
    // two folders can share a basename (~/Videos and ~/.tvbox/Videos); the second
    // one gets a suffix rather than silently replacing the first
    let name = c.name;
    for (let i = 2; used.has(name); i++) name = c.name + "-" + i;
    used.add(name);
    try {
      fs.symlinkSync(c.path, path.join(ROOT, name));
      shared.push({ id: c.id, name, path: c.path });
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
  const { root, shared } = buildRoot(c.folders);
  if (!shared.length) return { ok: false, error: "no_folders" };
  deps.supervisor.spawn(SERVICE, {
    // The credentials go through the environment, never argv: anyone on the box can
    // read a command line.
    env: { ...deps.childEnv(), RCLONE_USER: user, RCLONE_PASS: String(c.pass) },
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
    candidates: candidates().map((x) => ({ id: x.id, kind: x.kind, name: x.name, warn: x.warn })),
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
