const { test } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const recovery = require("./recovery");

const quiet = { warn() {} };

function fakeWindow({ destroyed = false, reloadThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    webContents: {
      reloadIgnoringCache() {
        calls.push("reload");
        if (reloadThrows) throw new Error("gone");
      },
    },
  };
}

test("brings the launcher forward, then reloads it", () => {
  const win = fakeWindow();
  const order = [];
  const r = recovery.recover({
    getWindow: () => win,
    showLauncher: () => order.push("show"),
    exit: () => order.push("exit"),
    log: quiet,
  });
  assert.strictEqual(r, "reload");
  assert.deepStrictEqual(order, ["show"]);
  assert.deepStrictEqual(win.calls, ["reload"]);
});

test("with no launcher window, exits so the respawn loop starts a fresh shell", () => {
  for (const win of [null, fakeWindow({ destroyed: true })]) {
    const codes = [];
    const r = recovery.recover({
      getWindow: () => win,
      showLauncher: () => assert.fail("nothing to show"),
      exit: (c) => codes.push(c),
      log: quiet,
    });
    assert.strictEqual(r, "restart");
    assert.deepStrictEqual(codes, [1]);
  }
});

test("a reload that throws falls back to a restart", () => {
  const codes = [];
  const r = recovery.recover({
    getWindow: () => fakeWindow({ reloadThrows: true }),
    showLauncher: () => {},
    exit: (c) => codes.push(c),
    log: quiet,
  });
  assert.strictEqual(r, "restart");
  assert.deepStrictEqual(codes, [1]);
});

test("a failing showLauncher does not stop the reload", () => {
  const win = fakeWindow();
  const r = recovery.recover({
    getWindow: () => win,
    showLauncher: () => {
      throw new Error("boom");
    },
    exit: () => assert.fail("must not exit"),
    log: quiet,
  });
  assert.strictEqual(r, "reload");
  assert.deepStrictEqual(win.calls, ["reload"]);
});

test("install listens for SIGUSR2", () => {
  const proc = new EventEmitter();
  const win = fakeWindow();
  recovery.install({ getWindow: () => win, showLauncher: () => {}, exit: () => {}, log: quiet }, proc);
  proc.emit("SIGUSR2");
  assert.deepStrictEqual(win.calls, ["reload"]);
});

test("main is told of a deliberate crash only when the renderer is really ended", () => {
  const order = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      forcefullyCrashRenderer: () => order.push("crash"),
      reloadIgnoringCache: () => order.push("reload"),
    },
  };
  const base = { getWindow: () => win, showLauncher: () => order.push("show"), exit: () => {}, log: quiet };
  recovery.recover({ ...base, onDeliberateCrash: () => order.push("told"), isUnresponsive: () => false });
  assert.deepStrictEqual(order, ["show", "reload"], "an ordinary reload expects no crash");
  order.length = 0;
  recovery.recover({ ...base, onDeliberateCrash: () => order.push("told"), isUnresponsive: () => true });
  assert.deepStrictEqual(order, ["show", "told", "crash", "reload"]);
});

test("a hold while the shell is still starting is ignored, not a restart", () => {
  const r = recovery.recover({
    getWindow: () => null,
    showLauncher: () => assert.fail("nothing to show yet"),
    isStarted: () => false,
    exit: () => assert.fail("must not end a starting shell"),
    log: quiet,
  });
  assert.strictEqual(r, "ignored");
});
