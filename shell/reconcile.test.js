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

// ---- an app that is not published any more ----
//
// A backup names what the box HAD, and an app can be retired from the registry in
// between. Asking again gets the same answer every time, so the retry budget is
// spent on a settled question - and until it runs out, every boot puts the restore
// banner back on the television reporting an app that could not be downloaded.
//
// The one thing that must not be confused with it is a registry that could not be
// READ: it looks identical from here and means the opposite, which is why only the
// store's own `reason` decides.
const RETIRED_IO = (reason, absent) => ({
  apps: {
    // The app never arrives, so it is absent in pass 2 as well and owes no deps.
    manifestById: (id) => (id === absent ? null : { id, name: id }),
    appDeps: () => ({ depsOk: true, installable: false, missing: [] }),
    bundleMissing: () => false,
    loadManifests: () => [],
  },
  installApp: (id) => (id === absent ? { ok: false, reason, error: "not in registry" } : { ok: true }),
  installDeps: () => true,
  installBundle: () => true,
});

test("an app no registry carries any more is reported apart from the failures", async () => {
  const s = await reconcile.run({ reason: "restore", apps: [{ id: "plex" }] }, RETIRED_IO("unlisted", "plex"));
  assert.equal(s.steps.find((x) => x.id === "plex").state, "gone");
  assert.deepEqual(s.failed, []);
  // Ids: an app that never arrived has no name anywhere on the box, and the
  // registries that would have one no longer offer it.
  assert.deepEqual(s.gone, ["plex"]);
  // It is settled, so the progress bar is full rather than stuck one short.
  assert.equal(s.done, s.total);
});

test("a retired app leaves the desired state without spending the retry budget", async () => {
  const desired = reconcile.record([{ id: "plex" }, { id: "keeper" }], "restore");
  const io = RETIRED_IO("unlisted", "plex");
  const s = await reconcile.run(desired, {
    ...io,
    installBundle: () => false,
    apps: { ...io.apps, bundleMissing: (m) => m.id === "keeper" },
  });
  assert.equal(s.steps.find((x) => x.id === "plex").state, "gone");
  assert.equal(
    s.steps.find((x) => x.id === "keeper" && x.kind === "bundle").state,
    "failed",
    "the other app really did fail",
  );
  assert.equal(reconcile.settle(desired), true, "the failure is still worth a retry");
  const left = reconcile.pending();
  assert.deepEqual(
    left.apps.map((a) => a.id),
    ["keeper"],
    "the retired app is not asked for again",
  );
  assert.equal(left.attempts, 1, "the failure spent one attempt, the retirement none");
  reconcile.clear();
});

test("a retirement found on one pass is still named on the pass that reports", async () => {
  // The case the whole `gone` list exists for, and the one it used to miss. A run
  // that retires one app and fails on another keeps the desired state for the
  // retry, and the launcher stays on its "still working" label while it does - so
  // the summary naming the retired app is only drawn on the LAST pass. By then
  // settle() had taken the id out of the wanted list and the next run planned no
  // step for it, so the banner said nothing about it to anyone.
  const desired = reconcile.record([{ id: "plex" }, { id: "keeper" }], "restore");
  const io = RETIRED_IO("unlisted", "plex");
  const failing = {
    ...io,
    apps: { ...io.apps, bundleMissing: (m) => m.id === "keeper" },
    installBundle: () => false,
  };
  await reconcile.run(desired, failing);
  assert.equal(reconcile.settle(desired), true);

  // The next boot: only `keeper` is wanted, and this time its bundle lands.
  const next = reconcile.pending();
  assert.deepEqual(
    next.apps.map((a) => a.id),
    ["keeper"],
    "the retired app is not asked for again",
  );
  const s = await reconcile.run(next, { ...io, apps: { ...io.apps, bundleMissing: () => false } });
  assert.deepEqual(s.gone, ["plex"], "still named on the pass the person actually sees");
  assert.deepEqual(s.failed, []);
  // Counted as APPS: the restore was about two, one of them is retired, so one
  // came back - which is the sentence the banner draws from these numbers. The
  // step total is separately zero here, because `keeper` was whole by then and
  // owed nothing; counting steps would have said "nothing to bring back".
  assert.equal(s.wanted, 2);
  assert.equal(s.wanted - s.gone.length, 1);
  assert.equal(s.total, 0, "no step was owed on this pass");
  assert.equal(reconcile.settle(next), false, "nothing left to come back for");
  assert.equal(reconcile.pending(), null);
});

