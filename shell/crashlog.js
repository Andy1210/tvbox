// An uncaught exception must not leave the box on a dialog.
//
// Electron's default handler draws an error box and keeps the process ALIVE, so
// the session's respawn loop never runs: the television stays on a message no
// remote can dismiss, only ssh gets the box back, and the wedged process does not
// even take a SIGTERM. Exiting instead brings the launcher back in ten to twenty
// seconds, and during an OTA it is what run-shell.sh's attempt counter and
// rollback need to see - the boot watchdog that used to reach them only exists
// while an update is pending. Note what that does NOT cover: a COMMITTED release
// that throws before the launcher ever loads has no pending marker and no counter,
// and safe mode counts boots rather than shell starts, so the only thing between
// it and a permanent flicker is session.sh's backoff.
//
// `install` is called BEFORE the rest of main.js's requires, because a module that
// throws while it loads is the failure shape this repo has actually had (a value
// built at module level out of a const declared further down the file, read in its
// temporal dead zone). Everything the handler uses is therefore required lazily
// inside its own try: require() is cached, and a module that is the one that failed
// must not take the crash log down with it. This file itself may only require the
// node built-ins at load, for the same reason.
const fs = require("fs");
const path = require("path");
const os = require("os");

const CRASH_LOG = path.join(os.homedir(), ".tvbox", "shell.crash.log");
const CRASH_LOG_MAX = 32 * 1024; // a few stacks; a crash LOOP must not fill the card
// How long the crash path waits for a native app to write its save and exit. Short:
// the television is already black, and an app that ignores it is killed anyway.
const NATIVE_CRASH_WAIT_MS = 800;
// How much of one stack is kept. An Error's MESSAGE is whatever threw it - a
// plugin can put a whole payload in one - and this file is copied onto the boot
// partition, which any laptop can read.
const CRASH_STACK_MAX = 8 * 1024;
// A restart the viewer did not ask for looks exactly like the box deciding to stop
// their film, so the launcher says one line about it. A marker rather than the
// crash log itself, because it has to be CONSUMED: read from the log, every boot
// for the rest of the box's life would carry a notice about a crash last March.
const CRASH_NOTICE = path.join(os.homedir(), ".tvbox", "crash-notice");
const CRASH_NOTICE_DELAY_MS = 2500; // the launcher has to be listening before it is told

// APPENDED, capped, and 0600 - the three things this file needs to be worth
// having. Appended because a crash LOOP reads exactly like a single crash when
// each one overwrites the last; capped so that loop cannot fill the card; and
// created the way player.js creates mpv.log, with O_NOFOLLOW, because ~/.tvbox is
// reachable through the file server and a symlink planted here would otherwise be
// written through as the box user.
// `file` is the production path unless a caller names another; the tests do, so
// that the append/cap/mode rules can be checked without writing into a real home.
function writeCrashLog(stack, file) {
  let fd = null;
  try {
    fd = fs.openSync(
      file || CRASH_LOG,
      fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return; // a fifo or a device would take the write somewhere of its own
    fs.fchmodSync(fd, 0o600);
    if (st.size > CRASH_LOG_MAX) fs.ftruncateSync(fd, 0);
    const version = (() => {
      try {
        return require("./package.json").version;
      } catch (e) {
        return "?";
      }
    })();
    fs.writeSync(fd, new Date().toISOString() + " v" + version + "\n" + stack.slice(0, CRASH_STACK_MAX) + "\n\n");
  } catch (e) {
    /* no crash log rather than a crash log we are not sure of */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {}
    }
  }
}

// The next launcher load says so, once. O_CREAT|O_EXCL never follows a symlink,
// which is what a planted one at this path would be - and an EEXIST here is a
// previous crash nobody has been told about yet, i.e. nothing to do.
function markNotice(file) {
  try {
    fs.closeSync(fs.openSync(file || CRASH_NOTICE, "wx", 0o600));
    return true;
  } catch (e) {
    return false;
  }
}

