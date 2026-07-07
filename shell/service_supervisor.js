// Generic supervised child process - the one place that owns "keep this daemon
// alive, but don't ENOENT-loop forever if its binary is missing/broken."
//
// Plugins reach it through the host API (host.spawnService / stopService /
// restartService), so any app that declares a long-lived helper gets capped
// exponential backoff and a failure ceiling for free. This replaces the
// Spotify-specific librespot respawn logic that used to live in main.js.
const { spawn } = require("child_process");

// One supervised service. `spec`:
//   argv:        () => [bin, ...args]   recomputed on every (re)start, so runtime
//                                       values (device name, audio sink) stay fresh
//   env, stdio:  passed to child_process.spawn
//   minUptimeMs: exit sooner than this counts as a failure (default 5000)
//   ceiling:     after this many consecutive rapid failures, retry slowly (60s)
//                instead of fast - never fully stops (default 5)
//   onGiveUp():  called once when the ceiling is hit (e.g. reset UI to idle)
//   log(msg):    optional progress/diagnostic sink
class Supervisor {
  constructor() {
    this.svcs = new Map(); // name -> { spec, proc, timer, fails }
  }

  // Register + start a service (replacing any existing one of the same name).
  spawn(name, spec) {
    this.stop(name);
    this.svcs.set(name, { spec, proc: null, timer: null, fails: 0 });
    this._start(name);
  }

  _start(name) {
    const s = this.svcs.get(name);
    if (!s) return; // stopped in the meantime
    const spec = s.spec;
    const argv = spec.argv();
    const startedAt = Date.now();
    if (spec.log) spec.log("spawn: " + argv.join(" "));
    // child_process.spawn doesn't throw on ENOENT - it emits "error" async - but
    // guard against a malformed argv just in case.
    let proc;
    try {
      proc = spawn(argv[0], argv.slice(1), { env: spec.env, stdio: spec.stdio || "ignore" });
    } catch (e) {
      if (spec.log) spec.log("spawn threw: " + e.message);
      this._respawn(name, true);
      return;
    }
    s.proc = proc;
    proc.on("error", (e) => {
      if (spec.log) spec.log("spawn error: " + e.message);
      this._respawn(name, true);
    });
    proc.on("exit", (code, sig) => {
      if (spec.log) spec.log("exited code " + code + " sig " + sig);
      this._respawn(name, Date.now() - startedAt < (spec.minUptimeMs || 5000)); // exited fast -> a failure
    });
  }

  // Restart on crash with capped exponential backoff. After `ceiling` consecutive
  // rapid failures, DON'T stop - drop to a slow steady retry (60s). This way a
  // transient outage (e.g. the box's WiFi dropping) recovers on its own once the
  // network is back, while a genuinely missing/broken binary just retries about
  // once a minute (one log line) instead of a tight 2s ENOENT loop.
  _respawn(name, rapid) {
    const s = this.svcs.get(name);
    if (!s) return;
    s.proc = null;
    s.fails = rapid ? s.fails + 1 : 0;
    const ceiling = s.spec.ceiling || 5;
    if (s.fails === ceiling) {
      // crossing the ceiling: warn once + let the plugin reset its UI
      if (s.spec.log) s.spec.log("failing repeatedly (missing binary or outage?) - retrying slowly (60s)");
      try {
        if (s.spec.onGiveUp) s.spec.onGiveUp();
      } catch (e) {
        /* best effort */
      }
    }
    const delay = s.fails >= ceiling ? 60000 : rapid ? Math.min(2000 * 2 ** s.fails, 30000) : 2000;
    s.timer = setTimeout(() => this._start(name), delay);
  }

  // Explicit stop: kill (no respawn) and forget. Detaching listeners first so
  // our own kill never re-triggers the exit->respawn path.
  stop(name) {
    const s = this.svcs.get(name);
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const p = s.proc;
    s.proc = null;
    this.svcs.delete(name);
    if (p) {
      try {
        p.removeAllListeners();
        p.kill("SIGTERM");
      } catch (e) {
        /* already gone */
      }
    }
  }

  // Restart with a beat so the old instance releases its ports/audio device
  // before the new one binds. Reuses the entry (and its spec) so a stopAll()
  // during the gap still cancels the pending start; argv() is recomputed on the
  // fresh start, picking up any config change (e.g. a new Connect device name).
  restart(name, delayMs) {
    const s = this.svcs.get(name);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    const p = s.proc;
    s.proc = null;
    if (p) {
      try {
        p.removeAllListeners();
        p.kill("SIGTERM");
      } catch (e) {
        /* already gone */
      }
    }
    s.fails = 0;
    s.timer = setTimeout(() => {
      s.timer = null;
      this._start(name);
    }, delayMs || 900);
  }

  stopAll() {
    for (const name of [...this.svcs.keys()]) this.stop(name);
  }
}

module.exports = { Supervisor };
