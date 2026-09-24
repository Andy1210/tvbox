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
const fsutil = require("./fsutil");
const compositor = require("./compositor"); // a release may require it (see REQUIREMENTS)
const sysupdate = require("./sysupdate"); // the root half a release may require (see REQUIREMENTS)
const canary = require("./canary"); // staged rollout across boxes on one broker
const { isLiteralLanUrl, isAllowedFetchUrl, guardedFetch } = require("./netguard"); // shared self-hosted trust rule (feed may be http to a LAN address)
const pkg = require("./package.json");

const TVBOX = path.join(os.homedir(), ".tvbox");
const VERSIONS = path.join(TVBOX, "versions");
const CURRENT = path.join(TVBOX, "current");
const UPDATE_DIR = path.join(TVBOX, "update");
const PENDING = path.join(UPDATE_DIR, "pending");
const ATTEMPTS = path.join(UPDATE_DIR, "attempts");
const FAILED = path.join(UPDATE_DIR, "failed");
const LAST = path.join(UPDATE_DIR, "last");
const SYNCED = path.join(UPDATE_DIR, "synced"); // the release whose infra files are in place
const CANARY_WAIT = path.join(UPDATE_DIR, "canary-wait"); // {version, since}: when a follower first saw a release

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
  "gamepad_shim.py", // unrecognised pad -> virtual standard Xbox pad (tvbox-gamepad)
  "voice_satellite.py", // the remote's microphone as a Home Assistant satellite (tvbox-voice)
  "firetv_remote_ir.py", // program a Fire TV remote's IR buttons over BLE (no Fire TV)
  "keymap_compile.py", // byte-accurate keymap/IR compiler used by firetv_remote_ir.py
  "ir_protocols.py", // IR protocol encoders (NEC/RC5/RC6/SIRC/...) - irdb row -> raw timings
  "flipper_protocols.py", // the same for a Flipper-IRDB parsed block (Samsung32/Kaseikyo/RCA/...)
  "firetv_hid_probe.py", // diagnostic: map a Fire TV remote's vendor-HID app buttons to hwdb lines
  "firetv_tv_codes.example.json", // sample TV code set (LG NEC) for firetv_remote_ir.py
  "firetv_ir_plan.example.json", // a hand-written remote plan carrying real input codes
  "tvbox",
  "recover.sh", // what the compositor runs when the remote's Home key is held
  "provision.sh",
  "install-libcec8.sh", // provision builds libcec >= 8 from it (no distro package yet)
  // The compositor: what installs it, the release it pins, and the wrapper greetd
  // starts it with. Root-installed by provision.sh, so an OTA-only box carries the
  // files until the next provision; session.sh below is the part OTA can update.
  "install-compositor.sh",
  "compositor.version",
  "tvbox-session",
  "session.sh", // what the compositor starts: audio, then the shell's respawn loop
  // Diagnostics + safe mode. Root-side, so a release only refreshes the copies in
  // ~/.tvbox/ - provision.sh is what installs them under /usr/local/sbin and /etc.
  "tvbox-diag.sh",
  "tvbox-safemode.sh",
  "tvbox-diag.service",
  "tvbox-diag.timer",
  "tvbox-safemode.service",
  "tvbox-safemode-screen.service",
  "greetd-tvbox-safemode.conf",
  "coredump-tvbox-runtimemax.conf",
  "journald-tvbox-persistent.conf",
  "tvbox-cec.service",
  "tvbox-remote.service",
  "tvbox-gamepad.service",
  "tvbox-voice.service", // the remote's microphone as an assist_satellite
  "tvbox-flatpak-update.service",
  "tvbox-flatpak-update.timer",
  // Screen mirroring's privileged half and the unit the shell starts it with.
  // Root-side like the diagnostics pair, so an OTA-only box carries the files
  // until its next provision rather than gaining the feature straight away.
  "tvbox-miracast",
  "tvbox-miracast.service",
  "52-tvbox-miracast.rules",
  // The built-in radio switch, same shape: root installs it, OTA only carries it.
  "tvbox-radio",
  "tvbox-radio@.service",
  // The root-side system updater. Same shape again - and it is the piece that
  // makes the shape survivable: once provision has installed it, a later release
  // can bring its own root half instead of needing a re-flash.
  "tvbox-sysupdate",
  "tvbox-sysupdate.service",
  "54-tvbox-sysupdate.rules",
  "sysupdate.conf",
  "release-key.pem",
];
// Files an earlier release installed and this one does not: they are removed on
// update rather than left to be found by something that still looks for them.
const RETIRED = [
  "install-labwc-planes.sh",
  "labwc-autostart",
  "labwc-environment",
  "cursor_idle_hide.py",
  "tvbox-compositor", // the wrapper that chose between two labwc builds
];

