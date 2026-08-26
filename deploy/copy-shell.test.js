// What ships inside shell/, and that only one place decides it.
//
// The exclude list was hand-written in four copiers and had already drifted -
// make-release.sh and deploy.sh left out `electron-web-client`, build-image.sh and
// image.yml did not, so the SD image shipped a directory the other two channels
// agreed did not belong. That is the same failure `deploy/infra.list` exists to
// prevent, and the same answer: one list, one copier, and a test that fails when a
// fifth copier writes its own.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const TVBOX = path.join(__dirname, "..");
const LIST = path.join(TVBOX, "deploy", "shell-exclude.list");
const COPIER = path.join(TVBOX, "scripts", "copy-shell.sh");

const patterns = () =>
  fs
    .readFileSync(LIST, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter((l) => l && !l.startsWith("#"));

// rsync and find(1) are on every machine that can build a release; the cases
// that need a real filesystem skip rather than fail where they are not.
const HAVE_RSYNC = spawnSync("rsync", ["--version"]).status === 0;

// The channels that put shell/ on a box. Adding one means adding it here.
const COPIERS = [
  "scripts/make-release.sh", // OTA tarball
  "scripts/build-image.sh", // SD image
  ".github/workflows/image.yml", // SD image, in CI
  "deploy/deploy.sh", // dev deploy over ssh
];

test("the list names what a box must never be sent", () => {
  const p = patterns();
  for (const want of ["node_modules", "apps-data", "*.log", "electron-web-client", "*.test.js"]) {
    assert.ok(p.includes(want), "shell-exclude.list is missing " + want);
  }
});

test("every channel that ships shell/ goes through the one copier", () => {
  for (const rel of COPIERS) {
    const src = fs.readFileSync(path.join(TVBOX, rel), "utf8");
    assert.match(src, /copy-shell\.sh/, rel + " does not use scripts/copy-shell.sh");
  }
});

test("...and none of them writes its own exclude list", () => {
  // The drift this replaced: four hand-written lists, two of them wrong. A
  // `--exclude` beside an rsync of shell/ is a fifth list starting to form.
  for (const rel of COPIERS) {
    const src = fs.readFileSync(path.join(TVBOX, rel), "utf8");
    for (const line of src.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      if (!/\brsync\b/.test(line)) continue;
      assert.ok(
        !/--exclude/.test(line),
        rel + ' rsyncs with its own --exclude: "' + line.trim() + '" - put the pattern in shell-exclude.list',
      );
    }
  }
});

test("no OTHER file in the repo rsyncs shell/ on its own", () => {
  // A fifth copier is how the previous list drifted in the first place.
  const roots = ["scripts", "deploy", ".github/workflows", "image"];
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(sh|yml|yaml)$/.test(e.name)) files.push(full);
    }
  };
  for (const r of roots) walk(path.join(TVBOX, r));
  const offenders = [];
  for (const full of files) {
    const rel = path.relative(TVBOX, full);
    if (COPIERS.includes(rel) || rel === "scripts/copy-shell.sh") continue;
    for (const line of fs.readFileSync(full, "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      if (/\brsync\b/.test(line) && /(^|[\s"'/])shell([\s"'/]|$)/.test(line)) offenders.push(rel + ": " + line.trim());
    }
  }
  assert.deepEqual(offenders, [], "a shell/ copier outside the known set:\n" + offenders.join("\n"));
});

