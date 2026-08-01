const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The desired-state file lives under $HOME, so isolate it before requiring the
// module (STATE_FILE is computed from os.homedir() at import, and os.homedir()
// honours $HOME on POSIX).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-reconcile-test-"));
process.env.HOME = TMP;
const reconcile = require("./reconcile");

// The planner is the part that decides what a restored box owes. Pure, so these
// run without a home directory, a registry or a flatpak.

test("plans nothing for a box that is already whole", () => {
  const steps = reconcile.planSteps([
    { id: "plex", present: true, depsMissing: false, depsInstallable: false, bundleMissing: false },
  ]);
  assert.deepEqual(steps, []);
});

test("an absent app is acquired first, before anything can be known about it", () => {
  const steps = reconcile.planSteps([
    { id: "retroarch", present: false, depsMissing: false, depsInstallable: false, bundleMissing: false },
  ]);
  assert.deepEqual(
    steps.map((s) => [s.id, s.kind]),
    [["retroarch", "app"]],
  );
});

test("deps come before the bundle for one app", () => {
  const steps = reconcile.planSteps([
    { id: "plex", present: true, depsMissing: true, depsInstallable: true, bundleMissing: true },
  ]);
  assert.deepEqual(
    steps.map((s) => s.kind),
    ["deps", "bundle"],
  );
});

test("every app is acquired before any of them is provisioned", () => {
  const steps = reconcile.planSteps([
    { id: "a", present: false },
    { id: "b", present: true, depsMissing: true, depsInstallable: true, bundleMissing: false },
  ]);
  assert.deepEqual(
    steps.map((s) => [s.id, s.kind]),
    [
      ["a", "app"],
      ["b", "deps"],
    ],
  );
});

// Reconciliation is rootless like everything else the shell does: an apt-only dep
// has no no-root path, so planning it would only produce a step that always fails.
test("an apt-only dep is not planned", () => {
  const steps = reconcile.planSteps([
    { id: "x", present: true, depsMissing: true, depsInstallable: false, bundleMissing: false },
  ]);
  assert.deepEqual(steps, []);
});

test("junk entries are dropped rather than planned", () => {
  assert.deepEqual(reconcile.planSteps([null, {}, { present: false }]), []);
  assert.deepEqual(reconcile.planSteps(null), []);
});

// describe() is the bridge between install.js and the planner - the one place
// that decides what "this app is fine" means.
test("describe reads presence, deps and bundle off the live manifests", () => {
  const fake = {
    manifestById: (id) => (id === "plex" ? { id: "plex", name: "Plex" } : null),
    appDeps: () => ({ depsOk: false, installable: true, missing: ["mpv"] }),
    bundleMissing: () => true,
  };
  assert.deepEqual(reconcile.describe("plex", fake), {
    id: "plex",
    name: "Plex",
    present: true,
    depsMissing: true,
    depsInstallable: true,
    bundleMissing: true,
  });
  assert.deepEqual(reconcile.describe("gone", fake), {
    id: "gone",
    present: false,
    depsMissing: false,
    depsInstallable: false,
    bundleMissing: false,
  });
});

// The run itself: two passes, an app that arrives in pass 1 must be provisioned
// in pass 2 (nothing about its deps could be known before it existed).
test("a freshly installed app is provisioned in the same run", async () => {
  const installed = new Set();
  const calls = [];
  const fake = {
    manifestById: (id) => (installed.has(id) ? { id, name: id } : null),
    appDeps: () => ({ depsOk: false, installable: true, missing: ["retroarch"] }),
    bundleMissing: () => false,
    loadManifests: () => [],
  };
  const s = await reconcile.run(
    { reason: "restore", apps: [{ id: "retroarch" }] },
    {
      apps: fake,
      installApp: (id) => {
        calls.push("app:" + id);
        installed.add(id);
        return { ok: true };
      },
      installDeps: (id) => {
        calls.push("deps:" + id);
        return true;
      },
      installBundle: (id) => {
        calls.push("bundle:" + id);
        return true;
      },
    },
  );
  assert.deepEqual(calls, ["app:retroarch", "deps:retroarch"]);
  assert.equal(s.active, false);
  assert.equal(s.total, 2);
  assert.equal(s.done, 2);
  assert.deepEqual(s.failed, []);
});