const USER_UNITS = [
  "tvbox-cec.service",
  "tvbox-remote.service",
  "tvbox-gamepad.service",
  "tvbox-voice.service",
  "tvbox-flatpak-update.service",
  "tvbox-flatpak-update.timer",
];
const EXECUTABLE = [
  "run-shell.sh",
  "recover.sh", // the compositor exec's it
  "session.sh", // the compositor exec's it
  "tvbox",
  "tvbox-diag.sh",
  "tvbox-safemode.sh",
  "tvbox-session",
  "install-compositor.sh",
  "tvbox-miracast", // provision copies it to /usr/local/sbin; systemd exec's it
  "tvbox-radio", // same: /usr/local/sbin, exec'd by tvbox-radio@.service
  "tvbox-sysupdate", // same: /usr/local/sbin, exec'd by tvbox-sysupdate.service
  "install-libcec8.sh", // provision runs it with `sh`, a person may run it directly
];
// Scripts that ship but are always started through an interpreter, so their
// mode does not matter. Every other script in infra.list must be in EXECUTABLE.
const RUN_BY_INTERPRETER = [
  "provision.sh", // `sudo bash ~/.tvbox/provision.sh`, and tvbox-sysupdate runs it with bash
];
// Where each shipped user unit gets its "enable" symlink (its [Install]
// WantedBy). syncInfra creates these directly - same trick as the image build:
// a box that only ever updates via OTA must still START a newly shipped unit
// on the next boot; daemon-reload alone leaves it disabled forever (exactly
// how OTA-only boxes got tvbox-remote.service on disk but never running).
// A unit absent here (tvbox-flatpak-update.service) is timer/dep-activated.
const UNIT_WANTS = {
  "tvbox-cec.service": "default.target.wants",
  "tvbox-remote.service": "default.target.wants",
  "tvbox-gamepad.service": "default.target.wants",
  "tvbox-voice.service": "default.target.wants",
  "tvbox-flatpak-update.timer": "timers.target.wants",
};

// main.js provides these; the CLI none. `canaryVouches` is the other boxes'
// canary topics (mqtt.js), a Map of box id -> canary.parseVouch().
let hooks = { isIdle: () => true, restart: null, canaryVouches: () => new Map() };
let state = "idle"; // idle | checking | downloading | installing | restarting | error
let error = null;
let latest = null; // validated feed object from the last successful check
let lastCheckAt = null;
let bootAt = Date.now();
let committed = false;
let applying = false; // one apply at a time, whatever `state` says meanwhile

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
  // https anywhere, or plain http ONLY to the owner's own LAN feed - a public
  // http override would be an unauthenticated MITM channel for the whole OTA.
  return typeof u.feed === "string" && isAllowedFetchUrl(u.feed) ? u.feed : DEFAULT_FEED;
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

// What a release can demand of the box before it may be installed. A release is
// user-space, so it cannot bring anything root put there: the compositor, the
// session greetd starts, an apt package. When a version needs one of those, an OTA
// box has to be re-provisioned or re-flashed first, and this is how the release
// says so instead of installing itself into a half-working box.
//
// Fail CLOSED on anything unrecognised: a requirement this shell has never heard of
// is one it certainly does not meet.
const REQUIREMENTS = {
  // The shell drives modes, HDR, focus, window placement and typing over the
  // compositor's control socket. Without it a box still boots, but the remote's
  // Back key stops reaching an app and nothing controls the output.
  compositor: () => compositor.available(),
};

