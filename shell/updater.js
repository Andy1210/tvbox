// tvbox OTA updater - user-space self-update of the shell, no root ever.
//
// Layout it manages (everything under ~/.tvbox/):
//   versions/<version>/   one extracted release: shell/ + infra/ + manifest.json
//   current -> versions/<version>   the active release (symlink)
//   shell/                the DEV tree (deploy.sh target) - used when `current`
//                         is absent; deploy.sh deletes `current` so a dev
//                         deploy always wins over OTA
//   update/pending        "<prev> <next>" - written at symlink flip, cleared by
//                         the first healthy boot of <next> (commit)
//   update/attempts       respawn counter while pending (run-shell.sh); >3
//                         starts means run-shell.sh flips `current` back
//   update/failed         "<prev> <next>" - a rollback happened; shown in the
//                         UI until retried/dismissed
//   update/last           JSON {from,to,at} - last successful update (About)
//
// The updater only downloads/extracts/flips; the health check + rollback live
// in run-shell.sh (it must work even when THIS code is the broken half), and
// the commit runs on the next boot (onLauncherLoaded). Update feed is a static
// update.json (GitHub Releases asset by default, config.update.feed to
// self-host): { feedVersion:1, version, url, sha256, notes?{en,hu} }.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const config = require("./config");
const { isLanUrl } = require("./netguard"); // shared LAN/loopback trust rule (feed may be self-hosted http)
const pkg = require("./package.json");

const TVBOX = path.join(os.homedir(), ".tvbox");
const VERSIONS = path.join(TVBOX, "versions");
const CURRENT = path.join(TVBOX, "current");
const UPDATE_DIR = path.join(TVBOX, "update");
const PENDING = path.join(UPDATE_DIR, "pending");
const ATTEMPTS = path.join(UPDATE_DIR, "attempts");
const FAILED = path.join(UPDATE_DIR, "failed");
const LAST = path.join(UPDATE_DIR, "last");

const DEFAULT_FEED = "https://github.com/Andy1210/tvbox/releases/latest/download/update.json";
const FEED_TIMEOUT_MS = 15000;
const TARBALL_TIMEOUT_MS = 10 * 60 * 1000;
const TARBALL_MAX_BYTES = 300e6;
const MIN_FREE_BYTES = 1.5e9; // tarball + extract + possible fresh node_modules (Electron ~700MB)
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const AUTO_TICK_MS = 30 * 60 * 1000;
const AUTO_HOURS = [3, 4, 5]; // nightly auto-apply window (local time)
const BOOT_GRACE_MS = 10 * 60 * 1000; // no auto-apply right after boot (commit must settle first)

// Files a release's infra/ may install into ~/.tvbox (never anywhere else, and
// only after the new shell booted healthy - a broken release must not get to
// replace run-shell.sh, which is the rollback mechanism itself).
// Must mirror deploy/infra.list (the single source of truth for what ships in
// every channel) - updater.test.js fails on drift, so a file added to the list
// can't silently be missing from the OTA channel again (how the v1.1.0 remote
// bridge went missing).
const INFRA_FILES = [
  "run-shell.sh",
  "cec_uinput_bridge.py",
  "cec_vendor_shim.c", // the bridge compiles it on start (mtime check)
  "remote_input_bridge.py", // BT/USB remote bridge (the tvbox-remote user service)
  "cursor_idle_hide.py", // idle mouse-cursor hider (launched from labwc-autostart)
  "tvbox",
  "provision.sh",
  "labwc-autostart",
  "tvbox-cec.service",
  "tvbox-remote.service",
  "tvbox-flatpak-update.service",
  "tvbox-flatpak-update.timer",
];
const USER_UNITS = [
  "tvbox-cec.service",
  "tvbox-remote.service",
  "tvbox-flatpak-update.service",
  "tvbox-flatpak-update.timer",
];
const EXECUTABLE = ["run-shell.sh", "tvbox"];

let hooks = { isIdle: () => true, restart: null }; // main.js provides both; the CLI neither
let state = "idle"; // idle | checking | downloading | installing | restarting | error
let error = null;
let latest = null; // validated feed object from the last successful check
let lastCheckAt = null;
let bootAt = Date.now();
let committed = false;

