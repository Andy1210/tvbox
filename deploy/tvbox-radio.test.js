// Tests for the built-in radio switch's root half (deploy/tvbox-radio).
//
// This script edits `config.txt` on the FAT boot partition, so its FAILURE paths
// are what matter: a Pi 5 whose config loses `dtoverlay=vc4-kms-v3d` does not come
// back to the TV, and there is no keyboard on a box in a living room. What is
// pinned here is that it never destroys a config it could not read, never edits an
// already-truncated one, never writes without a way back, and that two instances
// started at once do not lose one another's change.
//
// Everything runs against a fake root (TVBOX_TEST_ROOT), so no test reads or
// writes this machine's real boot partition.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const test = require("node:test");
const assert = require("node:assert");

const SCRIPT = path.join(__dirname, "tvbox-radio");

// What a stock Raspberry Pi OS config.txt looks like where it matters: several
// model sections, `[all]` last.
const STOCK = `# For more options and information see rpi-software-config
dtparam=audio=on
camera_auto_detect=1
dtoverlay=vc4-kms-v3d
max_framebuffers=2

[cm5]
dtoverlay=dwc2,dr_mode=host

[all]
vc4.force_hotplug=1
`;

function makeBox(config = STOCK) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-radio-test-"));
  const dir = path.join(root, "boot", "firmware");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.txt");
  if (config !== null) fs.writeFileSync(file, config);
  return { root, dir, file };
}

function run(box, action, opts = {}) {
  return execFileSync("sh", [SCRIPT, action], {
    env: { PATH: "/usr/bin:/bin", TVBOX_TEST_ROOT: box.root },
    encoding: "utf8",
    ...opts,
  });
}

// Runs the script and returns its status and output instead of throwing, because
// the refusals are the point of most of these tests.
function tryRun(box, action) {
  try {
    return { code: 0, out: run(box, action), err: "" };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ""), err: String(e.stderr || "") };
  }
}

test("turning a radio off appends the overlay under the unconditional section", () => {
  const box = makeBox();
  const out = run(box, "wifi-off");
  const after = fs.readFileSync(box.file, "utf8");
  assert.match(out, /wifi-off applied/);
  assert.match(after, /^dtoverlay=disable-wifi$/m);
  // The stock file already ends inside `[all]`, so nothing needs reopening.
  assert.strictEqual(after.match(/^\[all\]$/gm).length, 1);
  // And the rest of the file is still there - this is the part that boots the box.
  assert.match(after, /^dtoverlay=vc4-kms-v3d$/m);
});

test("a file ending in a model section gets `[all]` first, and only once", () => {
  // A bare append would scope the overlay to one model, silently doing nothing.
  const box = makeBox("dtoverlay=vc4-kms-v3d\n\n[cm5]\ndtoverlay=dwc2,dr_mode=host\n");
  run(box, "bt-off");
  const first = fs.readFileSync(box.file, "utf8");
  assert.match(first, /\[all\]\ndtoverlay=disable-bt\n$/);

  // Off -> on -> off used to leave one `[all]` behind per cycle.
  run(box, "bt-on");
  run(box, "bt-off");
  const cycled = fs.readFileSync(box.file, "utf8");
  assert.strictEqual(cycled.match(/^\[all\]$/gm).length, 1, "no `[all]` accumulation");
  assert.strictEqual(cycled, first, "a full cycle returns the same file");
});

test("a config it cannot READ is left alone", () => {
  // The destructive one: inside a `$(cat …)` feeding printf, a failed read is
  // printf's success, so the config was replaced by the two appended lines and the
  // script reported it applied. A failing SD card is exactly when this happens.
  const box = makeBox();
  const before = fs.readFileSync(box.file, "utf8");
  // With no backup yet, the mandatory-backup step would refuse the write for its
  // own reasons. A box that has been toggled once already has one, and then the
  // read is the only thing standing between a failing card and a 2-line config.
  fs.writeFileSync(`${box.file}.bak-tvbox-radio`, before);
  fs.chmodSync(box.file, 0o000);
  const r = tryRun(box, "wifi-off");
  fs.chmodSync(box.file, 0o644);
  assert.notStrictEqual(r.code, 0, "it fails");
  assert.doesNotMatch(r.out, /applied/, "and does not claim otherwise");
  assert.strictEqual(fs.readFileSync(box.file, "utf8"), before, "the config is untouched");
});

test("an already-empty config is refused rather than edited", () => {
  // The FAT truncation, already happened. Writing here produces a 2-line config
  // that cannot boot to the UI, and takes the backup with it.
  const box = makeBox("");
  const r = tryRun(box, "wifi-off");
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /EMPTY/);
  assert.strictEqual(fs.readFileSync(box.file, "utf8"), "");
  assert.strictEqual(fs.existsSync(`${box.file}.bak-tvbox-radio`), false, "and no backup was made of it");
});

test("the backup is the PRISTINE file, not the previous edit", () => {
  const box = makeBox();
  run(box, "wifi-off");
  run(box, "bt-off");
  assert.strictEqual(
    fs.readFileSync(`${box.file}.bak-tvbox-radio`, "utf8"),
    STOCK,
    "the first backup survives later changes",
  );
});