// The one requirement that carries a number, and the only one a box can now
// satisfy by itself: `system:7` means "this release needs what provision.sh
// revision 7 installs". A shell that predates this parse does not recognise the
// name and fails closed, which is the right answer for it - it has no root half
// to run either.
//
// Written into the name rather than added as a feed field on purpose: an old
// shell ignores an unknown top-level field, and would then install a release
// whose root half it silently skipped.
const SYSTEM_REQUIREMENT = /^system:(\d{1,6})$/;

// Which revision, if any, a set of unmet requirements is asking for. Null when
// none of them is a system requirement - the difference between "press this
// button" and the older "this box has to be set up again".
function neededSystemRevision(unmet) {
  let want = null;
  for (const name of unmet || []) {
    const m = SYSTEM_REQUIREMENT.exec(String(name));
    if (m) want = Math.max(want == null ? 0 : want, Number(m[1]));
  }
  return want;
}

function unmetRequirements(feed) {
  const declared = feed && feed.requires;
  // A `requires` that is present but not a list is a broken feed, and reading it as
  // "no requirements" would hand the release to exactly the box the field exists to
  // protect. Unsatisfiable, so the update is offered to nobody until it is fixed.
  if (declared != null && !Array.isArray(declared)) return ["malformed-requires"];
  const wanted = Array.isArray(declared) ? declared : [];
  return wanted.filter((name) => {
    const sys = SYSTEM_REQUIREMENT.exec(String(name));
    if (sys) {
      try {
        // Strict less-than against the highest revision ever applied. An
        // unreadable marker reads as 0, so the box asks for the step rather than
        // claiming one it cannot prove.
        return sysupdate.appliedRevision() < Number(sys[1]);
      } catch (e) {
        return true;
      }
    }
    const met = REQUIREMENTS[name];
    if (!met) return true;
    try {
      return !met();
    } catch (e) {
      return true;
    }
  });
}

function status() {
  const current = pkg.version || "0";
  const unmet = latest ? unmetRequirements(latest) : [];
  return {
    current,
    release: runningRelease(), // null = dev tree (deploy.sh)
    state,
    error,
    latest: latest ? { version: latest.version, notes: latest.notes || null } : null,
    // What this box cannot satisfy, so the UI can say why an update it can see is
    // not being installed.
    unmet,
    available: !!(latest && cmpVer(latest.version, current) > 0 && !unmet.length),
    lastCheckAt,
    auto: autoEnabled(),
    canary: canaryStatus(),
    failed: readPair(FAILED),
    last: readLast(),
    os: osStatus(),
    // The root half. Folded in here rather than given its own endpoint so the
    // Settings screen keeps ONE poller and one document - two would be two
    // things to keep in step with the demo mode and with each other.
    system: {
      ...sysupdate.status(),
      // What the release in front of us is asking for, and what the feed says it
      // would install. `needs` non-null AND `available` true is the only
      // combination where pressing the button can do anything.
      needs: neededSystemRevision(unmet),
      feedRevision: latest && Number.isInteger(latest.systemRevision) ? latest.systemRevision : null,
    },
  };
}

const MAX_FEED_BYTES = 64 * 1024;

// Reads a response body, giving up as soon as it passes `maxBytes` instead of
// buffering whatever the server chose to send first.
async function readCapped(res, maxBytes, ctl) {
  const declared = Number(res.headers && res.headers.get && res.headers.get("content-length"));
  if (declared > maxBytes) throw new Error("response too large");
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("response too large");
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      if (ctl) ctl.abort();
      throw new Error("response too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchBytes(url, timeoutMs, maxBytes) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await guardedFetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await readCapped(res, maxBytes, ctl);
  } finally {
    clearTimeout(t);
  }
}

