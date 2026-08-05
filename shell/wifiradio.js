// Turn the wifi radio off for the length of one operation, and put it back.
//
// Why this exists: on the Pi's combo chip wifi and Bluetooth share one antenna,
// and BLE **pairing** is the one thing that cannot survive the contention. A
// CONNECT_IND is the only BLE packet the link layer never retransmits, so losing
// it kills the whole attempt - measured on a box as 0 successes in 38 tries with
// the radio up, and a bond on the second try with it down. An already-bonded
// device reconnects fine either way, which is why this is a pairing-time
// measure and not a permanent setting.
//
// Two rules the callers depend on:
//   • the radio is only turned back ON if it was on to begin with, so this never
//     enables wifi on a box whose owner turned it off;
//   • a DETACHED fuse re-enables it after `seconds` no matter what happens here.
//     The box may be wifi-only; if the shell were killed mid-pair without the
//     fuse it would come back with no network and no way in.
const { execFile, spawn } = require("child_process");

// nmcli's radio state, or null when the answer isn't usable (no NetworkManager,
// a timeout, anything unexpected) - null means "don't touch the radio", which
// keeps a box without nmcli on exactly the behaviour it had before.
function state(env, cb, run) {
  (run || execFile)("nmcli", ["radio", "wifi"], { env, timeout: 5000 }, (err, out) => {
    const s = String(out || "").trim();
    cb(err || (s !== "enabled" && s !== "disabled") ? null : s);
  });
}

// Run `body` with the radio off, then restore. `body` is handed a done() it must
// call. done() ISSUES the restore rather than waiting for it - association takes
// seconds, and holding the caller (a pairing UI whose next call is local anyway)
// that long buys nothing. So `nmcli radio wifi` can still read "disabled" for a
// moment after the operation answers.
function withRadioOff(env, seconds, body, deps) {
  const d = deps || {};
  const run = d.run || execFile;
  const fuse = d.fuse || armFuse;
  state(
    env,
    (before) => {
      if (before !== "enabled") return body(() => {}); // off already, or unknown: leave it alone
      const disarm = fuse(env, seconds);
      run("nmcli", ["radio", "wifi", "off"], { env, timeout: 10000 }, (err) => {
        if (err) {
          // The radio is still up, so there is nothing to restore and nothing to
          // arm a fuse for. The operation goes ahead anyway - it may well work,
          // and refusing to try would be a worse answer than trying without the
          // advantage - but the log says why it may behave as it did before.
          console.warn("[wifi] could not take the radio down:", String(err.message || err).slice(0, 120));
          disarm();
          return body(() => {});
        }
        let restored = false;
        body(() => {
          if (restored) return; // idempotent: the caller may finish more than once
          restored = true;
          run("nmcli", ["radio", "wifi", "on"], { env, timeout: 10000 }, () => {});
          disarm();
        });
      });
    },
    run,
  );
}

// A separate, detached process whose only job is to turn the radio back on after
// `seconds`, even if this one dies first. Killing it on the happy path is just
// tidiness - `nmcli radio wifi on` twice is a no-op.
function armFuse(env, seconds) {
  let p = null;
  try {
    p = spawn("sh", ["-c", "sleep " + Number(seconds) + "; nmcli radio wifi on"], {
      env,
      detached: true,
      stdio: "ignore",
    });
    // A spawn that fails asynchronously (EMFILE, EAGAIN, a missing shell) reports
    // it through an `error` EVENT, which the try/catch above cannot see - and an
    // unhandled one is an uncaught exception that takes the shell down. Crashing
    // the shell is the very lockout this fuse exists to prevent, so it is caught
    // here even though all it can do is say the fuse is not there.
    p.on("error", (e) => console.warn("[wifi] restore fuse failed to start:", String(e.message || e).slice(0, 120)));
    p.unref();
  } catch (e) {
    return () => {};
  }
  return () => {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch (e) {
      try {
        p.kill("SIGKILL");
      } catch (e2) {
        /* already gone */
      }
    }
  };
}

// Turning the radio off PERMANENTLY is a different thing from the pairing-time
// dip above: it is what an owner asks for on a box that is on ethernet, where the
// radio only costs Bluetooth airtime. It has one hard precondition - something
// else has to carry the network, or the box disappears from the LAN with no way
// back short of a keyboard.
function canDisable(ethernet) {
  return !!(ethernet && ethernet.connected);
}

function setRadio(env, on, cb, deps) {
  const run = (deps && deps.run) || execFile;
  run("nmcli", ["radio", "wifi", on ? "on" : "off"], { env, timeout: 8000 }, (err) => {
    cb(!err);
  });
}

module.exports = { state, withRadioOff, canDisable, setRadio, _test: { armFuse } };
