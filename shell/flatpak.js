// The one place that knows about flatpak. Two kinds of app depend on one, and the
// difference decides what "update" even means for them:
//
//   requires.flatpak         the app RUNS the flatpak (RetroArch, a native app):
//                            updating the flatpak IS updating the app.
//   install.source.flatpak   the app's web bundle is EXTRACTED from the flatpak
//                            (Plex): the bundle is a COPY, so it stays behind the
//                            moment the flatpak moves, and has to be re-extracted.
//
// What says a flatpak moved is its COMMIT, not its version: a rebuild can ship new
// files under the same version string, and an extracted copy still has to notice.
// The version is for the user, the commit is for us.
//
// Writes are always `--user`, which needs no root - the same reason a flatpak dep
// can be installed from the TV at all. Reads accept a system install too, since
// extracting files from one works fine.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const nativeapp = require("./native"); // ONE ref validator, shared with the launch path

const BASES = ["/var/lib/flatpak/app", path.join(os.homedir(), ".local", "share", "flatpak", "app")];
const FLATHUB_REPO = "https://flathub.org/repo/flathub.flatpakrepo";
// HOME and the store panel both poll; one `flatpak list` serves a burst of calls.
const LIST_TTL_MS = 10000;
const LIST_TIMEOUT_MS = 15000;
const INFO_TIMEOUT_MS = 15000;
// An app plus its runtime is a multi-hundred-MB pull that can time out on a slow
// link; ostree resumes from the objects it already has, so a retry continues.
const INSTALL_TRIES = 3;

const refOk = nativeapp.flatpakRefOk;

// flatpak's arch names differ from Node's (arm64 -> aarch64, x64 -> x86_64).
function arch() {
  return process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
}

// The app's "active" dir - what an extract path like "files/resources/..." is
// resolved against. Its files/ subdir existing IS the definition of installed.
function root(ref, a) {
  const want = a || "x86_64";
  for (const base of BASES) {
    const dir = path.join(base, ref, want, "stable", "active");
    if (fs.existsSync(path.join(dir, "files"))) return dir;
  }
  return null;
}
function isInstalled(ref, a) {
  return !!root(ref, a || arch());
}

// Where a flatpak keeps its per-user data (`config/`, `data/`, `cache/` inside it).
// Not derived from `root()`: that is the read-only installed tree, this is the
// writable one - which is why it exists whether or not the app is installed yet,
// and why a settings restore can put an app's own files there before its flatpak
// arrives. Always the box user's home, never a system path.
function dataDir(ref) {
  if (!refOk(ref)) return null;
  return path.join(os.homedir(), ".var", "app", ref);
}

// What a missing flatpak dep is CALLED on the TV: "needs RetroArch" reads far
// better than "needs org.libretro.RetroArch" on a 10-foot tile.
function shortName(ref) {
  const parts = String(ref).split(".");
  return parts[parts.length - 1] || String(ref);
}

// Every flatpak an app depends on, each with the arch that app needs it in: the
// refs it RUNS (box arch - a native app must be the real thing) plus the one its
// bundle is extracted FROM (whatever the recipe names, since any arch's files
// work). A ref named in both keeps the running arch; it is the same download.
function refsFor(m) {
  const out = new Map();
  for (const ref of (m && m.requires && m.requires.flatpak) || []) if (refOk(ref)) out.set(ref, { ref, arch: arch() });
  const src = m && m.install && m.install.source;
  if (src && src.type === "flatpak" && refOk(src.ref) && !out.has(src.ref))
    out.set(src.ref, { ref: src.ref, arch: src.arch || "x86_64" });
  return [...out.values()];
}

// `application \t version \t arch \t installation` per line. A ref installed for
// both arches keeps the box's, which is the one an app runs.
function parseList(text) {
  const out = new Map();
  for (const line of String(text).split("\n")) {
    const [ref, version, a, installation] = line.split("\t").map((s) => (s || "").trim());
    if (!refOk(ref)) continue;
    const prev = out.get(ref);
    if (prev && prev.arch === arch()) continue;
    out.set(ref, { ref, version, arch: a, installation });
  }
  return out;
}

let listCache = { at: 0, map: null };
function invalidate() {
  listCache = { at: 0, map: null };
}
// Every installed app flatpak -> { version, arch, installation }. Async because
// this is read from the HTTP path, and a failure is not cached: a flatpak that was
// mid-install must not read as absent for the next ten seconds.
function list(opts) {
  if (!(opts && opts.fresh) && listCache.map && Date.now() - listCache.at < LIST_TTL_MS)
    return Promise.resolve(listCache.map);
  return new Promise((resolve) => {
    execFile(
      "flatpak",
      ["list", "--app", "--columns=application,version,arch,installation"],
      { timeout: LIST_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(new Map());
        const map = parseList(stdout);
        listCache = { at: Date.now(), map };
        resolve(map);
      },
    );
  });
}

// The commit an installed ref sits at, or null. Two of these compared across an
// update are what say whether anything actually changed.
function commitSync(ref, a) {
  if (!refOk(ref)) return null;
  try {
    return (
      execFileSync("flatpak", ["info", "--arch=" + (a || arch()), "--show-commit", ref], {
        encoding: "utf8",
        timeout: INFO_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch (e) {
    return null; // not installed, or an ambiguous/unknown ref
  }
}
function commitsSync(items) {
  const out = {};
  for (const it of items) out[it.ref] = commitSync(it.ref, it.arch);
  return out;
}

function addFlathub() {
  try {
    execFileSync("flatpak", ["remote-add", "--user", "--if-not-exists", "flathub", FLATHUB_REPO], { stdio: "inherit" });
  } catch (e) {
    /* may already exist */
  }
}

// `flatpak install --user` a ref. Root is never involved, which is what makes a
// flatpak dep UI-installable at all (unlike apt).
function installUser(ref, a, log) {
  log = log || (() => {});
  if (!refOk(ref)) throw new Error("bad flatpak ref: " + ref);
  addFlathub();
  let lastErr = null;
  for (let attempt = 1; attempt <= INSTALL_TRIES; attempt++) {
    log("flatpak install --user " + ref + " (" + a + ")" + (attempt > 1 ? " retry " + attempt : "") + " …");
    try {
      execFileSync("flatpak", ["install", "--user", "-y", "--noninteractive", "--arch=" + a, "flathub", ref], {
        stdio: "inherit",
      });
      invalidate();
      return;
    } catch (e) {
      lastErr = e;
      if (isInstalled(ref, a)) {
        invalidate();
        return; // it landed despite a nonzero exit
      }
    }
  }
  throw new Error(ref + ": flatpak install failed after " + INSTALL_TRIES + " tries: " + (lastErr && lastErr.message));
}

// Update exactly these refs, in place. Sync and stdio-inherited because every
// caller is a CLI process whose output IS the progress the shell logs; a ref that
// is already current exits 0 with "Nothing to do".
function updateSync(items, log) {
  log = log || (() => {});
  for (const it of items) {
    if (!refOk(it.ref)) throw new Error("bad flatpak ref: " + it.ref);
    log("flatpak update --user " + it.ref + " (" + it.arch + ") …");
    execFileSync("flatpak", ["update", "--user", "-y", "--noninteractive", "--arch=" + it.arch, it.ref], {
      stdio: "inherit",
    });
  }
  invalidate();
}

module.exports = {
  arch,
  root,
  dataDir,
  isInstalled,
  shortName,
  refsFor,
  parseList,
  list,
  invalidate,
  commitSync,
  commitsSync,
  installUser,
  updateSync,
  refOk,
};