function init(h) {
  hooks = { ...hooks, ...(h || {}) };
}

function versionOk(v) {
  return typeof v === "string" && /^[0-9A-Za-z._-]{1,40}$/.test(v);
}

// Numeric-aware version compare ("1.10.0" > "1.9.1"); non-numeric parts
// compare as strings so "1.1.0-beta" still orders deterministically.
function cmpVer(a, b) {
  const pa = String(a).split(/[.-]/),
    pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || "",
      y = pb[i] || "";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN,
      ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!isNaN(nx) && !isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// versions/<v> when running an OTA release, null when running the dev tree.
function runningRelease() {
  const rel = path.dirname(__dirname);
  return path.dirname(rel) === VERSIONS ? path.basename(rel) : null;
}

function readPair(file) {
  try {
    const [prev, next] = fs.readFileSync(file, "utf8").trim().split(/\s+/);
    return prev && next ? { prev, next } : null;
  } catch (e) {
    return null;
  }
}
function readLast() {
  try {
    return JSON.parse(fs.readFileSync(LAST, "utf8"));
  } catch (e) {
    return null;
  }
}

function feedUrl() {
  const u = config.rawUpdate() || {};
  return typeof u.feed === "string" && /^https?:\/\//.test(u.feed) ? u.feed : DEFAULT_FEED;
}
function autoEnabled() {
  const u = config.rawUpdate() || {};
  return u.auto !== false; // default ON - the whole point of OTA
}

// OS side: unattended-upgrades installs security updates but NEVER reboots
// (provision.sh sets Automatic-Reboot=false); the kernel/libc hooks drop
// /var/run/reboot-required, which we surface as a gentle Settings hint.
function osStatus() {
  const required = fs.existsSync("/var/run/reboot-required");
  let packages = [];
  if (required) {
    try {
      packages = [
        ...new Set(
          fs
            .readFileSync("/var/run/reboot-required.pkgs", "utf8")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ].slice(0, 10);
    } catch (e) {
      /* hint file is optional */
    }
  }
  return { rebootRequired: required, packages };
}

function status() {
  const current = pkg.version || "0";
  return {
    current,
    release: runningRelease(), // null = dev tree (deploy.sh)
    state,
    error,
    latest: latest ? { version: latest.version, notes: latest.notes || null } : null,
    available: !!(latest && cmpVer(latest.version, current) > 0),
    lastCheckAt,
    auto: autoEnabled(),
    failed: readPair(FAILED),
    last: readLast(),
    os: osStatus(),
  };
}

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store", redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function check() {
  if (state === "downloading" || state === "installing" || state === "restarting") return status();
  state = "checking";
  error = null;
  try {
    const feed = await fetchJson(feedUrl(), FEED_TIMEOUT_MS);
    if (!feed || feed.feedVersion !== 1) throw new Error("bad feed shape");
    if (!versionOk(feed.version)) throw new Error("bad feed version");
    if (!/^https:\/\//.test(feed.url || "") && !isLanUrl(feed.url))
      throw new Error("feed url must be https (or LAN http)");
    if (!/^[0-9a-f]{64}$/i.test(feed.sha256 || "")) throw new Error("feed needs a sha256");
    latest = feed;
    lastCheckAt = Date.now();
    state = "idle";
  } catch (e) {
    state = "error";
    error = "check: " + String(e.message || e).slice(0, 120);
    console.warn("[updater]", error);
  }
  return status();
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}
function sha256Of(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (e) {
    return null;
  }
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15 * 60 * 1000, maxBuffer: 8e6, ...opts }, (e, _o, err) =>
      e ? reject(new Error(cmd + " failed: " + String(err || e.message).slice(0, 200))) : resolve(),
    );
  });
}

function freeBytes() {
  try {
    const s = fs.statfsSync(TVBOX);
    return s.bavail * s.bsize;
  } catch (e) {
    return null;
  }
}

