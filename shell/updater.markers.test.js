// The OTA rollback markers are written by two programs, run-shell.sh and
// updater.js, and read by both. These tests drive the real script and the real
// module against one temporary home, so a format drift between them fails here.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-markers-"));
process.env.HOME = HOME;
const UPD = path.join(HOME, ".tvbox", "update");
const SCRIPT = path.join(__dirname, "..", "deploy", "run-shell.sh");
const updater = require("./updater");

function runShell() {
  // No ~/.tvbox/shell exists, so the script stops at its `cd` - after the
  // marker handling, before it would start anything.
  try {
    execFileSync("sh", [SCRIPT], { env: { ...process.env, HOME }, stdio: "ignore", timeout: 30000 });
  } catch (e) {
    /* exit 1 at the cd is expected */
  }
}

test("a rollback recorded by run-shell.sh blocks that release from the nightly run", () => {
  fs.mkdirSync(UPD, { recursive: true });
  fs.writeFileSync(path.join(UPD, "pending"), "1.0.0 1.1.0\n");
  fs.writeFileSync(path.join(UPD, "attempts"), "3");
  runShell();
  assert.ok(!fs.existsSync(path.join(UPD, "pending")), "the rollback clears pending");
  const failed = updater.readPair(path.join(UPD, "failed"));
  assert.deepStrictEqual(failed, { prev: "1.0.0", next: "1.1.0" });
  assert.equal(updater.rolledBack(failed, "1.1.0"), true);
  assert.equal(updater.rolledBack(failed, "1.2.0"), false, "a newer release is still offered");
  assert.equal(updater.rolledBack(null, "1.1.0"), false);
  fs.rmSync(UPD, { recursive: true, force: true });
});

test("run-shell.sh drops a pending marker that names no release", () => {
  for (const body of ["", "\n", "1.0.0\n", "1.0.0 ../x\n"]) {
    fs.mkdirSync(UPD, { recursive: true });
    fs.writeFileSync(path.join(UPD, "pending"), body);
    fs.writeFileSync(path.join(UPD, "attempts"), "1");
    runShell();
    assert.ok(!fs.existsSync(path.join(UPD, "pending")), JSON.stringify(body) + " was kept");
    assert.ok(!fs.existsSync(path.join(UPD, "attempts")));
    assert.ok(!fs.existsSync(path.join(UPD, "failed")), "an unreadable marker is not a rollback");
    fs.rmSync(UPD, { recursive: true, force: true });
  }
});

test("run-shell.sh counts a boot of a readable pending release", () => {
  fs.mkdirSync(UPD, { recursive: true });
  fs.writeFileSync(path.join(UPD, "pending"), "1.0.0 1.1.0\n");
  runShell();
  assert.equal(fs.readFileSync(path.join(UPD, "attempts"), "utf8").trim(), "1");
  assert.ok(fs.existsSync(path.join(UPD, "pending")));
  // the watchdog the script started exits once pending is gone
  fs.rmSync(UPD, { recursive: true, force: true });
});

test("a rollback record is cleared once a release at or past it commits, and only then", () => {
  fs.mkdirSync(UPD, { recursive: true });
  const failed = path.join(UPD, "failed");
  fs.writeFileSync(failed, "1.0.0 1.1.0\n");
  updater.clearSupersededFailure("1.0.1");
  assert.ok(fs.existsSync(failed), "an older release does not supersede the failed one");
  updater.clearSupersededFailure("1.1.0");
  assert.ok(!fs.existsSync(failed));
  fs.writeFileSync(failed, "1.0.0 1.1.0\n");
  updater.clearSupersededFailure("1.2.0");
  assert.ok(!fs.existsSync(failed));
  fs.rmSync(UPD, { recursive: true, force: true });
});

test("the shell removes an unreadable pending marker on its first healthy load", () => {
  fs.mkdirSync(UPD, { recursive: true });
  fs.writeFileSync(path.join(UPD, "pending"), "");
  fs.writeFileSync(path.join(UPD, "attempts"), "2");
  updater.onLauncherLoaded();
  assert.ok(!fs.existsSync(path.join(UPD, "pending")));
  assert.ok(!fs.existsSync(path.join(UPD, "attempts")));
  fs.rmSync(HOME, { recursive: true, force: true });
});

test("a response body is abandoned as soon as it passes the cap", async () => {
  let pulled = 0;
  const body = new ReadableStream({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(1000));
      if (pulled > 1000) c.close();
    },
  });
  const res = { headers: new Headers(), body };
  await assert.rejects(updater.readCapped(res, 4096), /too large/);
  assert.ok(pulled < 20, "stopped reading after " + pulled + " chunks");
  const small = { headers: new Headers(), body: new Response("abc").body };
  assert.strictEqual((await updater.readCapped(small, 10)).toString(), "abc");
  const declared = { headers: new Headers({ "content-length": "99999" }), body: new Response("x").body };
  await assert.rejects(updater.readCapped(declared, 10), /too large/);
});

test("a follower's wait keeps its start when a newer release arrives before it installed one", () => {
  const wait = path.join(UPD, "canary-wait");
  fs.mkdirSync(UPD, { recursive: true });
  fs.writeFileSync(wait, JSON.stringify({ version: "999.0.0", since: 1000 }));
  assert.strictEqual(updater.canaryWaitSince("999.1.0", 5000), 1000);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(wait, "utf8")), { version: "999.1.0", since: 1000 });
  // A record of a release this box already runs (or passed) starts a new wait.
  fs.writeFileSync(wait, JSON.stringify({ version: "0.0.1", since: 1000 }));
  assert.strictEqual(updater.canaryWaitSince("999.1.0", 5000), 5000);
  fs.rmSync(UPD, { recursive: true, force: true });
});