// Whether the last start followed a crash, CONSUMING the answer: a note is worth
// less than a loop of them.
function takeNotice(file) {
  try {
    fs.unlinkSync(file || CRASH_NOTICE);
    return true;
  } catch (e) {
    return false; /* not there: an ordinary start */
  }
}

let crashing = false;

/**
 * Register the handler.
 *
 * `stopServices` and `exit` are the two things this cannot reach on its own: the
 * supervised-child manager is an instance main.js owns, and how the process ends
 * is Electron's (`app.exit`, with `process.exit` as the fallback).
 */
function install(deps) {
  const d = deps || {};
  process.on("uncaughtException", (err) => {
    if (crashing) return; // a throw from the handling below must not recurse
    crashing = true;
    // String(): `stack` is whatever was thrown, and a native module or a Proxy can
    // make it a non-string - which would then throw on .slice() inside the writer,
    // losing the one record that survives the restart.
    let stack;
    try {
      stack = String((err && err.stack) || err);
    } catch (e) {
      stack = "(an exception whose own stack could not be read)";
    }
    try {
      // An error message carries whatever threw it: a URL with a token, an app's
      // credentials. This goes to shell.log, which tvbox-diag copies onto the FAT
      // boot partition, so it gets the same treatment as an app's console line.
      stack = require("./redact").redact(stack);
    } catch (e) {}
    console.error("[shell] uncaught exception - restarting:", stack);
    writeCrashLog(stack);
    markNotice();
    // The three things an ordinary exit does that the television would otherwise be
    // left holding. mpv first: it is a child that outlives us, so a film would play
    // on with no shell able to stop it.
    try {
      require("./player").stop();
    } catch (e) {}
    // A native app owns the screen and reads the pad itself, so one left running
    // would sit behind the new launcher with nothing in the UI able to end it, and
    // the next launch would start a SECOND instance racing the first for the same
    // save file. SIGTERM first, because that is what makes an emulator write that
    // save; `forceStop` alone does nothing until `stop` has named the app's
    // processes, and the escalation timers `stop` arms die with this process. The
    // wait for it is synchronous for the same reason - no timer here will ever run -
    // and a fraction of a second against a ten-second recovery is nothing next to a
    // lost afternoon of a game.
    let nativeGone = false;
    try {
      const nativeapp = require("./native");
      if (!nativeapp.running()) {
        nativeGone = true;
      } else {
        nativeapp.stop();
        const idle = new Int32Array(new SharedArrayBuffer(4));
        const until = Date.now() + NATIVE_CRASH_WAIT_MS;
        while (!nativeapp.settled() && Date.now() < until) Atomics.wait(idle, 0, 0, 50);
        nativeGone = nativeapp.settled();
        if (!nativeGone) nativeapp.forceStop();
      }
    } catch (e) {}
    // Only once the app is really gone. A SIGKILLed child is still in /proc as a
    // zombie until we exit, so "gone" here means it left on the SIGTERM - and being
    // wrong the other way is what costs the television: in native mode both uinput
    // bridges post Home to the API instead of emitting a key, which is the one
    // escape hatch that works whatever holds the screen. Leaving that mode on is
    // harmless (the next launch or exit resets it); turning it off over a surface
    // still in front is a box the remote cannot get out of.
    if (nativeGone) {
      try {
        require("./bridgefifo").bridgesCmd("native off");
      } catch (e) {}
    }
    // The supervised children (rclone serving the box's folders, librespot) are ours
    // and outlive us: a crash skips stopPlugins, so without this one keeps serving the
    // LAN on the credentials it started with, and the restarted shell finds its port
    // held. Synchronous SIGTERMs, same cost as the player stop above.
    try {
      if (d.stopServices) d.stopServices();
    } catch (e) {}
    try {
      if (d.exit) d.exit(1);
      else process.exit(1);
    } catch (e) {
      process.exit(1);
    }
  });
}

module.exports = {
  install,
  writeCrashLog,
  markNotice,
  takeNotice,
  CRASH_LOG,
  CRASH_LOG_MAX,
  CRASH_STACK_MAX,
  CRASH_NOTICE,
  CRASH_NOTICE_DELAY_MS,
};
