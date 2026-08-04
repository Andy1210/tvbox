// Adaptive display mode: the UI runs at the panel's own resolution capped to
// 1080p, and video temporarily claims whatever mode actually suits it.
//
// Why a claim/release service rather than something inside the mpv path: any app
// may present video, not just the ones that hand a URL to mpv. A web app playing
// into its own <video> element needs the same mode switch, so this is exposed as
// the `display` capability (shell/preload*.js -> @tvbox/app-sdk) and the shell's
// own mpv path is just its first caller.
//
// Rules that keep a misbehaving app from owning the screen:
//   - one claim at a time, newest wins, and the holder is remembered by id
//   - only the FOREGROUND app's claim is honoured; going to HOME releases it
//   - every claim is released on app close / playback end (on shell exit the
//     release can't finish - the next boot's refresh() puts the UI mode back)
//   - a claim that resolves to no better mode is a no-op, not an error
//   - switches are serialized, spaced, and capped per minute: each one blanks HDMI
//
// Mode selection itself lives in display.js (pure + unit-tested); this file is
// only about who wants what, and when to put it back.
const display = require("./display");

const MIN_APPLY_GAP_MS = 1500; // a mode switch blanks HDMI for ~1-3s; don't thrash
const MAX_TRIES = 3; // applies for one target that never became current
// Hard ceiling on switches per minute. The gap above spaces them out but does not
// bound them: an app alternating between two framerates changes the target every
// time, which would strobe the TV for as long as it stays foreground.
const APPLY_WINDOW_MS = 60000;
const APPLY_WINDOW_MAX = 8;

