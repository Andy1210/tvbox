// A NAS as a source, so a film can live on the network instead of on the box.
//
// **SMB, not NFS.** Mounting NFS goes through the mount syscall and therefore
// needs root, which nothing here is allowed to use at runtime. rclone mounts SMB
// over FUSE as the ordinary user, and it is already the box's no-root network tool
// (the file server serves WebDAV with the same binary, and the RetroArch package
// mounts its game library with it).
//
// Each share is mounted at `~/.tvbox/shares/<name>`, which is also why that folder
// is machinery to contentdirs.js: a share is offered as a source in its own right,
// with its own name, and must not appear a second time as a folder inside a
// "shares" one.
//
// The credentials reach rclone through its ENVIRONMENT rather than an rclone.conf,
// so they live in exactly one file (config.json, chmod 600) instead of being copied
// into a second one next to the mount. rclone still wants its password "obscured",
// which is a reversible encoding and not encryption - the file permissions are what
// protects it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const HOME = os.homedir();
const SHARES_DIR = path.join(HOME, ".tvbox", "shares");
const REMOTE = "tvboxsmb"; // rclone remote name; only ever used internally
const SVC = (id) => "share:" + id; // supervisor key
const MAX_SHARES = 8;
const TEST_TIMEOUT_MS = 20000;

// What a film needs from a network mount, which is NOT what a game needs. rclone's
// `full` cache mode downloads a whole file in the background: right for a 700 MB
// disc image an emulator seeks around in, wrong for a 60 GB film someone watches
// once. `minimal` keeps reads ranged, and the read-ahead is what makes playback
// smooth over wifi.
const VFS_ARGS = [
  "--read-only", // this is a player, and a mistyped delete over SMB is not recoverable
  "--vfs-cache-mode",
  "minimal",
  "--vfs-read-ahead",
  "128M",
  "--buffer-size",
  "64M",
  "--dir-cache-time",
  "30s",
  "--no-modtime",
];

