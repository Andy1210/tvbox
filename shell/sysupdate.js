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
// The three root-owned prefixes, overridable only so the tests can answer
// "installed" and "not installed" without depending on what the machine running
// them happens to have in /usr/local. Not a boundary: see TVBOX_STATE_DIR below.
const SBIN = process.env.TVBOX_SBIN_DIR || "/usr/local/sbin";
const ETC = process.env.TVBOX_ETC_DIR || "/etc";
const HELPER = path.join(SBIN, "tvbox-sysupdate");
const UNIT_FILE = path.join(ETC, "systemd/system", UNIT);
const RULE_FILE = path.join(ETC, "polkit-1/rules.d/54-tvbox-sysupdate.rules");
const KEYS_DIR = process.env.TVBOX_KEYS_DIR || path.join(ETC, "tvbox/release-keys.d");
// /run is a tmpfs, so this exists only while a run is going IN THIS BOOT. A box
// that lost power mid-provision comes back with a durable status still saying
// "running" and no marker, and that difference is the only way to tell a live
// run from an interrupted one.
const RUNNING_FILE = process.env.TVBOX_RUN_DIR
  ? path.join(process.env.TVBOX_RUN_DIR, "sysupdate-running")
  : "/run/tvbox/sysupdate-running";
// How long a start may take to produce its first status line before the screen
// stops waiting on it. `systemctl start --no-block` reports success as soon as
// the job is QUEUED, so a unit that then fails to activate - or one whose run is
// blocked behind another holding the lock - would otherwise leave the page
// waiting for ever, with every button on it disabled.
const START_GRACE_MS = 2 * 60 * 1000;
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

// Can this box run a system update at all? Every box already in the field is
// running a shell that predates the applier, so the answer decides whether
// Settings offers a button or the older "this box has to be set up again"
// sentence. Cheap enough to ask per call - a few stats, and the answer changes
// once in a box's life.
//
// Every piece a press needs, not just the script: each of these is separately
// absent on a real box, and each absence is a button that can only fail.
//   - the polkit rule, or the box user cannot start the unit at all;
//   - a pinned key, because provision installs the applier whatever happens but
//     refuses to pin a key out of a directory the box user can write, so
//     "installed" and "able to verify anything" are different states.
// Where any of them is missing the honest older sentence - this box has to be set
// up again - is the better answer, and it is what the UI falls back to.
function available() {
  try {
    for (const f of [HELPER, UNIT_FILE, RULE_FILE]) if (!fs.statSync(f).isFile()) return false;
    return fs.readdirSync(KEYS_DIR).some((n) => n.endsWith(".pem"));
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
  "interrupted",
  "available",
  "up-to-date",
  "ok",
  "ok-warnings",
  "timeout",
  "busy",
  "cooldown",
  "unsigned-feed",
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

// Which outcome a status document describes. Pure, and exported, because the
// combinations that matter are the ones a test cannot easily reach through a real
// systemctl: a request whose run has not written anything yet, one that never
// will, and a document left behind by a run that was cut off.
function resolveCode(doc, { requestedAt = 0, now = Date.now(), running = false, denied = false } = {}) {
  if (denied) return "start-denied";
  // A status document from before this session's request describes the PREVIOUS
  // run, so reporting it would turn a press into an instant "done" - but only for
  // a couple of minutes, because a start that never produces one at all must not
  // leave the screen waiting with its buttons disabled.
  const fresh = doc && Number(doc.startedAt) >= requestedAt;
  if (requestedAt && !fresh) return now - requestedAt < START_GRACE_MS ? "starting" : "internal";
  if (!doc) return "idle";
  const code = CODES.includes(doc.code) ? doc.code : "internal";
  // A run that says it is going, in a boot with no marker for it, was cut off - a
  // power loss mid-provision, most likely. Left as "running" this would disable
  // the whole update screen for the life of the box, OTA included.
  if (code === "running" && !running) return "interrupted";
  return code;
}

function status() {
  const doc = readStatus();
  const code = resolveCode(doc, {
    requestedAt,
    running: fs.existsSync(RUNNING_FILE),
    denied: !!startError,
  });
  const base = {
    available: available(),
    revision: appliedRevision(),
    code,
    warnings: 0,
    rebootRequired: false,
    at: null,
  };
  // Only a document this run actually produced may contribute detail; the rest
  // are decided above and carry none.
  if (!doc || code === "starting" || code === "start-denied") {
    return { ...base, at: requestedAt || null };
  }
  return {
    ...base,
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
  resolveCode,
  apply,
  CODES,
  UNIT,
  HELPER,
  UNIT_FILE,
  RULE_FILE,
  KEYS_DIR,
  STATE_DIR,
  REVISION_FILE,
  STATUS_FILE,
  RUNNING_FILE,
  START_GRACE_MS,
};
