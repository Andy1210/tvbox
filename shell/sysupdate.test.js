// The shell's half of a system update, and the requirement that gates it.
//
// Two things here are easy to get subtly wrong and expensive to have wrong:
//
//   - the applied revision is read from disk on EVERY call. The root half writes
//     it while this process keeps running, and the box deliberately does not
//     reboot afterwards, so a cached value would leave Settings insisting a
//     system update is needed until the next boot.
//   - an unreadable or absent marker means 0, i.e. "the step is still needed".
//     The other way round - reading a missing file as "met" - silently skips the
//     step for ever, which is the one failure this mechanism must not have.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

// The module resolves its paths at import, like every other shell module, so a
// test root has to be in the environment before the require.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "shell-sysupd-"));
process.env.TVBOX_STATE_DIR = path.join(ROOT, "var/lib/tvbox");
process.env.TVBOX_RUN_DIR = path.join(ROOT, "run/tvbox");
// The root-owned side goes under the fake root too, so "is the applier
// installed?" is answered by the fixture rather than by whatever the machine
// running the tests happens to have in /usr/local.
process.env.TVBOX_SBIN_DIR = path.join(ROOT, "usr/local/sbin");
process.env.TVBOX_ETC_DIR = path.join(ROOT, "etc");
for (const d of ["TVBOX_STATE_DIR", "TVBOX_RUN_DIR", "TVBOX_SBIN_DIR"])
  fs.mkdirSync(process.env[d], { recursive: true });
for (const d of ["systemd/system", "polkit-1/rules.d", "tvbox/release-keys.d"])
  fs.mkdirSync(path.join(process.env.TVBOX_ETC_DIR, d), { recursive: true });
const sysupdate = require("./sysupdate.js");
const updater = require("./updater.js");

const REV = path.join(process.env.TVBOX_STATE_DIR, "system-revision");
const STATUS = path.join(process.env.TVBOX_STATE_DIR, "sysupdate-status.json");

function setRevision(text) {
  if (text === null) fs.rmSync(REV, { force: true });
  else fs.writeFileSync(REV, text);
}

test("the revision is whatever is on disk right now", () => {
  setRevision("3\n");
  assert.equal(sysupdate.appliedRevision(), 3);
  // The root half writes this while the shell is running; a cached read would
  // keep the Settings screen asking for an update that already happened.
  setRevision("4\n");
  assert.equal(sysupdate.appliedRevision(), 4);
});

test("anything unreadable reads as 0, never as satisfied", () => {
  for (const bad of [null, "", "  ", "seven", "-1", "3.5", "9999999", "3 4"]) {
    setRevision(bad);
    assert.equal(sysupdate.appliedRevision(), 0, JSON.stringify(bad));
  }
});

test("a release needs a system update until the box has actually applied one", () => {
  setRevision("3\n");
  assert.deepEqual(updater.unmetRequirements({ requires: ["system:4"] }), ["system:4"]);
  assert.deepEqual(updater.unmetRequirements({ requires: ["system:3"] }), []);
  assert.deepEqual(updater.unmetRequirements({ requires: ["system:1"] }), []);
  setRevision(null);
  assert.deepEqual(updater.unmetRequirements({ requires: ["system:1"] }), ["system:1"]);
});

test("a requirement that only looks like a system one fails closed", () => {
  setRevision("99\n");
  // Every one of these is unrecognised, and an unrecognised requirement is one
  // this box certainly does not meet. A lenient parse here would hand a release
  // to a box on the strength of a typo.
  for (const r of [
    "system:",
    "system",
    "system:-1",
    "system: 4",
    "system:4 ",
    "system:04x",
    "SYSTEM:4",
    "system:4:5",
    "system:1234567",
  ]) {
    assert.deepEqual(updater.unmetRequirements({ requires: [r] }), [r], r);
  }
  // Leading zeros are digits, so this one IS a system requirement.
  assert.deepEqual(updater.unmetRequirements({ requires: ["system:004"] }), []);
});

test("a mixed set keeps every kind of failure", () => {
  setRevision("1\n");
  const unmet = updater.unmetRequirements({ requires: ["system:9", "compositor", "future-thing"] });
  assert.deepEqual(unmet, ["system:9", "compositor", "future-thing"]);
  // The UI has to tell "press this button" from "this box has to be set up
  // again", so it needs the number rather than the fact that something is unmet.
  assert.equal(updater.neededSystemRevision(unmet), 9);
  assert.equal(updater.neededSystemRevision(["compositor", "future-thing"]), null);
  assert.equal(updater.neededSystemRevision(["system:2", "system:7"]), 7);
  assert.equal(updater.neededSystemRevision([]), null);
});