test("nothing is written when there is no way back", () => {
  const box = makeBox();
  const before = fs.readFileSync(box.file, "utf8");
  fs.chmodSync(box.dir, 0o500); // the directory is not writable: `cp` cannot land
  const r = tryRun(box, "wifi-off");
  fs.chmodSync(box.dir, 0o700);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(box.file, "utf8"), before);
  assert.deepStrictEqual(fs.readdirSync(box.dir), ["config.txt"], "and no temp file is left on the boot partition");
});

test("two instances started at once do not lose a change", async () => {
  // bt-off and wifi-off are DIFFERENT units, so systemd runs them in parallel and
  // both read the file before either writes.
  const box = makeBox();
  const one = (action) =>
    new Promise((resolve) =>
      execFile("sh", [SCRIPT, action], { env: { PATH: "/usr/bin:/bin", TVBOX_TEST_ROOT: box.root } }, () => resolve()),
    );
  await Promise.all([one("wifi-off"), one("bt-off")]);
  const after = fs.readFileSync(box.file, "utf8");
  assert.match(after, /^dtoverlay=disable-wifi$/m, "wifi survived");
  assert.match(after, /^dtoverlay=disable-bt$/m, "and so did bluetooth");
});

test("a radio can be re-enabled even when its line is the whole config", () => {
  // grep answers 1 when it prints nothing, which under `set -e` aborted with no
  // message at all - and a radio that could then never be turned back on. Emptying
  // the file is the right answer here: that line was the only thing in it.
  const box = makeBox("dtoverlay=disable-bt\n");
  const r = tryRun(box, "bt-on");
  assert.strictEqual(r.code, 0, "it succeeds instead of aborting");
  assert.match(r.out, /applied/);
  assert.doesNotMatch(fs.readFileSync(box.file, "utf8"), /disable-bt/, "the radio is on again");
  // And the file is still editable afterwards - an empty one would be refused.
  assert.strictEqual(tryRun(box, "bt-off").code, 0);
});

test("a commented line is a note, and re-enabling keeps it", () => {
  const box = makeBox(`${STOCK}#dtoverlay=disable-bt\n`);
  const out = run(box, "bt-off");
  assert.doesNotMatch(out, /already set/, "the note did not read as a setting");
  run(box, "bt-on");
  const after = fs.readFileSync(box.file, "utf8");
  assert.match(after, /^#dtoverlay=disable-bt$/m, "the note survives");
  assert.doesNotMatch(after, /^dtoverlay=disable-bt$/m, "the setting is gone");
});

test("CRLF line endings survive a change", () => {
  // A config.txt edited on Windows, which is how a flashed card often arrives.
  const box = makeBox(STOCK.replace(/\n/g, "\r\n"));
  run(box, "bt-off");
  const after = fs.readFileSync(box.file, "utf8");
  assert.match(after, /dtparam=audio=on\r\n/, "the existing lines keep their CRLF");
  assert.match(after, /^dtoverlay=disable-bt$/m);
});

test("an overlay already in force is a no-op, not a second line", () => {
  const box = makeBox();
  run(box, "bt-off");
  const once = fs.readFileSync(box.file, "utf8");
  const out = run(box, "bt-off");
  assert.match(out, /already set/);
  assert.strictEqual(fs.readFileSync(box.file, "utf8"), once);

  const clear = tryRun(box, "wifi-on");
  assert.strictEqual(clear.code, 0);
  assert.match(clear.out, /already clear/);
});

test("only the four actions are accepted", () => {
  const box = makeBox();
  const before = fs.readFileSync(box.file, "utf8");
  // Including the systemd escape of `bt-off`: the unit passes %i, not %I, so this
  // is what a granted-looking alternate spelling would actually deliver.
  for (const bad of ["", "bt", "BT-OFF", "bt-off extra", "bt\\x2doff", "wifi-off;reboot", "*", "../x"]) {
    const r = tryRun(box, bad);
    assert.strictEqual(r.code, 2, `${JSON.stringify(bad)} is refused`);
    assert.match(r.err, /usage:/);
  }
  assert.strictEqual(fs.readFileSync(box.file, "utf8"), before, "and nothing was written");
});

test("a missing config is reported, not created", () => {
  const box = makeBox(null);
  const r = tryRun(box, "wifi-off");
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /no .*config\.txt/);
  assert.strictEqual(fs.existsSync(box.file), false);
});

test("the config's own contents cannot become a format string or a command", () => {
  // config.txt is root-owned, but it is also the one file this script interpolates.
  const hostile = `${STOCK}# $(touch ${path.join(os.tmpdir(), "tvbox-radio-pwned")}) \`id\` %s %n *\n`;
  const box = makeBox(hostile);
  run(box, "bt-off");
  const after = fs.readFileSync(box.file, "utf8");
  assert.ok(after.startsWith(hostile), "preserved byte for byte");
  assert.strictEqual(fs.existsSync(path.join(os.tmpdir(), "tvbox-radio-pwned")), false);
});
