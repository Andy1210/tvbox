// The two uinput bridges' control FIFOs, and the log guard around writing to them.
//
// tvbox-cec owns the CEC adapter and its cec-client stdin, so we cannot open a
// second one; a whitelisted command ("on 0" / "standby 0") goes into the FIFO it
// forwards from. tvbox-remote takes "reload" (re-read the remap config), learn mode
// and the native-mode flag. Every write is O_NONBLOCK, so a bridge that is not
// running can never hang the shell.
//
// Its own module because the crash handler is the earliest code the shell runs and
// it writes here: a `const` in main.js is in its temporal dead zone until the module
// has run that far, so a crash while the shell is still loading would silently skip
// taking the bridges out of native mode - and in that mode Home is POSTed to an API
// that is not listening yet, i.e. the one escape hatch on a keyboardless TV.
const fs = require("fs");

const CEC_CMD_FIFO = "/tmp/tvbox-cec-cmd";
const REMOTE_CMD_FIFO = "/tmp/tvbox-remote-cmd";
// FIFOs we have already complained about, so a bridge that simply is not there (a
// box with no CEC is normal) does not fill the log: bridgesCmd runs on a timer for
// the whole of a native-app session. Cleared by the next successful write.
const fifoQuiet = new Set();

// Write a control line to a bridge FIFO. O_NONBLOCK so a bridge that isn't
// running can never hang the shell.
function fifoCmd(fifo, cmd, tag) {
  let fd = null;
  try {
    fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, cmd + "\n");
    fifoQuiet.delete(fifo);
    return true;
  } catch (e) {
    if (!fifoQuiet.has(fifo)) {
      fifoQuiet.add(fifo);
      console.warn("[" + tag + "] cmd failed (bridge running?):", e.message);
    }
    return false;
  } finally {
    // A throwing writeSync would otherwise leak the descriptor, once per attempt.
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {}
    }
  }
}

// Tell BOTH uinput bridges the same thing. Used for "native on"/"native off":
// while a native app owns the screen it also owns keyboard focus, so the Home
// button can't reach any renderer of ours. Each bridge then posts Home to
// /tvbox/api/nav instead of emitting a key, which is the only escape hatch a
// native app has (rule 7: never a dead end on a keyboardless TV). Both bridges
// need it because Home arrives from either one: CEC synthesizes it from a
// double-tap of Back, a BT/USB remote sends it directly.
function bridgesCmd(cmd) {
  fifoCmd(CEC_CMD_FIFO, cmd, "cec");
  fifoCmd(REMOTE_CMD_FIFO, cmd, "remote");
}

function cecPower(on) {
  if (fifoCmd(CEC_CMD_FIFO, on ? "on 0" : "standby 0", "cec")) console.log("[cec] power", on ? "on" : "off");
}

// Take the TV's input back to this box - <Active Source>, the one routing command a
// source device may send. The recovery from an input switch, and the only one that
// needs no IR codes and no blaster, so it works on every set.
function cecActiveSource() {
  if (fifoCmd(CEC_CMD_FIFO, "as", "cec")) console.log("[cec] active source");
}

function remoteBridgeCmd(cmd) {
  return fifoCmd(REMOTE_CMD_FIFO, cmd, "remote");
}

// A phone acting as the remote presses a key. ONLY the remote bridge: the CEC one
// forwards what it does not recognise to cec-client's stdin, so a key would arrive
// there as a CEC command.
function remoteKey(action) {
  return fifoCmd(REMOTE_CMD_FIFO, "key " + action, "remote");
}

module.exports = {
  cecActiveSource,
  CEC_CMD_FIFO,
  REMOTE_CMD_FIFO,
  fifoCmd,
  bridgesCmd,
  cecPower,
  remoteBridgeCmd,
  remoteKey,
  // Tests only: the quiet set is process-global, so a case that asserts the first
  // failure logs has to be able to start from a known state.
  _resetQuiet: () => fifoQuiet.clear(),
};
