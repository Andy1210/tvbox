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

test("the shell removes an unreadable pending marker on its first healthy load", () => {
  fs.mkdirSync(UPD, { recursive: true });
  fs.writeFileSync(path.join(UPD, "pending"), "");
  fs.writeFileSync(path.join(UPD, "attempts"), "2");
  updater.onLauncherLoaded();
  assert.ok(!fs.existsSync(path.join(UPD, "pending")));
  assert.ok(!fs.existsSync(path.join(UPD, "attempts")));
  fs.rmSync(HOME, { recursive: true, force: true });
});
