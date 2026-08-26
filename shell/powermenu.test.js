// The power menu, and the sleep timer behind it.
//
// Two decisions worth pinning: the screensaver's auto-sleep refuses while
// something is playing (the manual Sleep does not), and a reboot falls back to
// sudo without ever letting systemctl ask polkit interactively - that is what
// stopped the whole process group, respawn loop included.
const test = require("node:test");
const assert = require("node:assert");

const powermenu = require("./powermenu");

function boot(opts) {
  const o = opts || {};
  const log = { answers: [], calls: [], launcher: 0, stopped: 0, cec: [] };
  powermenu.init({
    execFile: (cmd, args, o2, cb) => {
      log.calls.push([cmd, ...args]);
      const fail = (o.failing || []).includes(cmd);
      setTimeout(() => cb(fail ? new Error("refused") : null, "", fail ? "not authorized" : ""), 0);
    },
    jsonRes: (_res, body) => log.answers.push(body),
    boxIdle: () => (o.idle === undefined ? true : o.idle),
    showLauncher: () => log.launcher++,
    stopPlayback: () => log.stopped++,
    cecPower: (on) => log.cec.push(on),
  });
  return log;
}

// ---- the sleep timer ----

test("a timer is set in minutes and reports when it will fire", () => {
  boot();
  const before = Date.now();
  const r = powermenu.setSleepTimer(30);
  assert.equal(r.ok, true);
  assert.ok(r.at >= before + 30 * 60 * 1000 - 50 && r.at <= Date.now() + 30 * 60 * 1000);
  assert.equal(powermenu.sleepTimer(), r.at);
  powermenu.setSleepTimer(0);
});

test("zero, negative, nonsense and beyond a day all clear it", () => {
  boot();
  for (const bad of [0, -5, NaN, "later", null, undefined, powermenu.MAX_SLEEP_MINUTES + 1, Infinity]) {
    powermenu.setSleepTimer(60);
    assert.equal(powermenu.setSleepTimer(bad).at, null, "should clear for " + String(bad));
    assert.equal(powermenu.sleepTimer(), null);
  }
});

test("a day exactly is still allowed", () => {
  boot();
  assert.ok(powermenu.setSleepTimer(powermenu.MAX_SLEEP_MINUTES).at);
  powermenu.setSleepTimer(0);
});

test("setting a new timer replaces the old one rather than adding to it", async () => {
  const log = boot();
  powermenu.setSleepTimer(1 / 60000); // fires immediately
  const first = powermenu.sleepTimer();
  powermenu.setSleepTimer(0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(log.cec.length, 0, "the replaced timer must not fire");
  assert.ok(first);
});

test("the timer turns the TV off through the launcher, not over whatever is up", async () => {
  const log = boot();
  powermenu.setSleepTimer(0.0005); // 30ms
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(log.launcher, 1);
  assert.deepEqual(log.cec, [false]);
  assert.equal(powermenu.sleepTimer(), null, "it clears itself once it has fired");
});

// ---- sleep ----

test("the manual Sleep is unconditional, and it really stops the sound", () => {
  const log = boot({ idle: false });
  powermenu.handlePower("sleep", {});
  assert.deepEqual(log.answers, [{ ok: true, slept: true }]);
  assert.equal(log.launcher, 1);
  assert.equal(log.stopped, 1, "showLauncher lets sound outlive a screen change; sleep means sleep");
  assert.deepEqual(log.cec, [false]);
});

test("the screensaver's auto-sleep stands down while anything is playing", () => {
  const log = boot({ idle: false });
  powermenu.handlePower("sleep_if_idle", {});
  assert.deepEqual(log.answers, [{ ok: true, slept: false }]);
  assert.equal(log.launcher, 0);
  assert.deepEqual(log.cec, [], "Spotify Connect streams with the launcher sitting idle on Home");
});

test("with no wiring at all, the auto-sleep stands down rather than sleeping", () => {
  // The default has to DENY: if init were ever skipped, a fail-open one would turn
  // the television off mid-film.
  const answers = [];
  const fresh = (() => {
    delete require.cache[require.resolve("./powermenu")];
    return require("./powermenu");
  })();
  fresh.init({ jsonRes: (_res, body) => answers.push(body) });
  fresh.handlePower("sleep_if_idle", {});
  assert.deepEqual(answers, [{ ok: true, slept: false }]);
});

test("...and does sleep when the box really is idle", () => {
  const log = boot({ idle: true });
  powermenu.handlePower("sleep_if_idle", {});
  assert.deepEqual(log.answers, [{ ok: true, slept: true }]);
  assert.deepEqual(log.cec, [false]);
});

// ---- reboot and poweroff ----

test("reboot runs as the session user, never asking polkit interactively", async () => {
  const log = boot();
  powermenu.handlePower("reboot", {});
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log.calls, [["systemctl", "--no-ask-password", "reboot"]]);
  assert.deepEqual(log.answers, [{ ok: true }]);
});

test("a refused systemctl falls back to sudo -n, with the flag carried along", async () => {
  const log = boot({ failing: ["systemctl"] });
  powermenu.handlePower("poweroff", {});
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log.calls, [
    ["systemctl", "--no-ask-password", "poweroff"],
    ["sudo", "-n", "systemctl", "--no-ask-password", "poweroff"],
  ]);
  assert.deepEqual(log.answers, [{ ok: true }]);
});

test("both refused answers with the reason, bounded", async () => {
  const log = boot({ failing: ["systemctl", "sudo"] });
  powermenu.handlePower("reboot", {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(log.answers[0].ok, false);
  assert.match(log.answers[0].error, /not authorized/);
  assert.ok(log.answers[0].error.length <= 120);
});

test("anything else is refused before a process is spawned", () => {
  const log = boot();
  for (const bad of ["", "halt", "reboot; rm -rf /", "SLEEP", null, undefined]) {
    powermenu.handlePower(bad, {});
  }
  assert.deepEqual(log.calls, []);
  assert.ok(log.answers.every((a) => a.ok === false && a.error === "bad action"));
});
