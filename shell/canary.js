// Staged OTA across several boxes on one broker.
//
// Opt-in, per box (config `update.canary.role`):
//   "canary"   installs a release as usual, and once it has run for SOAK_MS on
//              the new version it vouches for it on tvbox/<id>/canary (retained).
//              A rollback is published there too.
//   "follower" holds its nightly auto-update until the canary it follows
//              (`update.canary.from`, a box id) vouches for that exact version, or
//              until maxWaitHours have passed since it first saw a release it had
//              not installed, so a fleet whose canary is gone never stops
//              updating. A version that canary rolled back is held for the same
//              maximum wait; a person can install it at any time.
//   anything else: neither (the default).
//
// Only the box the follower names counts: the topic is writable by anything that
// holds the broker's credentials, and a rollback from any box would otherwise hold
// every follower back. Even that box only changes WHEN a follower installs. What it
// installs is still the signed feed's release, so a forged vouch can bring an
// update forward but not choose it, and a forged rollback delays it by the maximum
// wait at most.
//
// Pure decisions only; updater.js keeps the wait record and mqtt.js the topic.

const SOAK_MS = 60 * 60 * 1000;
const DEFAULT_MAX_WAIT_HOURS = 48;
const MAX_WAIT_HOURS_LIMIT = 24 * 14;
const ROLES = new Set(["canary", "follower"]);

/** The stored config section, normalised. */
function settings(raw) {
  const c = (raw && typeof raw === "object" && raw) || {};
  const role = ROLES.has(c.role) ? c.role : "off";
  const h = Number(c.maxWaitHours);
  const maxWaitHours = Number.isInteger(h) && h >= 1 && h <= MAX_WAIT_HOURS_LIMIT ? h : DEFAULT_MAX_WAIT_HOURS;
  const from = typeof c.from === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(c.from) ? c.from : "";
  return { role, maxWaitHours, from };
}

/**
 * What a canary publishes. Null means "clear the topic": a box that is not a
 * canary (any more) must not keep vouching from a retained message.
 *
 * @param s.role, s.version       this box's role and running version
 * @param s.committed             the release passed its first launcher load
 * @param s.runningMs             how long this shell has been up
 * @param s.failed                updater's rollback marker ({prev,next}) or null
 */
function report(s) {
  if (!s || s.role !== "canary" || !s.version) return null;
  return {
    version: s.version,
    healthy: !!s.committed && s.runningMs >= SOAK_MS,
    failed: s.failed && s.failed.next ? s.failed.next : null,
    at: new Date(s.now || Date.now()).toISOString(),
  };
}

/** A payload read off another box's topic, or null when it says nothing usable. */
function parseVouch(p) {
  if (!p || typeof p !== "object") return null;
  const version = typeof p.version === "string" && p.version.length <= 40 ? p.version : null;
  const failed = typeof p.failed === "string" && p.failed.length <= 40 ? p.failed : null;
  if (!version && !failed) return null;
  return { version, healthy: p.healthy === true, failed };
}

/**
 * May a follower install `version` now?
 *
 * @param d.vouches   Map<boxId, parseVouch()> of the other boxes' canary topics
 * @param d.from      the box id this follower follows ("" for none)
 * @param d.version   the release on offer
 * @param d.waitSince when this box first saw a release it has not installed (ms)
 * @param d.now
 * @param d.maxWaitHours
 * @returns {{go: boolean, reason: string, until: number|null}}
 */
function followerDecision(d) {
  const v = d.from && d.vouches ? d.vouches.get(d.from) : null;
  const until = (d.waitSince || d.now) + d.maxWaitHours * 3600 * 1000;
  const late = d.now >= until;
  if (v && v.failed === d.version)
    return late ? { go: true, reason: "max-wait", until } : { go: false, reason: "canary-rolled-back", until };
  if (v && v.version === d.version && v.healthy) return { go: true, reason: "vouched", until: null };
  if (late) return { go: true, reason: "max-wait", until };
  return { go: false, reason: "waiting", until };
}

module.exports = {
  settings,
  report,
  parseVouch,
  followerDecision,
  SOAK_MS,
  DEFAULT_MAX_WAIT_HOURS,
  MAX_WAIT_HOURS_LIMIT,
};