test("one failing app does not stop the others", async () => {
  const fake = {
    manifestById: (id) => ({ id, name: id }),
    appDeps: () => ({ depsOk: true, installable: false, missing: [] }),
    bundleMissing: () => true,
    loadManifests: () => [],
  };
  const s = await reconcile.run(
    { reason: "restore", apps: [{ id: "a" }, { id: "b" }] },
    {
      apps: fake,
      installApp: () => ({ ok: true }),
      installDeps: () => true,
      installBundle: (id) => id !== "a",
    },
  );
  assert.equal(s.total, 2);
  assert.deepEqual(
    s.failed.map((f) => f.id),
    ["a"],
  );
  assert.equal(s.steps.find((x) => x.id === "b").state, "done");
});

// A wake-up (someone starts watching something) must stop the run mid-way rather
// than keep saturating the link behind a video.
// ---- the retry budget ----
//
// The distinction settle() draws is the whole point: a run that FAILED (registry
// down) has a bounded number of retries, while a run that was merely INTERRUPTED
// (the user launched something on the box) must come back for free. Getting that
// wrong means three interruptions in one evening throw the desired state away and
// the box silently never gets its apps back.
const OK_IO = (fail) => ({
  apps: {
    manifestById: (id) => ({ id, name: id }),
    appDeps: () => ({ depsOk: true, installable: false, missing: [] }),
    bundleMissing: () => true,
    loadManifests: () => [],
  },
  installApp: () => ({ ok: true }),
  installDeps: () => true,
  installBundle: () => !fail,
});

test("a clean run clears the desired state", async () => {
  const desired = reconcile.record([{ id: "a" }], "restore");
  await reconcile.run(desired, OK_IO(false));
  assert.equal(reconcile.settle(desired), false);
  assert.equal(reconcile.pending(), null);
});

test("a failed run spends one attempt and keeps the state", async () => {
  const desired = reconcile.record([{ id: "a" }], "restore");
  await reconcile.run(desired, OK_IO(true));
  assert.equal(reconcile.settle(desired), true, "should retry");
  assert.equal(reconcile.pending().attempts, 1);
});

test("a failed run stops asking after MAX_ATTEMPTS", async () => {
  reconcile.record([{ id: "a" }], "restore");
  let desired = reconcile.pending();
  for (let i = 1; i < reconcile.MAX_ATTEMPTS; i++) {
    await reconcile.run(desired, OK_IO(true));
    assert.equal(reconcile.settle(desired), true, "attempt " + i + " should retry");
    desired = reconcile.pending();
    assert.equal(desired.attempts, i);
  }
  await reconcile.run(desired, OK_IO(true));
  assert.equal(reconcile.settle(desired), false, "out of budget");
  assert.equal(reconcile.pending(), null);
});

test("an INTERRUPTED run retries for free - forever, if it keeps being interrupted", async () => {
  const desired = reconcile.record([{ id: "a" }], "restore");
  for (let i = 0; i < reconcile.MAX_ATTEMPTS + 3; i++) {
    await reconcile.run(desired, { ...OK_IO(false), free: () => false });
    assert.equal(reconcile.settle(desired), true, "round " + i + " should still retry");
    assert.equal(reconcile.pending().attempts, 0, "an interruption must not spend the budget");
  }
  reconcile.clear();
});

test("a box that stops being free skips the rest", async () => {
  let free = true;
  const fake = {
    manifestById: (id) => ({ id, name: id }),
    appDeps: () => ({ depsOk: true, installable: false, missing: [] }),
    bundleMissing: () => true,
    loadManifests: () => [],
  };
  const s = await reconcile.run(
    { reason: "restore", apps: [{ id: "a" }, { id: "b" }] },
    {
      apps: fake,
      free: () => free,
      installApp: () => ({ ok: true }),
      installDeps: () => true,
      installBundle: () => {
        free = false;
        return true;
      },
    },
  );
  assert.equal(s.steps.find((x) => x.id === "a").state, "done");
  assert.equal(s.steps.find((x) => x.id === "b").state, "skipped");
});