// Keys a feed signature is checked against: the release key this shell shipped
// with (infra/ beside an OTA release, ~/.tvbox for a dev deploy, deploy/ in a
// checkout), plus any the owner put in ~/.tvbox/update-keys for their own builds.
function releaseKeys() {
  const files = [
    path.join(__dirname, "..", "infra", "release-key.pem"),
    path.join(TVBOX, "release-key.pem"),
    path.join(__dirname, "..", "deploy", "release-key.pem"),
  ];
  const extra = path.join(TVBOX, "update-keys");
  try {
    for (const n of fs.readdirSync(extra)) if (n.endsWith(".pem")) files.push(path.join(extra, n));
  } catch (e) {
    /* optional */
  }
  const keys = [];
  const seen = new Set();
  for (const f of files) {
    try {
      const pem = fs.readFileSync(f, "utf8");
      if (seen.has(pem)) continue;
      seen.add(pem);
      keys.push(crypto.createPublicKey(pem));
    } catch (e) {
      /* absent or not a key */
    }
  }
  return keys;
}

// Detached ed25519 over the exact feed bytes, base64 - what make-release.sh writes
// as update.json.sig and what the root applier checks.
function feedSignatureOk(bytes, sigText, keys) {
  const b64 = String(sigText || "").trim();
  if (!/^[A-Za-z0-9+/=]{16,4096}$/.test(b64)) return false;
  const sig = Buffer.from(b64, "base64");
  return (keys || releaseKeys()).some((k) => {
    try {
      return crypto.verify(null, bytes, k, sig);
    } catch (e) {
      return false;
    }
  });
}

// The default feed is https to the project's own releases. Any other feed has to
// be signed by a release key, because an owner-set feed is also what an attacker
// on the LAN would answer for; `update.allowUnsigned` is the opt-out for a
// self-hosted build with no key.
function signatureRequired(url) {
  const u = config.rawUpdate() || {};
  return url !== DEFAULT_FEED && u.allowUnsigned !== true;
}

async function fetchFeed(url) {
  const raw = await fetchBytes(url, FEED_TIMEOUT_MS, MAX_FEED_BYTES);
  if (signatureRequired(url)) {
    let sig;
    try {
      sig = await fetchBytes(url + ".sig", FEED_TIMEOUT_MS, 8192);
    } catch (e) {
      throw new Error("feed signature: " + String(e.message || e), { cause: e });
    }
    if (!feedSignatureOk(raw, sig.toString("utf8"))) throw new Error("feed signature does not verify");
  }
  return JSON.parse(raw.toString("utf8"));
}