test("a second retirement joins the first rather than replacing it", async () => {
  // Two passes with one retirement each. The two-app case cannot tell
  // "accumulate" from "this pass only" apart - both give one id - so the rule the
  // carry-forward exists for is only pinned by a third app arriving late.
  const desired = reconcile.record([{ id: "plex" }, { id: "jellyfin" }, { id: "keeper" }], "restore");
  const gone = new Set(["plex"]);
  const io = {
    apps: {
      manifestById: (id) => (gone.has(id) ? null : { id, name: id }),
      appDeps: () => ({ depsOk: true, installable: false, missing: [] }),
      bundleMissing: (m) => m.id === "keeper",
      loadManifests: () => [],
    },
    installApp: (id) => (gone.has(id) ? { ok: false, reason: "unlisted", error: "not in registry" } : { ok: true }),
    installDeps: () => true,
    installBundle: () => false, // keeper keeps the restore alive for a second pass
  };
  await reconcile.run(desired, io);
  assert.equal(reconcile.settle(desired), true);

  gone.add("jellyfin"); // retired between the two boots
  const second = reconcile.pending();
  await reconcile.run(second, io);
  const s = reconcile.state();
  assert.deepEqual(s.gone, ["plex", "jellyfin"], "the first retirement is still named");
  assert.equal(reconcile.settle(second), true);
  assert.deepEqual(reconcile.pending().retired, ["plex", "jellyfin"]);
  reconcile.clear();
});

test("an INTERRUPTED pass keeps the retirements it found", async () => {
  // The branch a box takes when somebody starts watching something mid-restore,
  // which on a just-restored box is the commonest reason there is a second pass
  // at all. It spends no attempt, and it must not spend the record either.
  const desired = reconcile.record([{ id: "plex" }, { id: "later" }], "restore");
  let free = true;
  await reconcile.run(desired, {
    apps: {
      manifestById: (id) => (id === "plex" ? null : { id, name: id }),
      appDeps: () => ({ depsOk: true, installable: false, missing: [] }),
      bundleMissing: (m) => m.id === "later", // so `later` owes a step to stand down on
      loadManifests: () => [],
    },
    installApp: (id) => (id === "plex" ? { ok: false, reason: "unlisted", error: "not in registry" } : { ok: true }),
    installDeps: () => true,
    installBundle: () => true,
    free: () => {
      const was = free;
      free = false; // the retirement lands, then the box is claimed
      return was;
    },
  });
  assert.equal(reconcile.settle(desired), true, "interrupted, so it comes back");
  const next = reconcile.pending();
  assert.deepEqual(next.retired, ["plex"]);
  assert.equal(next.attempts, 0, "an interruption still spends no budget");
  reconcile.clear();
});

test("what comes back out of the state file is held to the same id rule", async () => {
  // The file is attacker-supplied until the backup's password verifies, and this
  // is the only door its ids come back through. record() writes clean ones; what
  // is READ is what run() maps over, and a junk entry there used to reach it.
  const raw = {
    v: 1,
    at: Date.now(),
    reason: "restore",
    attempts: 0,
    apps: [{ id: "keeper" }, null, { id: "NOT VALID" }, { id: "keeper" }],
    retired: ["plex", "plex", "no good", 7, "x".repeat(41)],
  };
  fs.writeFileSync(reconcile.STATE_FILE, JSON.stringify(raw));
  const back = reconcile.pending();
  assert.deepEqual(
    back.apps.map((a) => a.id),
    ["keeper"],
    "junk, duplicates and bad shapes are dropped",
  );
  assert.deepEqual(back.retired, ["plex"]);
  reconcile.clear();
});

test("an id in both lists is counted once, not once on each side", async () => {
  // Only settle() writes `retired`, and it removes the id from `apps` in the same
  // breath - so the two are disjoint on every path the box takes. A file that
  // says otherwise used to make "apps minus retired" negative, which reads on
  // screen as "-1 of 0".
  fs.writeFileSync(
    reconcile.STATE_FILE,
    JSON.stringify({ v: 1, at: Date.now(), reason: "restore", attempts: 0, apps: [{ id: "plex" }], retired: ["plex"] }),
  );
  const s = await reconcile.run(reconcile.pending(), RETIRED_IO("unlisted", "plex"));
  assert.deepEqual(s.gone, ["plex"]);
  assert.equal(s.wanted, 1);
  assert.ok(s.wanted - s.gone.length >= 0, "the app count can never go negative");
  reconcile.clear();
});

test("a restore whose apps are all retired stops after one run", async () => {
  const desired = reconcile.record([{ id: "plex" }], "restore");
  await reconcile.run(desired, RETIRED_IO("unlisted", "plex"));
  assert.equal(reconcile.settle(desired), false, "nothing left to come back for");
  assert.equal(reconcile.pending(), null);
});

test("a registry that could not be READ is still a failure to retry", async () => {
  const desired = reconcile.record([{ id: "plex" }], "restore");
  const s = await reconcile.run(desired, RETIRED_IO("unreachable", "plex"));
  assert.equal(s.steps.find((x) => x.id === "plex").state, "failed");
  assert.deepEqual(s.gone, []);
  assert.equal(reconcile.settle(desired), true);
  assert.deepEqual(
    reconcile.pending().apps.map((a) => a.id),
    ["plex"],
    "an unread catalogue must not retire an app",
  );
  reconcile.clear();
});

test("an install failure with no verdict at all stays a failure", async () => {
  const desired = reconcile.record([{ id: "plex" }], "restore");
  const s = await reconcile.run(desired, RETIRED_IO(undefined, "plex"));
  assert.equal(s.steps.find((x) => x.id === "plex").state, "failed");
  assert.equal(reconcile.settle(desired), true);
  reconcile.clear();
});
