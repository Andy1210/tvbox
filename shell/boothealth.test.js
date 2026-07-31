// The shell's half of the safe-mode handshake (shell/boothealth.js).
//
// Two properties are load-bearing. The marker has to APPEAR, because without it
// the root-side counter reads every boot as a failed one and a working box walks
// itself into safe mode on the third start. And a failure to write it must never
// propagate: the boxes that cannot write are exactly the boxes this is reporting
// on, and taking the shell down over it would turn a warning into the outage.
//
// HOME is redirected before the require: the marker path resolves at import.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-boothealth-test-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;

// Every test wants a module that has not written yet (the write-once guard lives
// in module state, which is what a boot is).
function freshModule() {
  delete require.cache[require.resolve("./boothealth")];
  return require("./boothealth");
}
const MARKER = path.join(HOME, ".tvbox", "healthy");

test("the launcher loading records a healthy boot", () => {
  fs.rmSync(MARKER, { force: true });
  const boothealth = freshModule();
  assert.strictEqual(boothealth.markHealthy("1.2.3"), true);
  const body = fs.readFileSync(MARKER, "utf8");
  assert.match(body, /^boot=/m, "the boot it refers to, for anyone reading it by hand");
  assert.match(body, /^version=1\.2\.3$/m);
  assert.match(body, /^at=\d{4}-/m);
});

test("it creates ~/.tvbox if a fresh box has not got one yet", () => {
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-boothealth-bare-"));
  process.env.HOME = home2;
  try {
    const boothealth = freshModule();
    assert.strictEqual(boothealth.markHealthy(), true);
    assert.ok(fs.existsSync(path.join(home2, ".tvbox", "healthy")));
  } finally {
    process.env.HOME = HOME;
  }
});

test("only the first load of a boot writes it", () => {
  // did-finish-load fires on every navigation between the launcher and an app, and
  // the marker says something about the boot, not about the page.
  fs.rmSync(MARKER, { force: true });
  const boothealth = freshModule();
  assert.strictEqual(boothealth.markHealthy("1.2.3"), true);
  const first = fs.readFileSync(MARKER, "utf8");
  assert.strictEqual(boothealth.markHealthy("1.2.3"), false);
  assert.strictEqual(boothealth.markHealthy("1.2.3"), false);
  assert.strictEqual(fs.readFileSync(MARKER, "utf8"), first, "and does not rewrite it");
});

test("a box that cannot write the marker keeps running", () => {
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-boothealth-ro-"));
  fs.chmodSync(home3, 0o555);
  process.env.HOME = home3;
  try {
    const boothealth = freshModule();
    assert.strictEqual(boothealth.markHealthy("1.2.3"), false, "reports the failure");
  } finally {
    process.env.HOME = HOME;
    fs.chmodSync(home3, 0o755);
  }
});

test("the marker is where tvbox-safemode.sh looks for it", () => {
  // Both sides hardcode this path; if one of them moves, the box loses the signal
  // silently and starts counting healthy boots as failures.
  const boothealth = freshModule();
  assert.strictEqual(boothealth.MARKER, path.join(HOME, ".tvbox", "healthy"));
  const script = fs.readFileSync(path.join(__dirname, "..", "deploy", "tvbox-safemode.sh"), "utf8");
  assert.match(script, /\$BOX_HOME\/\.tvbox\/healthy/);
});

test.after(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});
