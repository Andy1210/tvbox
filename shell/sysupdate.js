// The shell's half of a system update - which is deliberately almost nothing.
//
// An OTA release is user-space (hard rule #1), so a version that needs an apt
// package, a udev/polkit grant or a root unit cannot install itself. The root
// half that can is `tvbox-sysupdate`, installed by provision.sh and started
// through one polkit-granted unit.
//
// This module asks for it and reads the answer. It passes NOTHING: no version,
// no URL, no arguments. The applier reads its own root-owned config, fetches a
// signed feed and verifies it against a key pinned in /etc, so nothing the box
// user can write - this process included - decides what root ends up running.
// Everything here is therefore a status reader plus one `systemctl start`.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const UNIT = "tvbox-sysupdate.service";
const HELPER = "/usr/local/sbin/tvbox-sysupdate";
const UNIT_FILE = "/etc/systemd/system/" + UNIT;
// TVBOX_STATE_DIR is for the test suite. It is not a boundary and does not need
// to be: everything under here is READ, and the root half never trusts a word of
// what this process says - it re-reads its own root-owned config and verifies the
// release itself. Pointing this elsewhere only lets the shell lie to itself,
// which anything already running as the box user could do by editing this file.
const STATE_DIR = process.env.TVBOX_STATE_DIR || "/var/lib/tvbox";
const REVISION_FILE = path.join(STATE_DIR, "system-revision");
const STATUS_FILE = path.join(STATE_DIR, "sysupdate-status.json");

// systemctl returns as soon as the job is queued (--no-block, because provision
// spends minutes in apt). Between the press and the applier's first write there
// is nothing on disk to see, so the request is remembered here and anything
// older than it is the PREVIOUS run's result.
let requestedAt = 0;
let startError = null;

// Is the root half there at all? Every box already in the field is running a
// shell that predates it, so the answer decides whether Settings offers a button
// or the older "this box has to be set up again" sentence. Cheap enough to ask
// per call - it is two stats, and the answer changes once in a box's life.
function available() {
  try {
    return fs.statSync(HELPER).isFile() && fs.statSync(UNIT_FILE).isFile();
  } catch (e) {
    return false;
  }
}

// The highest revision this box has ever applied. Absent, unreadable or
// unparsable is 0 - "needs the step" - because claiming a revision the box has
// not got is the one answer that silently skips the work for ever.
//
// Read per call, never cached: the applier writes it while this process keeps
// running, and the box deliberately does not reboot afterwards.
function appliedRevision() {
  try {
    const m = /^\s*(\d{1,6})\s*$/.exec(fs.readFileSync(REVISION_FILE, "utf8"));
    return m ? Number(m[1]) : 0;
  } catch (e) {
    return 0;
  }
}

function readStatus() {
  try {
    const doc = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    return doc && typeof doc === "object" ? doc : null;
  } catch (e) {
    return null;
  }
}

// The launcher renders this, so only closed-set codes cross over - never a
// string from the feed. The main window runs with contextIsolation:false.
const CODES = [
  "idle",
  "starting",
  "running",
  "available",
  "up-to-date",
  "ok",
  "ok-warnings",
  "timeout",
  "busy",
  "no-space",
  "no-keys",
  "no-openssl",
  "bad-config",
  "bad-feed",
  "bad-signature",
  "bad-checksum",
  "bad-tarball",
  "stale-feed",
  "rollback-refused",
  "revision-mismatch",
  "feed-unreachable",
  "download-failed",
  "provision-failed",
  "insecure-install",
  "internal",
  "start-denied",
];

function status() {
  const doc = readStatus();
  const revision = appliedRevision();
  const base = { available: available(), revision, code: "idle", warnings: 0, rebootRequired: false, at: null };
  if (startError) return { ...base, code: "start-denied" };
  // A status document from before this session's request describes the previous
  // run. Reporting it would turn a press into an instant "done".
  const fresh = doc && Number(doc.startedAt) >= requestedAt;
  if (requestedAt && !fresh) return { ...base, code: "starting", at: requestedAt };
  if (!doc) return base;
  const code = CODES.includes(doc.code) ? doc.code : "internal";
  return {
    ...base,
    code,
    warnings: Number(doc.warnings) || 0,
    rebootRequired: !!doc.rebootRequired,
    at: Number(doc.finishedAt) || Number(doc.startedAt) || null,
  };
}

// Ask for a system update. `--no-block` because the unit is a oneshot that runs
// for minutes: waiting for it would hold this request open long past any client
// timeout, and the UI polls status() anyway.
function apply(cb) {
  if (!available()) return cb && cb(new Error("not installed"));
  requestedAt = Date.now();
  startError = null;
  // --no-ask-password: without it systemctl asks polkit for an agent and waits.
  // The shell has no logind session and no tty, so that wait has no end - it is
  // how Settings -> Reboot once froze the whole process group.
  execFile("systemctl", ["start", "--no-block", "--no-ask-password", UNIT], { timeout: 30000 }, (err, _out, errOut) => {
    if (err) {
      // The likely cause is the polkit grant not reaching this process - a box
      // whose user was only just added to netdev needs a reboot first. Keep the
      // reason out of the UI (it is systemd's English) but let it fail visibly
      // rather than leaving the screen waiting for a run that never started.
      startError = String(errOut || err.message || err).slice(0, 200);
      console.warn("[sysupdate] could not start", UNIT + ":", startError);
    }
    if (cb) cb(err || null);
  });
}

module.exports = {
  available,
  appliedRevision,
  status,
  apply,
  CODES,
  UNIT,
  HELPER,
  STATE_DIR,
  REVISION_FILE,
  STATUS_FILE,
};
