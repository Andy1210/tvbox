// Tests for the safe-mode decision (deploy/tvbox-safemode.sh).
//
// What matters here is the state machine, because it is the part that can strand a
// box: engage too eagerly and a working box loses its session, engage stickily and
// the only way out is a card reader. So the counter, the healthy marker and both
// triggers are exercised against a fake root (TVBOX_TEST_ROOT) with the commands
// the script may call stubbed onto PATH - nothing below touches this machine.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const test = require("node:test");
const assert = require("node:assert");

const SCRIPT = path.join(__dirname, "tvbox-safemode.sh");

// A fake box: boot partition, root filesystem state dir, /run, and a home with a
// .tvbox tree (which is how the script finds the box user).
function fakeBox(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-safemode-test-"));
  fs.mkdirSync(path.join(root, "boot", "firmware"), { recursive: true });
  fs.mkdirSync(path.join(root, "run"), { recursive: true });
  fs.mkdirSync(path.join(root, "home", "tv", ".tvbox"), { recursive: true });
  fs.mkdirSync(path.join(root, "var", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "dev"), { recursive: true });
  // Stubs for everything the script shells out to, so a test can never reach the
  // real systemctl or chvt.
  const bin = path.join(root, "stub-bin");
  fs.mkdirSync(bin);
  for (const cmd of ["systemctl", "chvt"]) {
    fs.writeFileSync(path.join(bin, cmd), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  for (const [rel, body] of Object.entries(overrides)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return { root, bin };
}

function run(box, args = []) {
  const out = execFileSync("sh", [SCRIPT, ...args], {
    env: { PATH: box.bin + ":/usr/bin:/bin", TVBOX_TEST_ROOT: box.root },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out;
}

const p = (box, ...rel) => path.join(box.root, ...rel);
const stateOf = (box) => {
  const f = p(box, "var", "lib", "tvbox", "boot-state");
  if (!fs.existsSync(f)) return null;
  const kv = {};
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = /^([a-z-]+)=(.*)$/.exec(line);
    if (m) kv[m[1]] = m[2];
  }
  return kv;
};
const safeModeOn = (box) => fs.existsSync(p(box, "run", "tvbox-safe-mode"));
// chmod means nothing to uid 0, so a test that proves something by making a write
// fail only proves it as a normal user.
const rootless = { skip: process.getuid?.() === 0 ? "needs a non-root uid" : false };

test("the first boot counts as attempt 1 and does not engage safe mode", () => {
  const box = fakeBox();
  run(box);
  assert.strictEqual(safeModeOn(box), false);
  const s = stateOf(box);
  assert.strictEqual(s.attempts, "1");
  // No previous boot at all is not the same claim as "the previous boot failed".
  assert.strictEqual(s["prev-healthy"], "unknown");
  assert.strictEqual(s["safe-mode"], "no");
});

test("the third start in a row without a launcher engages safe mode", () => {
  const box = fakeBox();
  run(box);
  assert.strictEqual(stateOf(box).attempts, "1");
  assert.strictEqual(safeModeOn(box), false);
  run(box);
  assert.strictEqual(stateOf(box).attempts, "2");
  assert.strictEqual(stateOf(box)["prev-healthy"], "no");
  assert.strictEqual(safeModeOn(box), false);
  run(box);
  assert.strictEqual(safeModeOn(box), true);
  assert.match(fs.readFileSync(p(box, "run", "tvbox-safe-mode"), "utf8"), /did not reach the launcher/);
});

test("automatic safe mode lasts ONE boot - the counter is cleared on the way in", () => {
  // Otherwise a box that keeps failing is stuck in a mode only a card reader can
  // leave, which is the dead end safe mode exists to avoid.
  const box = fakeBox();
  run(box);
  run(box);
  run(box);
  assert.strictEqual(safeModeOn(box), true);
  assert.strictEqual(stateOf(box).attempts, "0", "a safe-mode boot is not a failed attempt at the session");
  // Next boot: /run is a tmpfs on a real box, so clear the flag as a reboot would.
  fs.rmSync(p(box, "run", "tvbox-safe-mode"));
  run(box);
  assert.strictEqual(safeModeOn(box), false, "the boot after safe mode tries normally");
  assert.strictEqual(stateOf(box).attempts, "1");
});

test("the boot after safe mode is not reported as a failed start", () => {
  // Safe mode never starts a session, so it cannot reach a launcher. Calling that a
  // failed start puts a fault in the report immediately after someone deliberately
  // used the recovery mode.
  const box = fakeBox({ "boot/firmware/tvbox-safe-mode": "" });
  run(box);
  assert.strictEqual(safeModeOn(box), true);
  fs.rmSync(p(box, "boot", "firmware", "tvbox-safe-mode")); // the way out
  fs.rmSync(p(box, "run", "tvbox-safe-mode")); // tmpfs, cleared by the reboot
  run(box);
  assert.strictEqual(safeModeOn(box), false);
  assert.match(stateOf(box)["prev-healthy"], /^n\/a/);
  assert.strictEqual(stateOf(box).attempts, "1", "and this boot is the first real attempt");
});

test("a healthy boot resets the counter", () => {
  const box = fakeBox();
  run(box);
  run(box); // two failed starts, one more would engage safe mode
  fs.writeFileSync(p(box, "home", "tv", ".tvbox", "healthy"), "boot=abc\n");
  run(box);
  assert.strictEqual(safeModeOn(box), false);
  const s = stateOf(box);
  assert.strictEqual(s["prev-healthy"], "yes");
  assert.strictEqual(s.attempts, "1", "counting starts again from this boot");
});

test("the healthy marker is consumed, so it can only ever vouch for the last boot", () => {
  // A marker left in place would vouch for every later boot as well and safe mode
  // would never engage again.
  const box = fakeBox();
  const marker = p(box, "home", "tv", ".tvbox", "healthy");
  fs.writeFileSync(marker, "boot=abc\n");
  run(box);
  assert.strictEqual(fs.existsSync(marker), false);
  run(box);
  assert.strictEqual(stateOf(box)["prev-healthy"], "no");
});

test("SAFE_MODE=true in tvbox.conf engages it and holds", () => {
  const box = fakeBox({ "boot/firmware/tvbox.conf": "HOSTNAME=tvbox\nSAFE_MODE=true\n" });
  run(box);
  assert.strictEqual(safeModeOn(box), true);
  assert.match(fs.readFileSync(p(box, "run", "tvbox-safe-mode"), "utf8"), /tvbox\.conf/);
  // Sticky: it is the request that holds it, not a counter, so every boot goes
  // back in until the file says otherwise.
  fs.rmSync(p(box, "run", "tvbox-safe-mode"));
  run(box);
  assert.strictEqual(safeModeOn(box), true);
  fs.writeFileSync(p(box, "boot", "firmware", "tvbox.conf"), "SAFE_MODE=false\n");
  fs.rmSync(p(box, "run", "tvbox-safe-mode"));
  run(box);
  assert.strictEqual(safeModeOn(box), false, "removing the request is the way out");
});

test("the standalone tvbox-safe-mode marker file works too", () => {
  // Creating an empty file is the one thing every OS's file manager can do on a
  // FAT card; editing a config file is not.
  const box = fakeBox({ "boot/firmware/tvbox-safe-mode": "" });
  run(box);
  assert.strictEqual(safeModeOn(box), true);
  assert.match(fs.readFileSync(p(box, "run", "tvbox-safe-mode"), "utf8"), /tvbox-safe-mode file/);
});

test("a Windows-edited tvbox.conf (CRLF) is still understood", () => {
  const box = fakeBox({ "boot/firmware/tvbox.conf": "SAFE_MODE=true\r\nHOSTNAME=x\r\n" });
  run(box);
  assert.strictEqual(safeModeOn(box), true);
});

test("SAFE_MODE with any other value is not a request", () => {
  for (const v of ["false", "no", "0", "", "maybe"]) {
    const box = fakeBox({ "boot/firmware/tvbox.conf": "SAFE_MODE=" + v + "\n" });
    run(box);
    assert.strictEqual(safeModeOn(box), false, "SAFE_MODE=" + v + " must not engage safe mode");
  }
});

test("a corrupt counter is treated as zero rather than crashing the boot", () => {
  for (const bad of ["attempts=nonsense\n", "attempts=-4\n", "attempts=\n", "garbage\n", ""]) {
    const box = fakeBox({ "var/lib/tvbox/boot-state": bad });
    run(box);
    assert.strictEqual(safeModeOn(box), false);
    assert.strictEqual(stateOf(box).attempts, "1");
  }
});

test("a read-only root filesystem does not stop the boot-partition request", rootless, () => {
  // This is the failure the whole feature is for: when / cannot be written the
  // counter is lost, so the marker on the FAT partition has to be enough on its own.
  const box = fakeBox({ "boot/firmware/tvbox-safe-mode": "" });
  fs.chmodSync(p(box, "var", "lib"), 0o555);
  try {
    run(box);
    assert.strictEqual(safeModeOn(box), true);
    assert.strictEqual(stateOf(box), null, "nothing was written to the read-only filesystem");
  } finally {
    fs.chmodSync(p(box, "var", "lib"), 0o755);
  }
});

test("--screen does nothing when safe mode is off", () => {
  const box = fakeBox();
  const tty = p(box, "dev", "tty1");
  fs.writeFileSync(tty, "");
  run(box, ["--screen"]);
  assert.strictEqual(fs.readFileSync(tty, "utf8"), "", "nothing must be drawn over a working session");
});

test("--screen prints the short report and what to do to the console", () => {
  const box = fakeBox();
  fs.writeFileSync(p(box, "run", "tvbox-safe-mode"), "because a test said so\n");
  const tty = p(box, "dev", "tty1");
  fs.writeFileSync(tty, "");
  // The real report needs root, so stand in for tvbox-diag on PATH and record how
  // it was called: the full report does not fit a TV console, so it must ask for
  // the short form.
  fs.writeFileSync(path.join(box.bin, "tvbox-diag"), '#!/bin/sh\necho "THE-REPORT args=$*"\n', { mode: 0o755 });
  run(box, ["--screen"]);
  const shown = fs.readFileSync(tty, "utf8");
  assert.match(shown, /tvbox SAFE MODE/);
  assert.match(shown, /because a test said so/, "why it is in safe mode, on the screen");
  assert.match(shown, /THE-REPORT args=--brief/, "the short form, not the whole report");
  // The way out has to be the last thing on screen, whatever the report's length.
  assert.match(shown, /What now:/);
  assert.match(shown, /SAFE_MODE=false/);
  assert.match(shown, /SSH_AUTHORIZED_KEY=/);
});

test("an unknown argument fails loudly instead of guessing", () => {
  const box = fakeBox();
  assert.throws(() => run(box, ["--wipe-everything"]), /status 2|Command failed/);
  assert.strictEqual(stateOf(box), null, "and changes nothing");
});
