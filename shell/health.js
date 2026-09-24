// What the box says about its own health, in one small document.
//
// diag.js answers "what is this box" (version, link, heat). This answers "is it
// working": the failures that leave a box looking fine while something in it has
// stopped - a libuv threadpool with every thread blocked, an install that never
// ended and so holds every nightly job back, an OTA marker left behind, a crash.
// Each of those is silent on the television, so the report exists for whoever is
// looking from outside: the launcher's diagnostics, and the fleet over MQTT (it
// rides on the retained diag topic, see mediapublish.js).
//
// Everything is injected, so the report can be built in a test with no shell.
const fs = require("fs");
const os = require("os");

// A stat of the home directory is microseconds on a healthy box. It goes through
// the same four-thread pool as every async fs call, dns.lookup and zlib, so its
// latency is the pool's queue: a second means async I/O in the shell has stalled.
const POOL_SLOW_MS = 1000;
// How long a report waits for the probe before it says "saturated" anyway.
const POOL_WAIT_MS = 1500;
// A probe answered this recently is reused, so a poller cannot queue a stat per call.
const POOL_REUSE_MS = 5000;
// Longer than maintenance.js's own kill timeout (60 min): an install still listed
// after this is one whose completion was lost.
const INSTALL_STUCK_MS = 90 * 60 * 1000;
const CRASH_RECENT_MS = 24 * 60 * 60 * 1000;
// A boot that has not reached the launcher by then has a problem the launcher
// itself cannot report.
const BOOT_GRACE_MS = 5 * 60 * 1000;

let deps = {
  oldestInstallStart: () => null,
  nowPlaying: () => null, // { state, app, at } or null
  markers: () => ({}), // updater.markers()
  lastCrashAt: () => null,
  boot: () => ({}), // boothealth.state()
  uptimeMs: () => process.uptime() * 1000,
  now: () => Date.now(),
  stat: (p, cb) => fs.stat(p, cb),
  statPath: os.homedir(),
};

function init(d) {
  deps = { ...deps, ...(d || {}) };
}

let probe = null; // { started, waiters }
let last = null; // { ms, at }

// Time one threadpool round trip. Concurrent callers share the probe in flight,
// and a probe that never answers stays in flight: its age is then the answer.
function probePool(cb) {
  const now = deps.now();
  if (!probe && last && now - last.at < POOL_REUSE_MS) return cb(last.ms);
  if (probe) return probe.waiters.push(cb);
  probe = { started: now, waiters: [cb] };
  const mine = probe;
  try {
    deps.stat(deps.statPath, () => {
      const at = deps.now();
      last = { ms: at - mine.started, at };
      if (probe === mine) probe = null;
      for (const w of mine.waiters) w(last.ms);
    });
  } catch (e) {
    if (probe === mine) probe = null;
    for (const w of mine.waiters) w(null);
  }
}

// The pool latency, or how long the unanswered probe has been waiting.
function poolLatency(cb) {
  let done = false;
  const finish = (ms, saturated) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb({ ms, saturated });
  };
  const timer = setTimeout(() => {
    const started = probe ? probe.started : deps.now() - POOL_WAIT_MS;
    finish(deps.now() - started, true);
  }, POOL_WAIT_MS);
  probePool((ms) => finish(ms, ms === null ? true : ms >= POOL_SLOW_MS));
}

function safe(fn, dflt) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch (e) {
    return dflt;
  }
}

const iso = (ms) => (typeof ms === "number" && isFinite(ms) ? new Date(ms).toISOString() : null);
const ageSec = (ms, now) =>
  typeof ms === "number" && isFinite(ms) ? Math.max(0, Math.round((now - ms) / 1000)) : null;

/** The report for a measured pool. Pure apart from the injected readers. */
function build(pool) {
  const now = deps.now();
  const m = safe(deps.markers, {}) || {};
  const boot = safe(deps.boot, {}) || {};
  const np = safe(deps.nowPlaying, null);
  const installAt = safe(deps.oldestInstallStart, null);
  const crashAt = safe(deps.lastCrashAt, null);
  const uptime = safe(deps.uptimeMs, 0);

  const issues = [];
  if (pool.saturated) issues.push("threadpool");
  if (typeof installAt === "number" && now - installAt > INSTALL_STUCK_MS) issues.push("install-stuck");
  // A pending marker is normal until the launcher loads; after that it should be gone.
  if (m.pending && boot.reachedLauncher) issues.push("update-pending");
  if (m.failed) issues.push("rolled-back");
  if (m.syncBehind) issues.push("infra-sync");
  if (typeof crashAt === "number" && now - crashAt < CRASH_RECENT_MS) issues.push("recent-crash");
  if (!boot.reachedLauncher && uptime > BOOT_GRACE_MS) issues.push("launcher-not-loaded");

  return {
    at: iso(now),
    status: issues.length ? "warn" : "ok",
    issues,
    pool: { ms: pool.ms, saturated: !!pool.saturated },
    installAgeSec: ageSec(installAt, now),
    nowPlaying: np ? { state: np.state || null, app: np.app || null, ageSec: ageSec(np.at, now) } : null,
    update: {
      release: m.release ?? null,
      pending: !!m.pending,
      failed: m.failed ? m.failed.next : null,
      synced: m.synced ?? null,
    },
    lastCrashAt: iso(crashAt),
    reachedLauncher: !!boot.reachedLauncher,
  };
}

/** Measure and report. Never throws, and always answers within POOL_WAIT_MS or so. */
function collect(cb) {
  poolLatency((pool) => {
    let r;
    try {
      r = build(pool);
    } catch (e) {
      r = { at: iso(Date.now()), status: "warn", issues: ["report-failed"] };
    }
    cb(r);
  });
}

function resetForTest() {
  probe = null;
  last = null;
}

module.exports = {
  init,
  collect,
  build,
  probePool,
  POOL_SLOW_MS,
  POOL_WAIT_MS,
  INSTALL_STUCK_MS,
  _test: { resetForTest },
};