// `--delete` leaves excluded files alone on the receiver, so each channel has to
// say what it means, and the two answers are not interchangeable.
test("--delete-excluded is used where the destination is a build tree, and NEVER on a box", () => {
  // Code lines only: deploy.sh explains in a comment why it must NOT use the flag,
  // and a check that reads its own explanation as the thing it forbids is no check.
  const code = (rel) =>
    fs
      .readFileSync(path.join(TVBOX, rel), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");

  // A staging directory survives between builds and holds nothing installed, so a
  // file excluded since the last build must be cleaned out of it.
  for (const rel of ["scripts/build-image.sh", ".github/workflows/image.yml"]) {
    assert.match(code(rel), /copy-shell\.sh.*--delete-excluded/, rel + " leaves a stale payload behind");
  }

  // A box is the opposite case: node_modules is the ~700 MB Electron install the
  // box did for itself, apps-data is every installed app's bundle, and both are on
  // the exclude list - so the flag would delete them.
  assert.ok(
    !/--delete-excluded/.test(code("deploy/deploy.sh")),
    "deploy.sh must not use --delete-excluded - it would take the box's node_modules and apps-data",
  );

  // Which is why it retires the excluded files by name instead. Pulled out of
  // deploy.sh and RUN, not matched: two versions of this looked right and deleted
  // nothing - the first lost its backslashes to the local shell, the second hit
  // find's refusal to combine -prune with -delete - and `|| true` plus a stderr
  // redirect meant a clean-looking deploy either way.
  const retire = code("deploy/deploy.sh")
    .split("\n")
    .find((l) => /\bssh\b/.test(l) && /-name "\*\.test\.js"/.test(l));
  assert.ok(retire, "deploy.sh has no retire step for tests already on a box");
  assert.match(retire, /-not -path "\*\/node_modules\/\*"/, "the retire step must spare the box's node_modules");
  assert.match(retire, /-not -path "\*\/apps-data\/\*"/, "the retire step must spare an installed app");

  if (!HAVE_RSYNC) return; // the fixture below needs a real filesystem and find(1)
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-retire-"));
  const put = (rel) => {
    fs.mkdirSync(path.join(box, ".tvbox", "shell", path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(box, ".tvbox", "shell", rel), "x");
  };
  put("main.js");
  put("appinfo.test.js");
  put("pairing/peer.test.js");
  put("node_modules/electron/lib/thing.test.js"); // the box's own install
  put("apps-data/retroarch/web/vendor.test.js"); // an installed app's bundle
  // Run what deploy.sh runs, with $HOME pointed at the fixture: strip the `ssh
  // "$PI"` wrapper and keep the remote command exactly as it is sent.
  const remote = retire
    .replace(/^\s*ssh\s+"\$PI"\s+/, "")
    .replace(/^'/, "")
    .replace(/'\s*$/, "");
  const r = spawnSync("bash", ["-c", remote], { env: { ...process.env, HOME: box }, encoding: "utf8" });
  assert.equal(r.status, 0, "the retire step failed: " + (r.stderr || ""));
  const alive = (rel) => fs.existsSync(path.join(box, ".tvbox", "shell", rel));
  assert.equal(alive("appinfo.test.js"), false, "a stale test was left on the box");
  assert.equal(alive("pairing/peer.test.js"), false, "a stale test in a subdirectory was left on the box");
  assert.equal(alive("main.js"), true, "the retire step took the shell with it");
  assert.equal(alive("node_modules/electron/lib/thing.test.js"), true, "it reached into the box's node_modules");
  assert.equal(alive("apps-data/retroarch/web/vendor.test.js"), true, "it reached into an installed app");
  fs.rmSync(box, { recursive: true, force: true });
});

// The end-to-end half: run the real copier and look at what came out. rsync is on
// every machine that can build a release; skip rather than fail where it is not.
test("the copier really leaves the tests, node_modules and the logs behind", { skip: !HAVE_RSYNC }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-copyshell-"));
  const r = spawnSync("bash", [COPIER, out], { encoding: "utf8" });
  assert.equal(r.status, 0, "copy-shell.sh failed: " + (r.stderr || ""));

  const found = [];
  const walk = (dir, base) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.join(base, e.name);
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else found.push(rel);
    }
  };
  walk(path.join(out, "shell"), "");

  assert.ok(found.length > 50, "the copy is suspiciously small: " + found.length + " files");
  assert.deepEqual(
    found.filter((f) => f.endsWith(".test.js")),
    [],
    "tests reached the payload",
  );
  assert.deepEqual(
    found.filter((f) => f.split(path.sep).includes("node_modules")),
    [],
    "node_modules reached the payload",
  );
  assert.deepEqual(
    found.filter((f) => f.endsWith(".log")),
    [],
    "a log reached the payload",
  );

  // …and that it still ships the shell itself, so an over-broad pattern cannot
  // quietly empty the release.
  for (const want of ["main.js", "package.json", "preload.js", path.join("pairing", "index.js")]) {
    assert.ok(found.includes(want), "the payload is missing " + want);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

test("an empty list is refused rather than shipping everything", { skip: !HAVE_RSYNC }, () => {
  // A list that read as empty would put ~700 MB of node_modules into an OTA
  // tarball, which is the one failure worse than shipping the tests.
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-copyshell-empty-"));
  fs.mkdirSync(path.join(box, "scripts"));
  fs.mkdirSync(path.join(box, "deploy"));
  fs.mkdirSync(path.join(box, "shell"));
  fs.copyFileSync(COPIER, path.join(box, "scripts", "copy-shell.sh"));
  fs.writeFileSync(path.join(box, "deploy", "shell-exclude.list"), "# nothing but a comment\n");
  const r = spawnSync("bash", [path.join(box, "scripts", "copy-shell.sh"), path.join(box, "out")], {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exclude list is empty/);
  fs.rmSync(box, { recursive: true, force: true });
});