test("a status document from before the request is the previous run's", () => {
  // systemctl start --no-block returns as soon as the job is queued, so between
  // the press and the applier's first write there is nothing new on disk. Reading
  // the old document would turn a press into an instant "done".
  fs.writeFileSync(STATUS, JSON.stringify({ code: "ok", startedAt: 1000, finishedAt: 2000 }));
  assert.equal(sysupdate.status().code, "ok");
});

test("a code the shell has never heard of is not passed through to the UI", () => {
  // The launcher renders these as translated strings, and the applier is a root
  // script whose own words are English.
  fs.writeFileSync(STATUS, JSON.stringify({ code: "something-new", startedAt: 0 }));
  assert.equal(sysupdate.status().code, "internal");
  fs.writeFileSync(STATUS, JSON.stringify({ code: "ok-warnings", startedAt: 0, warnings: 2 }));
  const s = sysupdate.status();
  assert.equal(s.code, "ok-warnings");
  assert.equal(s.warnings, 2);
});

test("a run cut off by a power loss does not freeze the screen for ever", () => {
  // /run is a tmpfs, so a status that says "running" in a boot with no marker
  // beside it belongs to a run that never finished. Reported as `running` it
  // would keep `working` true, which disables Check and hides BOTH install rows -
  // the box could then never update again, OTA included, with no ssh to fix it.
  fs.writeFileSync(STATUS, JSON.stringify({ code: "running", startedAt: 0, finishedAt: null }));
  fs.rmSync(sysupdate.RUNNING_FILE, { force: true });
  assert.equal(sysupdate.status().code, "interrupted");
  fs.writeFileSync(sysupdate.RUNNING_FILE, "1-2\n");
  assert.equal(sysupdate.status().code, "running");
  fs.rmSync(sysupdate.RUNNING_FILE, { force: true });
});

test("every outcome the shell can report has a Hungarian and an English string", () => {
  // locales.test.ts cannot see these: `update.sys.` is in its DYNAMIC list, which
  // switches off the dead-key check in both directions. Without this a new code
  // reaches a Hungarian TV as the literal string "update.sys.<code>".
  const read = (l) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "launcher/src/locales", l + ".json"), "utf8"));
  const en = read("en").update.sys;
  const hu = read("hu").update.sys;
  for (const code of sysupdate.CODES) {
    // `idle` is the absence of news and is never rendered.
    if (code === "idle") continue;
    assert.ok(en[code], "no English string for update.sys." + code);
    assert.ok(hu[code], "no Hungarian string for update.sys." + code);
  }
});

test("a press is not answered with the previous run's result, and does not wait for ever", () => {
  // The three states between pressing and hearing back. `systemctl start
  // --no-block` reports success as soon as the job is QUEUED, so all of them are
  // reachable without anything having gone wrong on the box.
  const before = { code: "ok", startedAt: 1000, finishedAt: 2000 };
  const now = 10_000_000; // comfortably past the grace window, so both sides of it are reachable
  // A document older than the request belongs to the run before it, so it is not
  // reported - the screen waits instead.
  assert.equal(sysupdate.resolveCode(before, { requestedAt: now - 1000, now }), "starting");
  // ...but not for ever: a unit that never activates, or a run blocked behind
  // another holding the lock, would otherwise leave every button disabled.
  assert.equal(sysupdate.resolveCode(before, { requestedAt: now - sysupdate.START_GRACE_MS - 1, now }), "internal");
  // Once the run does write something, that is the answer.
  assert.equal(sysupdate.resolveCode({ code: "ok", startedAt: now - 500 }, { requestedAt: now - 1000, now }), "ok");
  // With no request in this session, whatever is on disk stands.
  assert.equal(sysupdate.resolveCode(before, {}), "ok");
  assert.equal(sysupdate.resolveCode(null, {}), "idle");
  // A run that says it is going, in a boot with no marker for it, was cut off.
  assert.equal(sysupdate.resolveCode({ code: "running", startedAt: 0 }, { running: true }), "running");
  assert.equal(sysupdate.resolveCode({ code: "running", startedAt: 0 }, { running: false }), "interrupted");
  // And a start systemd refused beats anything on disk.
  assert.equal(sysupdate.resolveCode(before, { denied: true }), "start-denied");
});

