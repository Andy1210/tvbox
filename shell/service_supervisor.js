// Generic supervised child process - the one place that owns "keep this daemon
// alive, but don't ENOENT-loop forever if its binary is missing/broken."
//
// Plugins reach it through the host API (host.spawnService / stopService /
// restartService), so any app that declares a long-lived helper gets capped
// exponential backoff and a failure ceiling for free. This replaces the
// Spotify-specific librespot respawn logic that used to live in main.js.
const { spawn } = require("child_process");
const fs = require("fs");

// One supervised service. `spec`:
//   argv:        () => [bin, ...args]   recomputed on every (re)start, so runtime
//                                       values (device name, audio sink) stay fresh
//   env, stdio:  passed to child_process.spawn
//   minUptimeMs: exit sooner than this counts as a failure (default 5000)
//   ceiling:     after this many consecutive rapid failures, retry slowly (60s)
//                instead of fast - never fully stops (default 5)
//   onGiveUp():  called once when the ceiling is hit (e.g. reset UI to idle)
//   log(msg):    optional progress/diagnostic sink
//
// A spec that asks for a piped stderr gets it FORWARDED to log(): a service dies
// for a reason, and an exit code on its own sends you looking for the wrong one -
// a held port reads exactly like a missing binary. An unread pipe is also a hazard
// of its own, since a child that fills it blocks on write.

// How many times to clear a leftover instance before starting anyway and letting
// the ordinary backoff report the failure. Bounded so a process that refuses to
// die cannot hold the service in a reap loop.
const MAX_REAP_PASSES = 3;

class Supervisor {
  constructor() {
    this.svcs = new Map(); // name -> { spec, proc, timer, fails, reaps }
  }

  // Register + start a service (replacing any existing one of the same name).
  spawn(name, spec) {
    this.stop(name);
    this.svcs.set(name, { spec, proc: null, timer: null, fails: 0, reaps: 0 });
    this._start(name);
  }

  // A supervised child outlives a parent that dies by signal - SIGKILL and a crash
  // both skip the shutdown path - and the leftover keeps whatever the new instance
  // needs: rclone holds its listening port, so every respawn exits at once. An
  // identical command line that is not one of our own children is such a leftover;
  // argv() is recomputed per start and deterministic, so this compares the whole
  // argument list rather than matching a pattern. Signals only reach our own uid,
  // which is the other half of why an exact match is safe.
  _reapStale(name, argv) {
    const s = this.svcs.get(name);
    const mine = new Set();
    for (const other of this.svcs.values()) {
      if (other.proc && other.proc.pid) mine.add(other.proc.pid);
    }
    const want = argv.join("\0");
    let entries;
    try {
      entries = fs.readdirSync("/proc");
    } catch (e) {
      return 0; // no procfs: nothing to inspect, nothing to reap
    }
    let reaped = 0;
    for (const entry of entries) {
      const pid = Number(entry);
      if (!pid || pid === process.pid || mine.has(pid)) continue;
      let cmdline;
      try {
        cmdline = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8");
      } catch (e) {
        continue; // exited, or another user's process
      }
      // procfs terminates the last argument too, so drop that before comparing.
      if (cmdline.replace(/\0$/, "") !== want) continue;
      // Ask once, insist afterwards: a service that ignored SIGTERM would
      // otherwise keep the port and the reason for the next pass would be the same.
      const sig = s && s.reaps > 0 ? "SIGKILL" : "SIGTERM";
      try {
        process.kill(pid, sig);
        reaped++;
      } catch (e) {
        /* exited between the read and the signal */
      }
    }
    return reaped;
  }

  _start(name) {
    const s = this.svcs.get(name);
    if (!s) return; // stopped in the meantime
    const spec = s.spec;
    const argv = spec.argv();
    if (s.reaps < MAX_REAP_PASSES && this._reapStale(name, argv) > 0) {
      s.reaps++;
      if (spec.log) spec.log("cleared a leftover instance, starting in a moment");
      // A beat, so the leftover releases its port or device before the new one
      // asks for it. Not a failure, so the backoff counter is left alone.
      s.timer = setTimeout(() => {
        s.timer = null;
        this._start(name);
      }, 900);
      return;
    }
    const startedAt = Date.now();
    if (spec.log) spec.log("spawn: " + argv.join(" "));
    // child_process.spawn doesn't throw on ENOENT - it emits "error" async - but
    // guard against a malformed argv just in case.
    let proc;
    try {
      // stderr is piped by DEFAULT, not on request: a supervised service that fails
      // silently is the expensive kind, and a spec that wants it quiet can still say
      // so explicitly.
      proc = spawn(argv[0], argv.slice(1), {
        env: spec.env,
        stdio: spec.stdio || ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      if (spec.log) spec.log("spawn threw: " + e.message);
      this._respawn(name, true);
      return;
    }
    s.proc = proc;
    // Whatever the child says about its own failure. Read rather than left to fill:
    // a pipe nobody drains stops the child at 64 KB.
    if (spec.log && proc.stderr) {
      let tail = "";
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk) => {
        tail += chunk;
        const lines = tail.split("\n");
        tail = lines.pop(); // keep the unterminated remainder for the next chunk
        for (const line of lines) {
          const msg = line.trim();
          if (msg) spec.log(msg.slice(0, 300));
        }
      });
      proc.stderr.on("error", () => {}); // the pipe closing with the child is normal
    }
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
    // A service that ran long enough to count as healthy earns its reap passes
    // back, so a leftover from a LATER crash is cleared too.
    if (!rapid) s.reaps = 0;
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
    s.reaps = 0;
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