async function check() {
  if (applying || state === "downloading" || state === "installing" || state === "restarting") return status();
  state = "checking";
  error = null;
  try {
    // Retried, and with a short pause because this runs on the boot path: one
    // dropped connection would otherwise leave `state` at "error" until the next
    // six-hourly check, and autoTick refuses to run unless the state is idle - so
    // a single flake costs a whole night's auto-update and paints a red line on
    // the television meanwhile.
    const feed = await withRetries(() => fetchFeed(feedUrl()), 3, 2000, transient);
    if (!feed || feed.feedVersion !== 1) throw new Error("bad feed shape");
    if (!versionOk(feed.version)) throw new Error("bad feed version");
    if (!/^https:\/\//.test(feed.url || "") && !isLiteralLanUrl(feed.url))
      throw new Error("feed url must be https (or http to a LAN address)");
    if (!/^[0-9a-f]{64}$/i.test(feed.sha256 || "")) throw new Error("feed needs a sha256");
    latest = feed;
    const unmet = unmetRequirements(feed);
    if (unmet.length) {
      console.warn("[updater]", feed.version, "needs", unmet.join(", "), "- this box has to be re-provisioned first");
    }
    lastCheckAt = Date.now();
    // A follower's wait starts when the release is first seen, not at the first
    // nightly window after it.
    if (cmpVer(feed.version, pkg.version || "0") > 0) canaryDecision(feed.version, true);
    // An apply that started while this check was in flight owns `state` now.
    if (!applying) state = "idle";
  } catch (e) {
    if (!applying) {
      state = "error";
      error = "check: " + String(e.message || e).slice(0, 120);
    }
    console.warn("[updater] check:", String(e.message || e).slice(0, 120));
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

// Run something that talks to GitHub a few times before believing it.
// Deliberately small and blunt: the failures worth surviving here are transient
// (a 503, a connection closed without a response), and anything permanent fails
// the same way it did before, just later.
async function withRetries(fn, attempts = 4, pauseMs = 20000, retryable = () => true) {
  let last = new Error("no attempt was made");
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // A 404 is an answer, not a flake. Same rule the applier's fetch follows.
      if (!retryable(e) || i + 1 >= attempts) break;
      console.warn("[updater] retrying after:", String(e.message || e).slice(0, 120));
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  throw last;
}

// What is worth another go: everything except an answer the server meant.
const transient = (e) => !/HTTP 4\d\d/.test(String((e && e.message) || e));

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
  // A WriteStream 'error' with no listener is an uncaught exception, which takes
  // the whole shell down and restarts it.
  // freeBytes() is a single preflight check, so ENOSPC/EIO MID-download is a
  // real path; surface it into the await chain so it fails THIS update instead
  // of the process. The noop .catch marks the promise handled for the stretches
  // where no await is racing it (e.g. while awaiting fetch).
  let writeErr = null;
  let failWrite;
  const writeFailed = new Promise((_, reject) => {
    failWrite = (e) => {
      writeErr = e;
      reject(e);
    };
  });
  writeFailed.catch(() => {});
  out.on("error", failWrite);
  try {
    const res = await guardedFetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    // Enforce the size cap WHILE streaming, not after buffering: reject a
    // declared-oversize body up front, and count the real bytes as they arrive
    // so a huge (or lying-Content-Length) response can't exhaust RAM/disk
    // before a post-hoc check. NaN (absent header) compares false -> streams.
    if (Number(res.headers.get("content-length")) > TARBALL_MAX_BYTES) throw new Error("tarball too large");
    let total = 0;
    for await (const chunk of res.body || []) {
      if (writeErr) throw writeErr;
      total += chunk.length;
      if (total > TARBALL_MAX_BYTES) {
        ctl.abort(); // stop the transfer, not just the file write
        throw new Error("tarball too large");
      }
      // race the drain against a write error - an errored stream never drains
      if (!out.write(chunk)) await Promise.race([writeFailed, new Promise((r) => out.once("drain", r))]);
    }
    await Promise.race([writeFailed, new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())))]);
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
// opts.auto: the nightly run. It must not clear the record of a rolled-back
// release, which is the one thing that stops it installing that release again.
async function apply(opts = {}) {
  if (applying || state === "downloading" || state === "installing" || state === "restarting") return status();
  if (!latest) await check();
  if (applying) return status();
  const cur = pkg.version || "0";
  if (!latest || cmpVer(latest.version, cur) <= 0) return status();
  // The same gate the offer runs on. `available` already folds this in, so the UI
  // never shows the button - but a POST straight at /update/apply would otherwise
  // install a release into a box that cannot run it.
  const unmet = unmetRequirements(latest);
  if (unmet.length) {
    state = "error";
    error = "apply: " + latest.version + " needs " + unmet.join(", ");
    console.warn("[updater]", error);
    return status();
  }
  const v = latest.version;
  const stage = path.join(UPDATE_DIR, "stage");
  const tarball = path.join(UPDATE_DIR, "release.tar.gz");
  let flipped = false;
  applying = true;
  try {
    const free = freeBytes();
    if (free != null && free < MIN_FREE_BYTES) throw new Error("not enough free disk space");
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    if (!opts.auto) fs.rmSync(FAILED, { force: true }); // an explicit apply is the retry
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
      // Electron 43 has no postinstall hook - the binary download moved to its
      // own `install-electron` bin - so npm ci leaves node_modules/electron
      // without a dist/. electron's index.js would fetch it at the staged
      // release's first start instead, i.e. a ~110 MB download inside the 90 s
      // the boot watchdog gives an update to commit itself before it counts as
      // a failed boot. Fetch it here, where failing just fails the update.
      // Tried more than once for the same reason the image build is: it pulls
      // ~110 MB from GitHub's release CDN, which drops connections and answers
      // 503 often enough to have failed two image builds in one evening, and
      // @electron/get has no retry of its own. Failing here fails the whole
      // update, and the user sees it as "the update failed" with no cause.
      // The per-attempt timeout is shortened from run()'s 15-minute default so
      // four attempts cannot turn a stalled download into three quarters of an
      // hour with the update stuck at "installing" and a shell restart waiting
      // at the end of it.
      await withRetries(() =>
        run("node", ["node_modules/electron/install.js"], { cwd: path.join(stage, "shell"), timeout: 5 * 60 * 1000 }),
      );
    }
    // Move into place, then the symlink flip. The rollback marker is written
    // durably right before the rename that flips, so a power cut can leave it
    // only next to a flip that happened, and a failure before the flip removes it.
    fs.mkdirSync(VERSIONS, { recursive: true });
    const dest = path.join(VERSIONS, v);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(stage, dest);
    const prev = runningRelease() || "-"; // "-" = dev tree (run-shell.sh removes `current` on rollback)
    const tmp = CURRENT + ".new";
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(dest, tmp);
    fs.rmSync(ATTEMPTS, { force: true });
    fsutil.writeFileAtomic(PENDING, prev + " " + v + "\n");
    fs.renameSync(tmp, CURRENT);
    flipped = true;
    fsutil.fsyncDir(TVBOX);
    state = "restarting";
    console.log("[updater] flipped to", v, "- restarting shell");
    if (hooks.restart) setTimeout(() => hooks.restart(), 1500); // let the HTTP response out first
  } catch (e) {
    state = "error";
    error = "apply: " + String(e.message || e).slice(0, 160);
    console.warn("[updater]", error);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
    if (!flipped) {
      // Left behind, the marker would have run-shell.sh count the boots of the
      // release that is still running and roll it back.
      fs.rmSync(PENDING, { force: true });
      fs.rmSync(ATTEMPTS, { force: true });
      fs.rmSync(CURRENT + ".new", { force: true });
    }
  } finally {
    applying = false;
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
  const rel = runningRelease();
  const pending = readPair(PENDING);
  if (!pending) {
    // A marker that exists but cannot be read (empty after a power cut) would
    // keep run-shell.sh's boot watchdog killing a healthy shell for ever.
    if (fs.existsSync(PENDING)) {
      console.warn("[updater] removing an unreadable pending marker");
      fs.rmSync(PENDING, { force: true });
      fs.rmSync(ATTEMPTS, { force: true });
    }
    // An infra sync that did not finish (power cut, full disk) is retried on
    // the next healthy boot of the same release.
    if (rel && readSynced() !== rel) syncInfraSafely(rel);
    return;
  }
  if (pending.next !== rel) return; // not us - run-shell.sh owns this state
  fs.rmSync(PENDING, { force: true });
  fs.rmSync(ATTEMPTS, { force: true });
  try {
    fsutil.writeJsonAtomic(LAST, { from: pending.prev, to: rel, at: Date.now() }, { pretty: false });
  } catch (e) {
    /* cosmetic */
  }
  console.log("[updater] committed", pending.prev, "->", rel);
  clearSupersededFailure(rel);
  syncInfraSafely(rel);
  try {
    prune(rel, pending.prev);
  } catch (e) {
    console.warn("[updater] prune:", e.message);
  }
}

function readSynced() {
  try {
    return fs.readFileSync(SYNCED, "utf8").trim();
  } catch (e) {
    return null;
  }
}
// The on-disk OTA state, for the health view: a pending marker that outlives the
// boot it was written for, a rollback, or a release whose infra sync never landed
// are each a box that needs a look.
function markers() {
  const rel = runningRelease();
  const synced = readSynced();
  return {
    release: rel,
    pending: readPair(PENDING),
    failed: readPair(FAILED),
    synced,
    syncBehind: !!(rel && committed && synced !== rel),
  };
}

function syncInfraSafely(rel) {
  try {
    syncInfra(rel);
    fsutil.writeFileAtomic(SYNCED, rel + "\n");
  } catch (e) {
    console.warn("[updater] infra sync:", e.message);
  }
}

function syncInfra(rel) {
  const src = path.join(VERSIONS, rel, "infra");
  if (!fs.existsSync(src)) return;
  // Each file replaces its predecessor by rename, never by rewriting it in place:
  // run-shell.sh and session.sh are running while this copies, and run-shell.sh
  // is the rollback path, so a half-written copy must never be what is there.
  for (const name of INFRA_FILES) {
    const f = path.join(src, name);
    if (!fs.existsSync(f)) continue;
    fsutil.copyFileAtomic(f, path.join(TVBOX, name), { mode: EXECUTABLE.includes(name) ? 0o755 : 0o644 });
  }
  // Copying does not retire, and a box that has been through the labwc era carries
  // that compositor's patch set and session files in ~/.tvbox. The build script
  // applied every `*.patch` it found beside itself, so leaving them there is not
  // inert - it is a provision that installs a compositor nobody ships any more.
  try {
    for (const name of fs.readdirSync(TVBOX)) {
      if (name.endsWith(".patch") || RETIRED.includes(name)) {
        fs.rmSync(path.join(TVBOX, name), { force: true });
      }
    }
    // ~/.config/labwc is the OLD session's only bootstrap - the autostart in it
    // holds the shell's respawn loop. Removing it on a box that is still running
    // that session leaves it with nothing to start at the next boot, so it goes
    // only once this box is demonstrably on the compositor.
    if (compositor.available()) {
      fs.rmSync(path.join(os.homedir(), ".config", "labwc"), { recursive: true, force: true });
    }
  } catch (e) {
    console.warn("[update] could not retire the old compositor's files:", e.message);
  }
  // systemd user units live outside ~/.tvbox.
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  let units = false;
  for (const name of USER_UNITS) {
    const f = path.join(src, name);
    if (fs.existsSync(f)) {
      fsutil.copyFileAtomic(f, path.join(unitDir, name), { mode: 0o644 });
      // "enable" = the WantedBy symlink; keep whatever `systemctl enable`
      // (deploy.sh) or the image build already created, add it if missing.
      const wants = UNIT_WANTS[name];
      if (wants) {
        const link = path.join(unitDir, wants, name);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        try {
          fs.symlinkSync(path.join("..", name), link);
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      }
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

// A rollback record describes the release that did not boot. Once a release at
// or past it has committed, the record is history and no longer a warning.
function clearSupersededFailure(rel) {
  const failed = readPair(FAILED);
  if (failed && cmpVer(rel, failed.next) >= 0) fs.rmSync(FAILED, { force: true });
}

function clearFailed() {
  fs.rmSync(FAILED, { force: true });
  return status();
}

// Ask the root half to run. Refused while this half is mid-update, because
// provision reloads udev rules, reloads NetworkManager and spends minutes in
// apt - during a pending release's first boots that would take the session down
// and spend the three attempts run-shell.sh gives it, rolling back a release
// that was fine. The applier makes the same check for itself; this one is so the
// UI can say no rather than start something that immediately reports "busy".
function applySystem() {
  if (state === "downloading" || state === "installing" || state === "restarting") return status();
  sysupdate.apply(() => {});
  return status();
}

// -- staged rollout (canary.js) ---------------------------------------------

function canarySettings() {
  return canary.settings((config.rawUpdate() || {}).canary);
}

function readCanaryWait() {
  try {
    const w = JSON.parse(fs.readFileSync(CANARY_WAIT, "utf8"));
    return w && typeof w.version === "string" && Number.isFinite(w.since) ? w : null;
  } catch (e) {
    return null;
  }
}

// When this box first saw a release on offer that it has not installed. The
// record survives a restart, and a newer release arriving while one is still
// waiting keeps the clock: otherwise releases that come faster than the maximum
// wait would hold a follower back for ever.
function canaryWaitSince(version, now) {
  const w = readCanaryWait();
  if (w && w.version === version) return w.since;
  const since = w && cmpVer(w.version, pkg.version || "0") > 0 ? w.since : now;
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    fsutil.writeJsonAtomic(CANARY_WAIT, { version, since }, { pretty: false });
  } catch (e) {
    console.warn("[updater] canary wait:", e.message);
  }
  return since;
}

function vouches() {
  try {
    const v = hooks.canaryVouches();
    return v instanceof Map ? v : new Map();
  } catch (e) {
    return new Map();
  }
}

// A follower's answer for the release on offer. Read-only unless `record`,
// because the Settings poller must not start the clock; only the nightly tick does.
function canaryDecision(version, record) {
  const cs = canarySettings();
  if (cs.role !== "follower" || !version) return null;
  const now = Date.now();
  const w = readCanaryWait();
  const pending = w && (w.version === version || cmpVer(w.version, pkg.version || "0") > 0) ? w.since : now;
  const since = record ? canaryWaitSince(version, now) : pending;
  return canary.followerDecision({
    vouches: vouches(),
    from: cs.from,
    version,
    waitSince: since,
    now,
    maxWaitHours: cs.maxWaitHours,
  });
}

function canaryStatus() {
  const cs = canarySettings();
  const offered = latest && cmpVer(latest.version, pkg.version || "0") > 0 ? latest.version : null;
  const d = offered ? canaryDecision(offered, false) : null;
  // The boxes publishing a canary topic, so the owner can pick which one to follow.
  const seen = [...vouches().keys()].sort().slice(0, 32);
  return { ...cs, seen, decision: d ? { version: offered, reason: d.reason, until: d.until } : null };
}

// What this box publishes on its canary topic (mqtt.js), or null to clear it.
// Only an OTA-installed release is vouched for: a dev tree can carry any code
// under the same version number.
function canaryReport() {
  const rel = runningRelease();
  return canary.report({
    role: canarySettings().role,
    version: rel && rel === pkg.version ? rel : null,
    committed: committed && !readPair(PENDING),
    runningMs: Date.now() - bootAt,
    failed: readPair(FAILED),
  });
}

// update/failed is "<prev> <next>" (run-shell.sh writes it), so the release that
// failed to boot is `next`.
function rolledBack(failed, version) {
  return !!(failed && failed.next === version);
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
  if (rolledBack(s.failed, latest.version)) return;
  const gate = canaryDecision(latest.version, true);
  if (gate && !gate.go) return;
  if (gate) console.log("[updater] canary gate open for", latest.version + ":", gate.reason);
  console.log("[updater] nightly auto-update ->", latest.version);
  apply({ auto: true });
}

function startSchedulers() {
  setTimeout(check, 90 * 1000); // boot check (after the boot rush)
  setInterval(check, CHECK_EVERY_MS);
  setInterval(autoTick, AUTO_TICK_MS);
}

module.exports = {
  unmetRequirements, // exported for the test: a release may demand what OTA cannot bring
  withRetries, // exported for the test: what survives a flake and what does not
  neededSystemRevision, // same: which revision an unmet set is asking for
  init,
  status,
  check,
  apply,
  applySystem,
  clearFailed,
  onLauncherLoaded,
  markers,
  canaryReport,
  canaryDecision, // exported for the test: the follower gate
  canaryWaitSince, // same: the wait keeps its start across newer releases
  feedSignatureOk, // exported for the test: a non-default feed must be signed
  rolledBack, // exported for the test: a rolled-back release is not installed again
  readCapped, // same: a feed is not buffered past its cap
  clearSupersededFailure, // same: a rollback record outlived by a newer committed release
  readPair, // same: the format run-shell.sh writes
  startSchedulers,
  cmpVer,
  DEFAULT_FEED,
  // exported for updater.test.js - the deploy/infra.list cross-check
  INFRA_FILES,
  USER_UNITS,
  UNIT_WANTS,
  EXECUTABLE,
  RUN_BY_INTERPRETER,
};
