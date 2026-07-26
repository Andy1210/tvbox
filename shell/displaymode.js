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
//   - every claim is released on app close / playback end / shell exit
//   - a claim that resolves to no better mode is a no-op, not an error
//
// Mode selection itself lives in display.js (pure + unit-tested); this file is
// only about who wants what, and when to put it back.
const display = require("./display");

const MIN_APPLY_GAP_MS = 1500; // a mode switch blanks HDMI for ~1-3s; don't thrash

function create({ env, getModes, applyMode, log }) {
  let uiMode = null; // what the UI should sit at (recomputed per mode list)
  let holder = null; // { id, content, mode } while a claim is active
  let lastApplyAt = 0;
  let pending = null; // coalesced target while a switch is in flight
  let applying = false;

  const same = (a, b) =>
    !!a && !!b && a.width === b.width && a.height === b.height && Math.abs(a.refreshExact - b.refreshExact) < 0.001;

  // The mode we believe should be on screen right now: a live claim's, else the UI's.
  function desired() {
    return (holder && holder.mode) || uiMode;
  }

  function settle(cb) {
    const want = desired();
    if (!want) return cb && cb(false, "no mode");
    if (applying) {
      pending = cb || (() => {});
      return;
    }
    getModes((info) => {
      if (!info) return cb && cb(false, "no output");
      const cur = info.modes.find((m) => m.current);
      if (same(cur, want)) return cb && cb(true, "");
      const wait = Math.max(0, MIN_APPLY_GAP_MS - (Date.now() - lastApplyAt));
      applying = true;
      setTimeout(() => {
        lastApplyAt = Date.now();
        applyMode(info.output, want, (ok, err) => {
          applying = false;
          log(`mode -> ${want.width}x${want.height}@${want.refreshExact} ${ok ? "ok" : "failed: " + err}`);
          if (cb) cb(ok, err);
          if (pending) {
            const again = pending;
            pending = null;
            settle(again);
          }
        });
      }, wait);
    });
  }

  return {
    // Recompute the UI mode from the live list and go there if nothing is claiming.
    // Called at boot and whenever the output is (re)detected.
    refresh(cb) {
      getModes((info) => {
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
      getModes((info) => {
        if (!info) return cb && cb({ ok: false, reason: "no output" });
        const mode = display.pickContentMode(info.modes, content || {});
        if (!mode) {
          // No matching refresh on this panel - stay where we are and let the
          // player resample instead. Not a failure: most panels lack 24p.
          log(`claim ${id}: no mode matches ${content && content.fps} fps - staying put`);
          return cb && cb({ ok: true, changed: false, reason: "no-matching-mode" });
        }
        holder = { id, content, mode };
        settle(
          (ok, err) =>
            cb &&
            cb({
              ok,
              changed: ok,
              reason: ok ? "" : err,
              mode: { width: mode.width, height: mode.height, refresh: mode.refreshExact },
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
      settle((ok, err) => cb && cb({ ok, changed: ok, reason: ok ? "" : err }));
    },

    // Any app leaving the foreground loses its claim - this is what makes "press
    // Home during a film" put the UI back at its own resolution.
    releaseIfHolder(id) {
      if (holder && holder.id === id) this.release(id);
    },

    // For /admin-ish surfacing and tests.
    state() {
      const d = desired();
      return {
        ui: uiMode && { width: uiMode.width, height: uiMode.height, refresh: uiMode.refreshExact },
        claimedBy: holder ? holder.id : null,
        desired: d && { width: d.width, height: d.height, refresh: d.refreshExact },
      };
    },
  };
}

module.exports = { create, MIN_APPLY_GAP_MS };
