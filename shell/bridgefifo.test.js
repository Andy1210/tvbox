// Writing a control line to a uinput bridge.
//
// The property that matters is that it CANNOT HANG: a bridge that is not running
// leaves a FIFO with no reader, and a blocking open on one waits for ever - in the
// Electron main thread, i.e. the television stops answering. O_NONBLOCK is what
// makes that an ENXIO instead, and this is where that is checked.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const bridges = require("./bridgefifo");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-fifo-"));
let n = 0;
const tmp = (name) => path.join(dir, name + "-" + ++n);

const HAVE_MKFIFO = spawnSync("mkfifo", [path.join(dir, ".probe")]).status === 0;

// The paths the python bridges read. A rename here is a rename there, so they are
// pinned rather than left to a comment.
test("the two control FIFOs are where the bridges look for them", () => {
  assert.equal(bridges.CEC_CMD_FIFO, "/tmp/tvbox-cec-cmd");
  assert.equal(bridges.REMOTE_CMD_FIFO, "/tmp/tvbox-remote-cmd");
});

test("a line is written with its newline, and the call reports success", () => {
  const f = tmp("file");
  fs.writeFileSync(f, "");
  assert.equal(bridges.fifoCmd(f, "native on", "cec"), true);
  assert.equal(fs.readFileSync(f, "utf8"), "native on\n");
});

test("a FIFO nobody is reading fails at once rather than blocking", { skip: !HAVE_MKFIFO }, () => {
  const f = tmp("fifo");
  spawnSync("mkfifo", [f]);
  const started = Date.now();
  assert.equal(bridges.fifoCmd(f, "reload", "remote"), false);
  assert.ok(Date.now() - started < 2000, "a blocking open would wait for a reader for ever");
});

test("a FIFO that is not there is a bridge that is not running, not a throw", () => {
  assert.equal(bridges.fifoCmd(path.join(dir, "never"), "x", "cec"), false);
});

test("the first failure is logged and the rest are quiet, until one succeeds", () => {
  bridges._resetQuiet();
  const missing = path.join(dir, "absent");
  const said = [];
  const realWarn = console.warn;
  console.warn = (...a) => said.push(a.join(" "));
  try {
    bridges.fifoCmd(missing, "a", "cec");
    bridges.fifoCmd(missing, "b", "cec");
    bridges.fifoCmd(missing, "c", "cec");
    assert.equal(said.length, 1, "this runs on a timer for a whole native-app session");
    // A successful write clears it, so a bridge that comes back and goes again
    // says so once more.
    const f = tmp("file");
    fs.writeFileSync(f, "");
    bridges.fifoCmd(f, "ok", "cec");
    bridges._resetQuiet();
    bridges.fifoCmd(missing, "d", "cec");
    assert.equal(said.length, 2);
  } finally {
    console.warn = realWarn;
  }
});

test("each FIFO is quietened on its own", () => {
  bridges._resetQuiet();
  const said = [];
  const realWarn = console.warn;
  console.warn = (...a) => said.push(a.join(" "));
  try {
    bridges.fifoCmd(path.join(dir, "gone-a"), "x", "cec");
    bridges.fifoCmd(path.join(dir, "gone-b"), "x", "remote");
    assert.equal(said.length, 2, "a box with no CEC still has a remote bridge worth complaining about");
  } finally {
    console.warn = realWarn;
  }
});

test("a failing write leaks no descriptor, once per attempt", () => {
  const f = tmp("file");
  fs.writeFileSync(f, "");
  const before = fs.readdirSync("/proc/self/fd").length;
  for (let i = 0; i < 200; i++) {
    bridges.fifoCmd(f, "x", "cec");
    bridges.fifoCmd(path.join(dir, "absent2"), "x", "cec");
  }
  const after = fs.readdirSync("/proc/self/fd").length;
  assert.ok(after - before < 20, "descriptors grew by " + (after - before));
});
