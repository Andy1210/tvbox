// Staged rollout decisions (shell/canary.js).
const test = require("node:test");
const assert = require("node:assert");
const canary = require("./canary");

const H = 3600 * 1000;

test("settings: unknown roles are off, the wait is bounded", () => {
  assert.deepStrictEqual(canary.settings(null), { role: "off", maxWaitHours: canary.DEFAULT_MAX_WAIT_HOURS, from: "" });
  assert.strictEqual(canary.settings({ from: "box-a" }).from, "box-a");
  assert.strictEqual(canary.settings({ from: "a/#" }).from, "", "only a topic segment");
  assert.strictEqual(canary.settings({ role: "leader" }).role, "off");
  assert.strictEqual(canary.settings({ role: "follower", maxWaitHours: 12 }).maxWaitHours, 12);
  assert.strictEqual(canary.settings({ maxWaitHours: 0 }).maxWaitHours, canary.DEFAULT_MAX_WAIT_HOURS);
  assert.strictEqual(canary.settings({ maxWaitHours: 99999 }).maxWaitHours, canary.DEFAULT_MAX_WAIT_HOURS);
  assert.strictEqual(canary.settings({ maxWaitHours: 1.5 }).maxWaitHours, canary.DEFAULT_MAX_WAIT_HOURS);
});

test("report: only a canary publishes, and it vouches only after the soak", () => {
  assert.strictEqual(canary.report({ role: "follower", version: "2.0.0" }), null);
  assert.strictEqual(canary.report({ role: "canary", version: null }), null);
  const young = canary.report({ role: "canary", version: "2.0.0", committed: true, runningMs: 60 * 1000 });
  assert.strictEqual(young.healthy, false);
  const soaked = canary.report({ role: "canary", version: "2.0.0", committed: true, runningMs: canary.SOAK_MS });
  assert.strictEqual(soaked.healthy, true);
  const uncommitted = canary.report({ role: "canary", version: "2.0.0", committed: false, runningMs: 10 * H });
  assert.strictEqual(uncommitted.healthy, false);
});

test("report: a rollback is published with the release that failed", () => {
  const r = canary.report({
    role: "canary",
    version: "1.9.0",
    committed: true,
    runningMs: 10 * H,
    failed: { prev: "1.9.0", next: "2.0.0" },
  });
  assert.strictEqual(r.failed, "2.0.0");
});

test("parseVouch: an empty (cleared) topic says nothing", () => {
  assert.strictEqual(canary.parseVouch({}), null);
  assert.strictEqual(canary.parseVouch(null), null);
  assert.deepStrictEqual(canary.parseVouch({ version: "2.0.0", healthy: true }), {
    version: "2.0.0",
    healthy: true,
    failed: null,
  });
  assert.strictEqual(canary.parseVouch({ version: "x".repeat(100) }), null);
  // "true" as a string is not a vouch
  assert.strictEqual(canary.parseVouch({ version: "2.0.0", healthy: "true" }).healthy, false);
});

test("follower: waits, goes on a vouch from the box it follows, and falls back after the max wait", () => {
  const now = 1_000_000 * H;
  const base = { version: "2.0.0", waitSince: now, now, maxWaitHours: 48, from: "a" };
  assert.deepStrictEqual(canary.followerDecision({ ...base, vouches: new Map() }).reason, "waiting");
  const other = new Map([["a", { version: "1.9.0", healthy: true, failed: null }]]);
  assert.strictEqual(canary.followerDecision({ ...base, vouches: other }).go, false);
  const unsoaked = new Map([["a", { version: "2.0.0", healthy: false, failed: null }]]);
  assert.strictEqual(canary.followerDecision({ ...base, vouches: unsoaked }).go, false);
  const ok = new Map([["a", { version: "2.0.0", healthy: true, failed: null }]]);
  assert.deepStrictEqual(canary.followerDecision({ ...base, vouches: ok }), {
    go: true,
    reason: "vouched",
    until: null,
  });
  const late = canary.followerDecision({ ...base, now: now + 48 * H, vouches: new Map() });
  assert.strictEqual(late.go, true);
  assert.strictEqual(late.reason, "max-wait");
});

test("follower: only the box it follows counts, for a vouch or a rollback", () => {
  const now = 1_000_000 * H;
  const base = { version: "2.0.0", waitSince: now, now, maxWaitHours: 48 };
  const stranger = new Map([["x", { version: "2.0.0", healthy: true, failed: "2.0.0" }]]);
  assert.strictEqual(canary.followerDecision({ ...base, from: "a", vouches: stranger }).reason, "waiting");
  assert.strictEqual(canary.followerDecision({ ...base, from: "", vouches: stranger }).reason, "waiting");
});

test("follower: a release its canary rolled back is held, but no longer than the max wait", () => {
  const now = 1_000_000 * H;
  const vouches = new Map([["a", { version: "1.9.0", healthy: true, failed: "2.0.0" }]]);
  const base = { vouches, from: "a", version: "2.0.0", maxWaitHours: 48, now };
  const held = canary.followerDecision({ ...base, waitSince: now - 10 * H });
  assert.strictEqual(held.go, false);
  assert.strictEqual(held.reason, "canary-rolled-back");
  const late = canary.followerDecision({ ...base, waitSince: now - 100 * H });
  assert.strictEqual(late.go, true);
  assert.strictEqual(late.reason, "max-wait");
});
