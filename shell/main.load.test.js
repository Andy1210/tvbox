const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// main.js is the one file in the shell that nothing else can load: it requires
// `electron`, so every other test in this directory stops at its edge. That is
// exactly where this repo's worst load-time bug lived - an object built at MODULE
// level out of a `const` declared further down the file, i.e. read while it was
// still in its temporal dead zone. It passes `node --check`, eslint and every unit
// test, and then kills the shell in a respawn loop on the box.
//
// So load it here, with `electron` replaced. Two bounds on what that proves:
//
//   - `whenReady()` returns a promise that never resolves, so ONLY module-level
//     code runs. The bootstrap - windows, timers, the HTTP server - is not
//     exercised, and could not be without a display.
//   - It runs in a CHILD process with HOME pointed at a temporary directory,
//     because every module here resolves `os.homedir()` at import time (the same
//     reason integration.test.js runs a box per process). Without that, loading
//     the shell would read - and could write - the developer's own ~/.tvbox.

const LOADER = `
const Module = require("node:module");
const realLoad = Module._load;
const noop = () => {};
const chainable = () => new Proxy(noop, { get: () => chainable(), apply: () => chainable() });
// Enough of Electron for the module level: everything main.js touches before
// app.whenReady() resolves. A miss shows up as a TypeError, which is the answer
// this test exists to give.
const electron = {
  app: {
    setPath: noop,
    commandLine: { appendSwitch: noop },
    on: noop,
    once: noop,
    exit: (code) => {
      console.log("UNEXPECTED_EXIT " + code);
      process.exit(1);
    },
    quit: noop,
    getSystemLocale: () => "en-GB",
    requestSingleInstanceLock: () => true,
    // Never resolves: the bootstrap is out of scope (see the note above).
    whenReady: () => new Promise(() => {}),
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: { on: noop, handle: noop, once: noop, removeHandler: noop },
  screen: { on: noop, getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 } }) },
  session: { fromPartition: () => chainable() },
};
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electron;
  return realLoad.apply(this, arguments);
};
require(process.argv[2]);
console.log("LOADED");
// Nothing at module level should hold the loop open, but say so rather than
// hanging the suite if something starts doing so.
process.exit(0);
`;

// `mqtt` and the ESPHome client are real dependencies of shell/, and a checkout
// that has not run `npm ci` there cannot load main.js for a reason that has
// nothing to do with the shell. CI installs them (--ignore-scripts, so no Electron
// binary), so this only ever skips on a developer's machine - and says why.
const DEPS_MISSING = fs.existsSync(path.join(__dirname, "node_modules", "mqtt"))
  ? false
  : "shell/node_modules is not installed - run `cd shell && npm ci --ignore-scripts`";

test(
  "main.js loads with electron stubbed out (no temporal dead zone, no missing module)",
  { skip: DEPS_MISSING },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-mainload-"));
    const loader = path.join(home, "loader.js");
    fs.writeFileSync(loader, LOADER);
    const r = spawnSync(process.execPath, [loader, path.join(__dirname, "main.js")], {
      env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home },
      encoding: "utf8",
      timeout: 30000,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.equal(r.status, 0, "main.js did not load:\n" + out);
    assert.match(out, /LOADED/, "main.js did not reach the end of its module body:\n" + out);
    fs.rmSync(home, { recursive: true, force: true });
  },
);

// The same check for every module main.js pulls in, one process each. A module
// that only main.js requires has no other test that would notice it failing to
// load - a bad require path, a syntax-valid but undefined reference at module
// level - and finding out on the box means a respawn loop.
const SHELL_MODULES = [
  "appinfo",
  "bridgefifo",
  "crashlog",
  "getroutes",
  "mediapublish",
  "notify",
  "playerapi",
  "plugins",
  "powermenu",
  "remotepolicy",
  "sharing",
  "tvcommand",
  "widgets",
];

for (const name of SHELL_MODULES) {
  test("shell module loads: " + name, { skip: DEPS_MISSING }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-modload-"));
    const loader = path.join(home, "loader.js");
    fs.writeFileSync(loader, LOADER);
    const r = spawnSync(process.execPath, [loader, path.join(__dirname, name + ".js")], {
      env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home },
      encoding: "utf8",
      timeout: 30000,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.equal(r.status, 0, name + ".js did not load:\n" + out);
    fs.rmSync(home, { recursive: true, force: true });
  });
}

// A module here is injected rather than reaching for the shell itself, so one that
// is required and never initialized is a runtime failure with nothing before it:
// it loads, it lints, its own tests pass against their fakes, and the first real
// call reads a dep that is still null. That is not hypothetical - it shipped to a
// box during this split, as `Cannot read properties of null (reading 'available')`
// on the first notification.
//
// Static, on purpose: the initialization happens at module level or inside the
// bootstrap, and the loader above deliberately never runs the bootstrap.
test("every module main.js requires that has an init() is initialized by it", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const missing = [];
  for (const name of SHELL_MODULES) {
    const src = fs.readFileSync(path.join(__dirname, name + ".js"), "utf8");
    if (!/\n {2}init[,:]|module\.exports = \{[^}]*\binit\b/s.test(src)) continue;
    // The local name main.js gave it - the module is not always required under its
    // own file name (widgets.js is `cards`).
    const required = main.match(new RegExp('const (\\w+) = require\\("\\./' + name + '"\\)'));
    if (!required) continue; // not required by main.js at all
    if (!new RegExp("\\b" + required[1] + "\\.init\\(").test(main)) missing.push(name);
  }
  assert.deepEqual(missing, [], "required but never initialized: " + missing.join(", "));
});