// minApplyGapMs is only ever passed by the tests (a real 1.5s wait per apply would
// make them crawl); the shell takes the default.
function create({ getModes, applyMode, log, minApplyGapMs = MIN_APPLY_GAP_MS }) {
  let uiMode = null; // what the UI should sit at (recomputed per mode list)
  let holder = null; // { id, content, mode, seq } while a claim is active
  let seq = 0; // claim sequence, so a superseded async claim can't commit
  let lastApplyAt = 0;
  let applyTimes = []; // apply timestamps inside the window
  let settling = false;
  let waiters = []; // everyone waiting for "the output is where it should be"
  let tries = 0; // applies for `triedFor` that did not stick
  let triedFor = null;

  const same = (a, b) =>
    !!a && !!b && a.width === b.width && a.height === b.height && Math.abs(a.refreshExact - b.refreshExact) < 0.001;
  const idOf = (m) => (m ? m.width + "x" + m.height + "@" + m.refreshExact.toFixed(3) : "");
  const pub = (m) => m && { width: m.width, height: m.height, refresh: m.refreshExact };

  // The mode we believe should be on screen right now: a live claim's, else the
  // UI's. A claim whose mode isn't chosen yet counts as "no claim".
  function desired() {
    return (holder && holder.mode) || uiMode;
  }

  // Coalesce concurrent `wlr-randr` reads into one process. Without this an app
  // looping claims spawns one per call - a fork bomb on a Pi 5.
  let modesWaiting = null;
  function modes(cb) {
    if (modesWaiting) return void modesWaiting.push(cb);
    modesWaiting = [cb];
    getModes((info) => {
      const list = modesWaiting;
      modesWaiting = null;
      for (const w of list) w(info);
    });
  }

  // `applied` = a mode switch really happened. Callers need it to tell "we switched
  // the TV" from "it was already there" - reporting the latter as a change makes an
  // app think the screen blanked when nothing moved.
  function flush(ok, err, applied) {
    const list = waiters;
    waiters = [];
    for (const cb of list) cb(ok, err, !!applied);
  }

  function windowFull() {
    const t = Date.now();
    applyTimes = applyTimes.filter((x) => t - x < APPLY_WINDOW_MS);
    return applyTimes.length >= APPLY_WINDOW_MAX;
  }

  // Put the output where `desired()` says, one switch at a time. `settling` is set
  // SYNCHRONOUSLY: claims arriving in the same tick must queue behind this one, not
  // each fire their own wlr-randr.
  function settle(cb) {
    if (cb) waiters.push(cb);
    if (settling) return; // whoever is settling will serve the queue when it lands
    if (!desired()) return flush(false, "no mode", false);
    settling = true;
    modes((info) => {
      const done = (ok, err) => {
        settling = false;
        flush(ok, err, false); // every path here returns without touching the output
      };
      if (!info) return done(false, "no output");
      const want = desired(); // may have moved while we were reading
      if (!want) return done(false, "no mode");
      const cur = info.modes.find((m) => m.current);
      if (same(cur, want)) {
        tries = 0; // it stuck; arm again for the next real hotplug
        return done(true, "");
      }
      // wlr-randr exiting 0 does NOT mean the sink kept the mode (a marginal 4K60
      // link or an AVR can bounce straight back to preferred) and every attempt
      // blanks the screen, so give one target a few goes and then leave it alone.
      // Only observing it current (above), a new target, or a hotplug (rearm)
      // clears the counter.
      const target = idOf(want);
      if (target !== triedFor) {
        triedFor = target;
        tries = 0;
      }
      if (++tries > MAX_TRIES) {
        if (tries === MAX_TRIES + 1) log(`${target} will not stick (now ${cur ? cur.key : "?"}) - leaving it alone`);
        return done(false, "not sticking");
      }
      if (windowFull()) {
        log(`too many mode switches in a minute - holding at ${cur ? cur.key : "?"}`);
        return done(false, "rate limited");
      }
      const wait = Math.max(0, minApplyGapMs - (Date.now() - lastApplyAt));
      setTimeout(() => {
        lastApplyAt = Date.now();
        applyTimes.push(lastApplyAt);
        applyMode(info.output, want, (ok, err) => {
          settling = false;
          log(`mode -> ${want.width}x${want.height}@${want.refreshExact} ${ok ? "ok" : "failed: " + err}`);
          // A claim/release landed while we were applying: go again rather than
          // answer with a mode nobody wants any more. The queue rides along.
          if (!same(want, desired())) return settle();
          // An apply that FAILED is not an answer either. Nothing else will ask
          // again - a settle only starts on a claim, a release or a hotplug - so a
          // single failure would leave the output on whatever the last claim put
          // there. That is how a TV ends up sitting on a film's 24 Hz mode after
          // the film stops, with everything on it looking broken. Go again; the
          // per-target budget and the rate limit above still bound it.
          if (!ok) return settle();
          flush(ok, err, true);
        });
      }, wait);
    });
  }

  return {
    // Recompute the UI mode from the live list and go there if nothing is claiming.
    // Called at boot and whenever the output is (re)detected.
    refresh(cb) {
      modes((info) => {
        if (!info) return cb && cb(false, "no output");
        const ui = display.pickUiMode(info.modes);
        if (ui && !same(ui, uiMode)) log(`ui mode -> ${ui.width}x${ui.height}@${ui.refreshExact}`);
        uiMode = ui;
        settle(cb);
      });
    },

    // "I am about to show video like this." content = { width, height, fps }.
    // Resolves with what happened so a caller can log it; never throws at an app.
    claim(id, content, cb) {
      // Take the holder slot NOW, before the async mode read: a release racing in
      // behind this call (the user pressing Home right after Play) must be able to
      // see the claim and cancel it, instead of no-oping and leaving the launcher
      // stuck at the film's mode.
      const mine = ++seq;
      holder = { id, content, mode: null, seq: mine };
      const superseded = () => !holder || holder.seq !== mine;
      modes((info) => {
        if (superseded()) return cb && cb({ ok: true, changed: false, reason: "superseded" });
        const drop = () => {
          holder = null;
        };
        if (!info) {
          drop();
          return cb && cb({ ok: false, reason: "no output" });
        }
        const mode = display.pickContentMode(info.modes, content || {});
        if (!mode) {
          // No matching refresh on this panel - stay where we are and let the
          // player resample instead. Not a failure: most panels lack 24p.
          drop();
          log(`claim ${id}: no mode matches ${content && content.fps} fps - staying put`);
          return cb && cb({ ok: true, changed: false, reason: "no-matching-mode" });
        }
        holder.mode = mode;
        settle(
          (ok, err, applied) =>
            cb &&
            cb({
              ok,
              changed: applied,
              reason: ok ? "" : err,
              mode: pub(mode),
            }),
        );
      });
    },

    // Give the screen back. Ignores a release from anyone but the holder, so a
    // background app cannot drop the foreground app's mode.
    release(id, cb) {
      if (!holder || (id != null && holder.id !== id)) return cb && cb({ ok: true, changed: false });
      log(`release ${holder.id}`);
      holder = null;
      settle((ok, err, applied) => cb && cb({ ok, changed: applied, reason: ok ? "" : err }));
    },

    // Any app leaving the foreground loses its claim - this is what makes "press
    // Home during a film" put the UI back at its own resolution.
    releaseIfHolder(id) {
      if (holder && holder.id === id) this.release(id);
    },

    // A hotplug is a new session (the TV came back), so the give-up budget and the
    // switch window start over - what the old sink refused, this one may accept.
    rearm() {
      tries = 0;
      applyTimes = [];
    },

    // For /admin-ish surfacing and tests.
    state() {
      return {
        ui: pub(uiMode),
        claimedBy: holder ? holder.id : null,
        desired: pub(desired()),
      };
    },
  };
}

module.exports = { create, MIN_APPLY_GAP_MS, APPLY_WINDOW_MAX };