test("a button is offered only when every piece a press needs is there", () => {
  // Each of these is separately absent on a real box, and each absence is a press
  // that can only fail: no applier at all on a box that predates it, no key means
  // it cannot verify anything it downloads.
  //
  // The polkit rule is NOT among them, and must not be: /etc/polkit-1/rules.d is
  // 0750 root:polkitd, so the shell cannot stat what is inside it. Measured on a
  // deployed box - the rule was installed and correct, and a stat of it raised
  // EACCES, so requiring it here hid the button on every box in the fleet.
  const pieces = [sysupdate.HELPER, sysupdate.UNIT_FILE];
  const key = path.join(sysupdate.KEYS_DIR, "tvbox-release.pem");
  for (const f of pieces) fs.writeFileSync(f, "x");
  fs.writeFileSync(key, "-----BEGIN PUBLIC KEY-----\n");
  assert.equal(sysupdate.available(), true);
  for (const f of [...pieces, key]) {
    fs.rmSync(f);
    assert.equal(sysupdate.available(), false, "still available without " + path.basename(f));
    fs.writeFileSync(f, "x");
  }
  for (const f of [...pieces, key]) fs.rmSync(f, { force: true });
  assert.equal(sysupdate.available(), false);
});

test("the box reports no applier when the root half is not installed", () => {
  // Every box in the field is running a shell older than tvbox-sysupdate, so the
  // UI has to be able to tell the two situations apart - offering a button that
  // can only fail is worse than the honest older sentence.
  assert.equal(sysupdate.available(), false);
  assert.equal(updater.status().system.available, false);
});

test("the status the routes hand out carries what the screen decides on", () => {
  setRevision("2\n");
  const s = updater.status().system;
  for (const k of ["available", "revision", "needs", "feedRevision", "code", "warnings", "rebootRequired", "at"]) {
    assert.ok(k in s, "missing " + k);
  }
  assert.equal(s.revision, 2);
});

test("the applier's feed URL and the shell's default point at the same place", () => {
  // Two files, one address: shell/updater.js drives the user-space half and
  // deploy/sysupdate.conf drives the root half. A box whose halves disagree takes
  // a release from one feed and its root payload from another.
  const conf = fs.readFileSync(path.join(__dirname, "..", "deploy", "sysupdate.conf"), "utf8");
  const m = /^FEED_URL=(\S+)$/m.exec(conf);
  assert.ok(m, "deploy/sysupdate.conf has no FEED_URL");
  assert.equal(m[1], updater.DEFAULT_FEED);
});

test("the shipped polkit rule grants start on one unit and nothing else", () => {
  const rule = fs.readFileSync(path.join(__dirname, "..", "deploy", "54-tvbox-sysupdate.rules"), "utf8");
  assert.match(rule, /action\.lookup\("unit"\) === "tvbox-sysupdate\.service"/);
  assert.match(rule, /action\.lookup\("verb"\) === "start"/);
  // stop would let the shell kill a provision run half way through, and a
  // wildcard would cover greetd and NetworkManager besides.
  assert.doesNotMatch(rule, /"stop"|"restart"|indexOf\(action\.lookup\("verb"\)\)/);
  assert.equal(sysupdate.UNIT, "tvbox-sysupdate.service");
});

test("the system unit is never enabled, and never treated as a user unit", () => {
  const unit = fs.readFileSync(path.join(__dirname, "..", "deploy", "tvbox-sysupdate.service"), "utf8");
  // A [Install] section plus updater.js's WantedBy symlinking would start a
  // system update at every boot.
  assert.doesNotMatch(unit, /^\[Install\]/m);
  assert.ok(!updater.USER_UNITS.includes("tvbox-sysupdate.service"));
  assert.ok(updater.INFRA_FILES.includes("tvbox-sysupdate.service"));
  // Long enough for provision (the default 90 s would SIGTERM it mid-apt) and
  // still finite: a run that never ends holds the lock, and every later request
  // is then refused in silence until someone reboots the box. RuntimeMaxSec
  // cannot stand in for this - systemd ignores it for Type=oneshot.
  const timeout = /^TimeoutStartSec=(\d+)$/m.exec(unit);
  assert.ok(timeout, "no finite TimeoutStartSec");
  assert.ok(Number(timeout[1]) >= 3600, "too short for a provision run");
  assert.doesNotMatch(unit, /^RuntimeMaxSec=/m);
  // and whatever ends the run has to leave a terminal status behind
  assert.match(unit, /^ExecStopPost=/m);
});

test("the applier ships in every channel, and is installed executable", () => {
  const list = fs.readFileSync(path.join(__dirname, "..", "deploy", "infra.list"), "utf8");
  for (const f of [
    "tvbox-sysupdate",
    "tvbox-sysupdate.service",
    "54-tvbox-sysupdate.rules",
    "sysupdate.conf",
    "release-key.pem",
  ]) {
    assert.ok(list.includes("deploy/" + f), f + " is not in infra.list");
    assert.ok(updater.INFRA_FILES.includes(f), f + " is not in INFRA_FILES");
  }
  // systemd exec's it out of /usr/local/sbin, and provision installs it from the
  // copy an OTA left in ~/.tvbox - which arrives without its mode bit.
  assert.ok(updater.EXECUTABLE.includes("tvbox-sysupdate"));
});