// A host name or an IP. No scheme, no path, no credentials.
function hostOk(h) {
  return typeof h === "string" && h.length <= 253 && /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(h);
}
// An SMB share name. Windows is permissive here; this stays with what a NAS
// actually produces and rules out separators and control characters.
function shareOk(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 80 && !/[/\\:*?"<>|\x00-\x1f]/.test(s);
}
// The folder the share appears as. It is a path segment and a source name, so a
// slug - and the id, so two shares cannot land on one mount point.
function nameOk(n) {
  return typeof n === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(n);
}
// A sub-folder inside the share, so a box can mount the films and not the whole
// disk. Slash-separated, empty means the share's own root. Real folder names carry
// spaces and accents, so this rejects what breaks a path rather than restricting it
// to a slug.
function pathOk(p) {
  if (typeof p !== "string") return false;
  if (p === "") return true;
  if (p.length > 400 || p.startsWith("/") || p.endsWith("/") || p.includes("//")) return false;
  if (/[\\\x00-\x1f]/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const mountPoint = (s) => path.join(SHARES_DIR, s.name);
const remotePath = (s) => REMOTE + ":" + s.share + (s.path ? "/" + s.path : "");

// rclone's own reversible encoding for a stored password. Fed over stdin so the
// plain one never appears in the process list.
function obscure(pass) {
  return execFileSync("rclone", ["obscure", "-"], { input: String(pass), encoding: "utf8" }).trim();
}

// Validate and normalise what a form sent into a stored share. Throws with a short
// reason the form can show. `stored` is the share being edited, if any: an omitted
// password keeps what is stored and an empty one clears it, which is the same
// contract every other credential form here follows (a guest share with no password
// is legitimate, so "unchanged" and "cleared" cannot both be falsy).
function shareFrom(input, stored) {
  const i = input || {};
  const host = String(i.host || "").trim();
  const shareName = String(i.share || "").trim();
  const user = String(i.user || "").trim();
  const domain = String(i.domain || "").trim();
  const name = String(i.name || shareName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const sub = String(i.path || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!hostOk(host)) throw new Error("bad_host");
  if (!shareOk(shareName)) throw new Error("bad_share");
  if (user.length > 128 || domain.length > 128) throw new Error("bad_user");
  if (!nameOk(name)) throw new Error("bad_name");
  if (!pathOk(sub)) throw new Error("bad_path");
  const pass = i.pass === undefined ? (stored && stored.pass) || "" : i.pass ? obscure(String(i.pass)) : "";
  return { name, host, share: shareName, path: sub, user, domain, pass };
}

// rclone reads a remote's settings from RCLONE_CONFIG_<REMOTE>_<KEY>.
function envFor(s, baseEnv) {
  const p = "RCLONE_CONFIG_" + REMOTE.toUpperCase() + "_";
  return {
    ...baseEnv,
    [p + "TYPE"]: "smb",
    [p + "HOST"]: s.host,
    [p + "USER"]: s.user || "guest",
    [p + "PASS"]: s.pass || "",
    ...(s.domain ? { [p + "DOMAIN"]: s.domain } : {}),
  };
}

const mountArgs = (s) => ["rclone", "mount", remotePath(s), mountPoint(s), ...VFS_ARGS];

// A FUSE mount shows up in /proc/self/mountinfo. readdir is not a usable test: an
// unmounted mount point is simply an empty directory. (The path is an argument so
// a test can hand it a captured one - what is mounted is not something a test can
// arrange.)
function isMounted(s, mountinfo) {
  const point = mountPoint(s);
  try {
    return fs
      .readFileSync(mountinfo || "/proc/self/mountinfo", "utf8")
      .split("\n")
      .some((line) => line.split(" ").includes(point));
  } catch (e) {
    return false;
  }
}

// A stale FUSE mount (rclone killed hard, or the box lost power while mounted)
// leaves a directory that answers EIO forever, and a fresh mount over it fails.
// Clearing it is cheap, so it runs before every attempt.
function clearStale(s) {
  try {
    execFileSync("fusermount", ["-u", "-z", mountPoint(s)], { stdio: "ignore" });
  } catch (e) {
    /* not mounted, which is the normal case */
  }
}

// Try the credentials without mounting, and list what is at the configured path so
// a form can be used to walk down to where the films actually are. A failure
// carries rclone's own last line - things like NT_STATUS_LOGON_FAILURE are worth
// showing as they are.
function rcloneList(target, s, deps, cb) {
  const d = deps || {};
  (d.execFile || execFile)(
    "rclone",
    ["lsd", target, "--low-level-retries", "1", "--retries", "1"],
    { env: envFor(s, d.env || process.env), timeout: TEST_TIMEOUT_MS },
    (err, stdout, stderr) => {
      if (!err) return cb({ ok: true, dirs: dirNames(stdout) });
      const lines = String(stderr || err.message)
        .trim()
        .split("\n")
        .filter(Boolean);
      cb({ ok: false, error: (lines[lines.length - 1] || "failed").slice(0, 200) });
    },
  );
}

// rclone's `lsd` prints fixed columns and then the name, which may itself contain
// spaces - so the name is everything from the fifth field on.
function dirNames(stdout) {
  return String(stdout)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.trim().split(/\s+/).slice(4).join(" "))
    .filter(Boolean)
    .slice(0, 60);
}

// Everything the server offers, so a form does not have to guess a share name.
// rclone lists shares when the path after the remote is empty, which is why this
// validates the connection fields only.
function listShares(input, deps, cb) {
  const host = String((input && input.host) || "").trim();
  if (!hostOk(host)) return cb({ ok: false, error: "bad_host" });
  const s = {
    host,
    user: String((input && input.user) || "").trim(),
    domain: String((input && input.domain) || "").trim(),
    pass: input && input.pass ? obscure(String(input.pass)) : (input && input.storedPass) || "",
  };
  rcloneList(REMOTE + ":", s, deps, (r) => cb(r.ok ? { ok: true, shares: r.dirs } : r));
}

function test(share, deps, cb) {
  rcloneList(remotePath(share), share, deps, cb);
}

// Mount everything configured (and unmount what is no longer). Called on boot and
// after every change, so it is the one place that decides what should be running.
function apply(shares, deps) {
  const list = Array.isArray(shares) ? shares.slice(0, MAX_SHARES) : [];
  const d = deps || {};
  const wanted = new Set(list.map((s) => SVC(s.name)));
  for (const name of d.supervisor.names ? d.supervisor.names() : []) {
    if (name.startsWith("share:") && !wanted.has(name)) d.supervisor.stop(name);
  }
  if (!list.length) return { ok: true, mounted: [] };
  if (!d.onPath("rclone")) return { ok: false, error: "rclone_missing" };
  const mounted = [];
  for (const s of list) {
    try {
      clearStale(s);
      fs.mkdirSync(mountPoint(s), { recursive: true });
    } catch (e) {
      console.warn("[shares] could not prepare", mountPoint(s), "-", e.message);
      continue;
    }
    d.supervisor.spawn(SVC(s.name), {
      // The credentials go through the environment, never argv: anyone on the box
      // can read a command line.
      env: envFor(s, d.childEnv()),
      argv: () => mountArgs(s),
      stdio: ["ignore", "ignore", "pipe"],
      log: (m) => console.log("[shares]", s.name, m),
    });
    mounted.push(s.name);
  }
  return { ok: true, mounted };
}

function stopAll(deps) {
  const d = deps || {};
  for (const name of d.supervisor && d.supervisor.names ? d.supervisor.names() : []) {
    if (name.startsWith("share:")) d.supervisor.stop(name);
  }
}

// What the launcher sees. Never a password - only whether one is stored.
function status(shares, deps) {
  const list = Array.isArray(shares) ? shares : [];
  return {
    rclone: !!(deps && deps.onPath("rclone")),
    max: MAX_SHARES,
    shares: list.map((s) => ({
      name: s.name,
      host: s.host,
      share: s.share,
      path: s.path || "",
      user: s.user || "",
      domain: s.domain || "",
      hasPass: !!s.pass,
      mountPoint: mountPoint(s),
      mounted: isMounted(s),
    })),
  };
}

// The mounted ones, as browsable roots (browse.js turns these into sources). A
// configured share that is not mounted is not a place: the box may be off the
// network, or rclone may not have come up yet.
function mountedRoots(shares, mountinfo) {
  return (Array.isArray(shares) ? shares : [])
    .filter((s) => isMounted(s, mountinfo))
    .map((s) => ({ name: s.name, path: mountPoint(s) }));
}

module.exports = {
  SHARES_DIR,
  MAX_SHARES,
  VFS_ARGS,
  hostOk,
  shareOk,
  nameOk,
  pathOk,
  shareFrom,
  envFor,
  mountArgs,
  mountPoint,
  remotePath,
  isMounted,
  dirNames,
  listShares,
  test,
  apply,
  stopAll,
  status,
  mountedRoots,
};
