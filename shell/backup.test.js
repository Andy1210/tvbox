// The restore side of the backup, where the input is untrusted: a .tvbackup is
// attacker-supplied until its password verifies, and even after that it may come
// from a different box with different apps on it.
//
// Everything here runs against an isolated HOME, so no test reads or writes this
// machine's real ~/.tvbox.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-backup-test-"));
process.env.HOME = TMP;

const backup = require("./backup");
const apps = require("./install");

// One app that declares files of its own, dropped in as a manifest so install.js
// picks it up like any other user app.
const APP_ID = "smoketest";
function installFakeApp(backupDecl) {
  fs.mkdirSync(apps.USER_APPS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(apps.USER_APPS_DIR, APP_ID + ".json"),
    JSON.stringify({
      id: APP_ID,
      name: "Smoke",
      type: "webclient",
      status: "ready",
      backup: backupDecl,
    }),
  );
  apps.loadManifests();
  const root = apps.appBackupRoot(apps.manifestById(APP_ID));
  // Each test gets a fresh root: they assert on what a restore did or did not
  // create, so a leftover directory from the previous one would decide the answer.
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function restore(files) {
  // apply() parks app files; applyPendingAppFiles is what places them.
  backup.apply({ format: "tvbox-backup", version: 1, appFiles: { [APP_ID]: files } });
  return backup.applyPendingAppFiles({ final: true });
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("a declared file is restored under the app's own root", () => {
  const root = installFakeApp({ paths: ["saves", "app.cfg"] });
  restore({ "saves/game.srm": b64("save data"), "app.cfg": b64("k=v") });
  assert.equal(fs.readFileSync(path.join(root, "saves/game.srm"), "utf8"), "save data");
  assert.equal(fs.readFileSync(path.join(root, "app.cfg"), "utf8"), "k=v");
  // Restored files carry a secret often enough (the documented example holds share
  // credentials) that the mode is part of the contract.
  assert.equal(fs.statSync(path.join(root, "app.cfg")).mode & 0o777, 0o600);
});

test("a path outside the declared set is refused", () => {
  const root = installFakeApp({ paths: ["saves"] });
  restore({ "states/1.state": b64("nope"), "../../.ssh/authorized_keys": b64("nope") });
  assert.equal(fs.existsSync(path.join(root, "states")), false);
  assert.equal(fs.existsSync(path.join(TMP, ".ssh")), false);
});

// `saves/..` passes the declared-prefix check and resolves to the root itself, so
// the guard has to be a strict prefix. A regular file where a flatpak's data dir
// belongs is a flatpak that cannot be installed again without hand-deleting it.
test("a declared path that resolves back to the root is refused", () => {
  const root = installFakeApp({ paths: ["saves"] });
  restore({ "saves/..": b64("nope") });
  assert.ok(fs.lstatSync(root).isDirectory(), "the root is still a directory");
});

// The prefix guard compares resolved strings, which says nothing about what is on
// disk. A link inside the root would send the write wherever it points.
test("a symlink on the path is not followed out of the root", () => {
  const root = installFakeApp({ paths: ["saves"] });
  const outside = path.join(TMP, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(root, "saves"));
  restore({ "saves/escaped.txt": b64("nope") });
  assert.equal(fs.existsSync(path.join(outside, "escaped.txt")), false, "the write followed the symlink");
});

test("a file is never written over a directory", () => {
  const root = installFakeApp({ paths: ["saves"] });
  fs.mkdirSync(path.join(root, "saves"), { recursive: true });
  restore({ saves: b64("nope") });
  assert.ok(fs.lstatSync(path.join(root, "saves")).isDirectory());
});

// The ~/.tvbox sidecar namespace: an app may only claim its own id-prefixed files,
// and never one of the shell's.
test("state sidecars land in ~/.tvbox, and only the app's own", () => {
  installFakeApp({ paths: ["saves"], state: [APP_ID + "-share.json"] });
  const cfg = path.join(TMP, ".tvbox", "config.json");
  fs.writeFileSync(cfg, '{"real":true}');
  const before = fs.readFileSync(cfg, "utf8");
  restore({
    ["state/" + APP_ID + "-share.json"]: b64('{"ok":true}'),
    "state/config.json": b64('{"pwned":true}'),
    [APP_ID + "-undeclared.json"]: b64("nope"),
  });
  assert.equal(fs.readFileSync(path.join(TMP, ".tvbox", APP_ID + "-share.json"), "utf8"), '{"ok":true}');
  assert.equal(fs.readFileSync(cfg, "utf8"), before, "config.json was rewritten");
});

// ---- a snapshot from ANOTHER box must not carry that box's app identity ----
// localStorage is shared by the launcher and every local app on one origin, so a
// clone seed used to hand the second box the first one's Plex client identifier
// (and its login): two boxes, one device on plex.tv, neither room addressable.

const identity = require("./identity");

const SNAPSHOT = JSON.stringify({
  "tvbox.setup.done": "1",
  "tvbox.appPrefs": '{"order":["plex"]}',
  ClientID: "fsbet2zresma446qnnvt4kst",
  PlexAuthToken: "a-real-token",
});

test("a same-box restore replays the snapshot verbatim", () => {
  assert.strictEqual(backup.ownStorageOnly(SNAPSHOT, true), SNAPSHOT);
});

test("another box's restore keeps the launcher's keys and drops the apps'", () => {
  const kept = JSON.parse(backup.ownStorageOnly(SNAPSHOT, false));
  assert.deepStrictEqual(kept, { "tvbox.setup.done": "1", "tvbox.appPrefs": '{"order":["plex"]}' });
  // The two that matter: an app identity and an account credential.
  assert.ok(!("ClientID" in kept), "the app's client identifier stays behind");
  assert.ok(!("PlexAuthToken" in kept), "so does the login it came with");
});

test("nothing is parked when a foreign snapshot has no launcher keys", () => {
  assert.strictEqual(backup.ownStorageOnly(JSON.stringify({ ClientID: "x" }), false), "");
});

test("a snapshot that is not an object is not replayed", () => {
  for (const junk of ["{not json", JSON.stringify(["a"]), JSON.stringify("s"), "null"]) {
    assert.strictEqual(backup.ownStorageOnly(junk, false), "", junk);
  }
});

test("a re-flash restores verbatim even though the machine id changed", () => {
  // The main thing a backup is for. A re-flashed box has a FRESH machine id, so
  // an id-only test would call its own backup foreign and strip the app keys.
  assert.strictEqual(backup.sameBox({ machineId: "0000deadbeef", clone: false }), true);
});

test("a clone seed is foreign even when the ids cannot tell", () => {
  assert.strictEqual(backup.sameBox({ machineId: "0000deadbeef", clone: true }), false);
});

test("the machine id can only ever force the answer to same", () => {
  // Restoring a seed onto the box it was made on: whatever the radio said, this
  // is provably not another box's identity.
  assert.strictEqual(backup.sameBox({ machineId: identity.machineId(), clone: true }), true);
});

test("a backup from before machine ids falls back to the flag alone", () => {
  assert.strictEqual(backup.sameBox({ clone: false }), true);
  assert.strictEqual(backup.sameBox({ clone: true }), false);
});

test("apply() parks only the launcher's keys from a foreign payload", () => {
  const parked = path.join(TMP, ".tvbox", "restore-localstorage.json");
  fs.rmSync(parked, { force: true });
  backup.apply({
    format: "tvbox-backup",
    version: 1,
    machineId: "0000deadbeef",
    clone: true,
    localStorage: SNAPSHOT,
  });
  const data = JSON.parse(JSON.parse(fs.readFileSync(parked, "utf8")).data);
  assert.deepStrictEqual(Object.keys(data).sort(), ["tvbox.appPrefs", "tvbox.setup.done"]);
});

test("a foreign snapshot with nothing to keep clears an earlier parked one", () => {
  // Copilot's catch on the PR: skipping the write is not the same as parking
  // nothing. Whatever a previous restore left behind would be replayed on the
  // next boot, which is the stale identity this whole guard exists to stop.
  const parked = path.join(TMP, ".tvbox", "restore-localstorage.json");
  fs.writeFileSync(parked, JSON.stringify({ data: JSON.stringify({ ClientID: "stale" }), at: 1 }));
  backup.apply({
    format: "tvbox-backup",
    version: 1,
    machineId: "0000deadbeef",
    clone: true,
    localStorage: JSON.stringify({ ClientID: "fsbet2zresma446qnnvt4kst" }),
  });
  assert.strictEqual(fs.existsSync(parked), false, "the older snapshot is gone, not left to be replayed");
  assert.strictEqual(backup.pendingLocalStorage().data, null);
});

test("a payload carrying no snapshot clears the parked one too", () => {
  // The CLI has no renderer to collect from, so `tvbox backup` produces
  // localStorage:null. That is still an intent - "this restore hands the
  // launcher nothing" - and an older parked file would otherwise outlive it.
  const parked = path.join(TMP, ".tvbox", "restore-localstorage.json");
  fs.writeFileSync(parked, JSON.stringify({ data: JSON.stringify({ "tvbox.locale": "hu" }), at: 1 }));
  backup.apply({ format: "tvbox-backup", version: 1, machineId: identity.machineId() });
  assert.strictEqual(fs.existsSync(parked), false);
});

test("a same-box restore still parks its snapshot", () => {
  // The clearing must not swallow the ordinary case: a re-flash restore is
  // supposed to hand the launcher everything back.
  backup.apply({
    format: "tvbox-backup",
    version: 1,
    machineId: identity.machineId(),
    localStorage: SNAPSHOT,
  });
  assert.strictEqual(backup.pendingLocalStorage().data, SNAPSHOT);
});