async function download(url, dest) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TARBALL_TIMEOUT_MS);
  const out = fs.createWriteStream(dest);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    // Enforce the size cap WHILE streaming, not after buffering: reject a
    // declared-oversize body up front, and count the real bytes as they arrive
    // so a huge (or lying-Content-Length) response can't exhaust RAM/disk
    // before a post-hoc check. NaN (absent header) compares false -> streams.
    if (Number(res.headers.get("content-length")) > TARBALL_MAX_BYTES) throw new Error("tarball too large");
    let total = 0;
    for await (const chunk of res.body || []) {
      total += chunk.length;
      if (total > TARBALL_MAX_BYTES) {
        ctl.abort(); // stop the transfer, not just the file write
        throw new Error("tarball too large");
      }
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(dest, { force: true }); // never leave a truncated tarball behind
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Download + verify + extract + node_modules + atomic flip. Runs in the
// background; the UI polls status(). The actual restart is main.js's hook
// (app.quit -> the autostart respawn loop restarts run-shell.sh, which starts `current`).
async function apply() {
  if (state === "downloading" || state === "installing" || state === "restarting") return status();
  if (!latest) await check();
  const cur = pkg.version || "0";
  if (!latest || cmpVer(latest.version, cur) <= 0) return status();
  const v = latest.version;
  const stage = path.join(UPDATE_DIR, "stage");
  const tarball = path.join(UPDATE_DIR, "release.tar.gz");
  try {
    const free = freeBytes();
    if (free != null && free < MIN_FREE_BYTES) throw new Error("not enough free disk space");
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    fs.rmSync(FAILED, { force: true }); // an explicit apply is the retry
    state = "downloading";
    error = null;
    console.log("[updater] downloading", v, "from", latest.url);
    await download(latest.url, tarball);
    const sum = await sha256File(tarball);
    if (sum !== latest.sha256.toLowerCase()) throw new Error("sha256 mismatch");
    state = "installing";
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    await run("tar", ["-xzf", tarball, "-C", stage]);
    fs.rmSync(tarball, { force: true });
    // the tarball must actually BE the version the feed promised
    const stagedPkg = JSON.parse(fs.readFileSync(path.join(stage, "shell", "package.json"), "utf8"));
    if (stagedPkg.version !== v) throw new Error("tarball version " + stagedPkg.version + " != feed " + v);
    // node_modules: hardlink-copy from the running tree when the lockfile is
    // unchanged (instant, near-zero disk), full `npm ci` otherwise (Electron
    // re-download, minutes - the UI shows "installing").
    const runningLock = path.join(__dirname, "package-lock.json");
    const stagedLock = path.join(stage, "shell", "package-lock.json");
    const runningLockSum = sha256Of(runningLock); // hash once, compare once
    const sameLock = runningLockSum && runningLockSum === sha256Of(stagedLock);
    if (sameLock && fs.existsSync(path.join(__dirname, "node_modules"))) {
      console.log("[updater] lockfile unchanged - hardlinking node_modules");
      await run("cp", ["-al", path.join(__dirname, "node_modules"), path.join(stage, "shell", "node_modules")]);
    } else {
      console.log("[updater] lockfile changed - npm ci (this can take minutes)");
      await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: path.join(stage, "shell") });
    }
    // move into place + atomic-ish symlink flip, with the rollback marker
    // written FIRST so a crash between the two steps still rolls back cleanly
    fs.mkdirSync(VERSIONS, { recursive: true });
    const dest = path.join(VERSIONS, v);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(stage, dest);
    const prev = runningRelease() || "-"; // "-" = dev tree (run-shell.sh removes `current` on rollback)
    fs.writeFileSync(PENDING, prev + " " + v + "\n");
    fs.rmSync(ATTEMPTS, { force: true });
    const tmp = CURRENT + ".new";
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(dest, tmp);
    fs.renameSync(tmp, CURRENT);
    state = "restarting";
    console.log("[updater] flipped to", v, "- restarting shell");
    if (hooks.restart) setTimeout(() => hooks.restart(), 1500); // let the HTTP response out first
  } catch (e) {
    state = "error";
    error = "apply: " + String(e.message || e).slice(0, 160);
    console.warn("[updater]", error);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
  }
  return status();
}

