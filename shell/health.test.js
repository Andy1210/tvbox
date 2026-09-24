// The box's own health report (shell/health.js).
const test = require("node:test");
const assert = require("node:assert");
const health = require("./health");

function setup(over) {
  health._test.resetForTest();
  let now = 1_000_000_000_000;
  const clock = { now: () => now, advance: (ms) => (now += ms) };
  health.init({
    now: clock.now,
    uptimeMs: () => 60 * 1000,
    stat: (_p, cb) => setImmediate(cb),
    markers: () => ({ release: "1.0.0", pending: null, failed: null, synced: "1.0.0" }),
    boot: () => ({ reachedLauncher: true }),
    oldestInstallStart: () => null,
    nowPlaying: () => null,
    lastCrashAt: () => null,
    ...(over || {}),
  });
  return clock;
}

const collect = () => new Promise((r) => health.collect(r));

test("a quiet box reports ok with no issues", async () => {
  setup();
  const r = await collect();
  assert.strictEqual(r.status, "ok");
  assert.deepStrictEqual(r.issues, []);
  assert.strictEqual(r.pool.saturated, false);
  assert.strictEqual(r.update.release, "1.0.0");
});

test("a threadpool that never answers is reported saturated, not waited on", { timeout: 5000 }, async () => {
  setup({ stat: () => {} });
  const t0 = Date.now();
  const r = await collect();
  assert.ok(Date.now() - t0 < health.POOL_WAIT_MS + 500);
  assert.strictEqual(r.pool.saturated, true);
  assert.ok(r.issues.includes("threadpool"));
  assert.strictEqual(r.status, "warn");
});

test("concurrent reports share one probe", async () => {
  let stats = 0;
  setup({
    stat: (_p, cb) => {
      stats++;
      setTimeout(cb, 20);
    },
  });
  await Promise.all([collect(), collect(), collect()]);
  assert.strictEqual(stats, 1);
});

test("an install older than the stuck limit is an issue, a fresh one is not", async () => {
  const clock = setup();
  health.init({ oldestInstallStart: () => clock.now() - 5 * 60 * 1000 });
  let r = await collect();
  assert.ok(!r.issues.includes("install-stuck"));
  assert.strictEqual(r.installAgeSec, 300);
  health.init({ oldestInstallStart: () => clock.now() - health.INSTALL_STUCK_MS - 1000 });
  r = await collect();
  assert.ok(r.issues.includes("install-stuck"));
});

test("OTA markers: a rollback, a stale pending marker and a lagging infra sync are issues", async () => {
  setup({
    markers: () => ({
      release: "1.0.0",
      pending: { prev: "0.9", next: "1.0.0" },
      failed: { prev: "1.0.0", next: "1.1.0" },
      syncBehind: true,
    }),
  });
  const r = await collect();
  assert.ok(r.issues.includes("update-pending"));
  assert.ok(r.issues.includes("rolled-back"));
  assert.ok(r.issues.includes("infra-sync"));
  assert.strictEqual(r.update.failed, "1.1.0");
});

test("a pending marker before the launcher loaded is the normal first boot of a release", async () => {
  setup({
    markers: () => ({ pending: { prev: "0.9", next: "1.0.0" } }),
    boot: () => ({ reachedLauncher: false }),
  });
  const r = await collect();
  assert.ok(!r.issues.includes("update-pending"));
  assert.ok(!r.issues.includes("launcher-not-loaded")); // uptime is one minute
});

test("a boot that never reached the launcher is an issue after the grace period", async () => {
  setup({ boot: () => ({ reachedLauncher: false }), uptimeMs: () => 10 * 60 * 1000 });
  const r = await collect();
  assert.ok(r.issues.includes("launcher-not-loaded"));
});

test("a crash within a day is reported, an old one only by date", async () => {
  const clock = setup();
  health.init({ lastCrashAt: () => clock.now() - 60 * 1000 });
  let r = await collect();
  assert.ok(r.issues.includes("recent-crash"));
  health.init({ lastCrashAt: () => clock.now() - 3 * 24 * 3600 * 1000 });
  r = await collect();
  assert.ok(!r.issues.includes("recent-crash"));
  assert.ok(r.lastCrashAt);
});

test("the now-playing claim carries its age", async () => {
  const clock = setup();
  health.init({ nowPlaying: () => ({ state: "playing", app: "music", at: clock.now() - 90 * 1000, title: "x" }) });
  const r = await collect();
  assert.deepStrictEqual(r.nowPlaying, { state: "playing", app: "music", ageSec: 90 });
});

test("a reader that throws does not take the report down", async () => {
  setup({
    markers: () => {
      throw new Error("boom");
    },
  });
  const r = await collect();
  assert.strictEqual(r.status, "ok");
});