// First healthy boot of a freshly flipped release: clear the rollback markers,
// record the update, install the release's infra files (run-shell.sh, CEC
// bridge, systemd user units - AFTER health, so a broken release can never
// replace the rollback machinery), and prune old versions (keep prev for one
// manual rollback). Called by main.js on the launcher's first did-finish-load.
function onLauncherLoaded() {
  if (committed) return;
  committed = true;
  const pending = readPair(PENDING);
  if (!pending) return;
  const rel = runningRelease();
  if (pending.next !== rel) return; // not us - run-shell.sh owns this state
  fs.rmSync(PENDING, { force: true });
  fs.rmSync(ATTEMPTS, { force: true });
  try {
    fs.writeFileSync(LAST, JSON.stringify({ from: pending.prev, to: rel, at: Date.now() }));
  } catch (e) {
    /* cosmetic */
  }
  console.log("[updater] committed", pending.prev, "->", rel);
  try {
    syncInfra(rel);
  } catch (e) {
    console.warn("[updater] infra sync:", e.message);
  }
  try {
    prune(rel, pending.prev);
  } catch (e) {
    console.warn("[updater] prune:", e.message);
  }
}

function syncInfra(rel) {
  const src = path.join(VERSIONS, rel, "infra");
  if (!fs.existsSync(src)) return;
  for (const name of INFRA_FILES) {
    const f = path.join(src, name);
    if (!fs.existsSync(f)) continue;
    fs.copyFileSync(f, path.join(TVBOX, name));
    if (EXECUTABLE.includes(name)) fs.chmodSync(path.join(TVBOX, name), 0o755);
  }
  // labwc session autostart + systemd user units live outside ~/.tvbox
  const auto = path.join(src, "labwc-autostart");
  if (fs.existsSync(auto)) {
    const dst = path.join(os.homedir(), ".config", "labwc", "autostart");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(auto, dst);
    fs.chmodSync(dst, 0o755);
  }
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  let units = false;
  for (const name of USER_UNITS) {
    const f = path.join(src, name);
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(unitDir, name));
      units = true;
    }
  }
  // reload only - restarting tvbox-cec here would drop the remote mid-session;
  // the new unit takes effect on the next boot.
  if (units) execFile("systemctl", ["--user", "daemon-reload"], () => {});
}

function prune(keep, alsoKeep) {
  if (!fs.existsSync(VERSIONS)) return;
  for (const name of fs.readdirSync(VERSIONS)) {
    if (name === keep || name === alsoKeep) continue;
    fs.rmSync(path.join(VERSIONS, name), { recursive: true, force: true });
    console.log("[updater] pruned old version", name);
  }
}

function clearFailed() {
  fs.rmSync(FAILED, { force: true });
  return status();
}

// Nightly auto-apply: only in the 3-6h window, only when the box is idle
// (nothing playing, no app open), never right after boot, and never a version
// that already rolled back once (that needs a human + a fixed release).
function autoTick() {
  if (!autoEnabled() || !hooks.restart) return;
  if (Date.now() - bootAt < BOOT_GRACE_MS) return;
  if (!AUTO_HOURS.includes(new Date().getHours())) return;
  if (!hooks.isIdle()) return;
  const s = status();
  if (!s.available || s.state !== "idle") return;
  if (s.failed && s.failed.to === latest.version) return;
  console.log("[updater] nightly auto-update ->", latest.version);
  apply();
}

function startSchedulers() {
  setTimeout(check, 90 * 1000); // boot check (after the boot rush)
  setInterval(check, CHECK_EVERY_MS);
  setInterval(autoTick, AUTO_TICK_MS);
}

module.exports = {
  init,
  status,
  check,
  apply,
  clearFailed,
  onLauncherLoaded,
  startSchedulers,
  cmpVer,
  DEFAULT_FEED,
  // exported for updater.test.js - the deploy/infra.list cross-check
  INFRA_FILES,
  USER_UNITS,
};
