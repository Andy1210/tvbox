// tvbox restore reconciliation.
//
// A backup carries what the box was CONFIGURED with, never what it had
// ACQUIRED: config.json, the hand-dropped manifests and the launcher's storage
// travel, but the hundreds of megabytes behind them - a registry app's own
// package, the flatpaks it runs, the static binaries under ~/.tvbox/bin, the web
// bundle extracted out of a flatpak - cannot. Each of those absences used to be
// its own bug (`bundleMissing` in install.js is the point fix for exactly one of
// them) and the rest simply stayed missing until someone noticed a grey tile.
//
// So a restore writes down a DESIRED STATE and the box reconciles towards it on
// the next boot: install every app the backup knew about, then its no-root deps,
// then its bundle. Declarative and re-runnable - a second pass over a box that is
// already whole plans nothing - which is what makes it safe to retry after a run
// that failed halfway (offline box, registry down).
//
// The planner is pure; the acquisition itself is injected, because the shell runs
// it out of process (cli.js) while the CLI runs it in-process.
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_FILE = path.join(os.homedir(), ".tvbox", "reconcile.json");
const MAX_APPS = 100; // a restore file is attacker-supplied until its password verifies
const MAX_ATTEMPTS = 3; // a permanently-failing app must not re-run at every boot forever

// ---- desired state ----
// Written by a restore, read by the next boot. Small and declarative: the ids the
// backup knew about. What each of them NEEDS is read off the manifest once the app
// is on the box, so this file never has to describe a build.
function record(appList, reason) {
  const apps = [];
  for (const a of Array.isArray(appList) ? appList : []) {
    const id = a && typeof a === "object" ? a.id : a;
    if (typeof id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(id)) continue;
    if (apps.some((x) => x.id === id)) continue;
    apps.push({ id });
    if (apps.length >= MAX_APPS) break;
  }
  if (!apps.length) return null;
  const state = { v: 1, at: Date.now(), reason: String(reason || "restore").slice(0, 40), attempts: 0, apps };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch (e) {
    console.warn("[reconcile] could not record the desired state:", e.message);
    return null;
  }
  return state;
}

function pending() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s || s.v !== 1 || !Array.isArray(s.apps) || !s.apps.length) return null;
    return s;
  } catch (e) {
    return null;
  }
}

function clear() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch (e) {
    /* best effort */
  }
}

function saveAttempts(state, attempts) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, attempts }), { mode: 0o600 });
  } catch (e) {
    /* only the retry budget is lost; the run itself already happened */
  }
}

// ---- the plan ----
// One entry per app the box should have, describing what it looks like RIGHT NOW:
//   { id, name?, present, depsMissing, depsInstallable, bundleMissing }
// `present` = a manifest with that id is loaded. `depsInstallable` = every missing
// dep is a no-root one (a `requires.download` binary or a `--user` flatpak); an
// apt-only dep is deliberately NOT planned, because reconciliation must stay
// rootless like everything else the shell does.
function planSteps(entries) {
  const steps = [];
  for (const e of entries || []) {
    if (!e || !e.id) continue;
    if (!e.present) steps.push({ id: e.id, name: e.name || null, kind: "app", state: "pending" });
  }
  for (const e of entries || []) {
    if (!e || !e.id || !e.present) continue;
    if (e.depsMissing && e.depsInstallable)
      steps.push({ id: e.id, name: e.name || null, kind: "deps", state: "pending" });
    if (e.bundleMissing) steps.push({ id: e.id, name: e.name || null, kind: "bundle", state: "pending" });
  }
  return steps;
}

// What one app looks like to the planner, read off the live box. `apps` is
// install.js (injected so this is testable without a home directory).
function describe(id, apps) {
  const m = apps.manifestById(id);
  if (!m) return { id, present: false, depsMissing: false, depsInstallable: false, bundleMissing: false };
  const deps = apps.appDeps(m);
  return {
    id,
    name: m.name || null,
    present: true,
    depsMissing: !deps.depsOk,
    depsInstallable: deps.installable,
    bundleMissing: apps.bundleMissing(m),
  };
}

// ---- the run ----
// One at a time, module-level, because the acquisitions it drives (a flatpak, a
// bundle) are exactly the heavy things the box must not do twice at once.
let status = { active: false, reason: null, startedAt: null, finishedAt: null, steps: [] };

function state() {
  const steps = status.steps;
  const done = steps.filter((s) => s.state === "done" || s.state === "failed" || s.state === "skipped").length;
  const current = steps.find((s) => s.state === "running") || null;
  return {
    active: status.active,
    // A restore has been recorded but its run hasn't started (or finished) yet -
    // the launcher watches this so it starts polling BEFORE the first step runs.
    pending: !!pending(),
    reason: status.reason,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    total: steps.length,
    done,
    current: current ? { id: current.id, name: current.name, kind: current.kind } : null,
    failed: steps.filter((s) => s.state === "failed").map((s) => ({ id: s.id, kind: s.kind, error: s.error || "" })),
    steps: steps.map((s) => ({ id: s.id, name: s.name, kind: s.kind, state: s.state })),
  };
}

// io:
//   apps            - install.js (manifestById / appDeps / bundleMissing / loadManifests)
//   installApp(id)  - acquire the app itself from the registry -> { ok, error? }
//   installDeps(id) - its no-root binary/flatpak deps -> boolean
//   installBundle(id) - its web bundle -> boolean
//   free()          - is the box still free to keep going? (a wake-up aborts the run)
//   onChange()      - optional: progress ticked
async function run(desired, io) {
  if (status.active) return state();
  const ids = (desired && desired.apps ? desired.apps : []).map((a) => a.id);
  status = {
    active: true,
    reason: (desired && desired.reason) || "restore",
    startedAt: Date.now(),
    finishedAt: null,
    steps: [],
  };
  const tick = () => {
    try {
      if (io.onChange) io.onChange(state());
    } catch (e) {
      /* a progress listener must never fail the run */
    }
  };
  const runStep = async (step) => {
    if (io.free && !io.free()) {
      step.state = "skipped";
      step.error = "box busy";
      tick();
      return false;
    }
    step.state = "running";
    tick();
    try {
      let ok = false;
      if (step.kind === "app") {
        const r = await io.installApp(step.id);
        ok = !!(r && r.ok);
        if (!ok) step.error = String((r && r.error) || "install failed").slice(0, 160);
      } else if (step.kind === "deps") {
        ok = !!(await io.installDeps(step.id));
        if (!ok) step.error = "dependency install failed";
      } else {
        ok = !!(await io.installBundle(step.id));
        if (!ok) step.error = "bundle install failed";
      }
      step.state = ok ? "done" : "failed";
    } catch (e) {
      step.state = "failed";
      step.error = String((e && e.message) || e).slice(0, 160);
    }
    tick();
    return step.state === "done";
  };

  try {
    // Pass 1: the apps themselves. Nothing about an app's deps or bundle can be
    // known before its manifest is on the box, which is why the plan is built
    // twice rather than all at once - the step count grows once, at this seam.
    const first = planSteps(ids.map((id) => describe(id, io.apps)));
    status.steps.push(...first.filter((s) => s.kind === "app"));
    tick();
    for (const step of status.steps) await runStep(step);
    io.apps.loadManifests();
    // Pass 2: deps + bundles, for every wanted app that is now present - including
    // the ones that were already there before this run (a re-flashed box restores
    // its manifests from the backup itself and only misses what sits behind them).
    const second = planSteps(ids.map((id) => describe(id, io.apps))).filter((s) => s.kind !== "app");
    status.steps.push(...second);
    tick();
    for (const step of second) await runStep(step);
  } finally {
    status.active = false;
    status.finishedAt = Date.now();
    tick();
  }
  return state();
}

// Keep the desired state only while retrying can still help, and spend the retry
// budget only on real failures.
//
// The distinction matters: a run whose steps were SKIPPED did not fail, it was
// interrupted - the user launched something on a box they had just restored, so the
// run stood down mid-way (that is the point of the free() check). Counting that as
// an attempt is how three interruptions in one evening would permanently throw the
// desired state away and leave the box without its apps, which is the opposite of
// what a retry budget is for. Only a step that genuinely failed - registry down,
// flatpak refused - burns one, and MAX_ATTEMPTS of those is the end of it.
function settle(desired) {
  const failed = status.steps.some((s) => s.state === "failed");
  const skipped = status.steps.some((s) => s.state === "skipped");
  const attempts = Number(desired && desired.attempts) || 0;
  if (!failed && !skipped) {
    clear();
    return false; // everything landed
  }
  if (failed) {
    if (attempts + 1 >= MAX_ATTEMPTS) {
      clear();
      return false; // out of budget: stop asking at every tick
    }
    saveAttempts(desired, attempts + 1);
    return true;
  }
  return true; // interrupted only - come back later, budget untouched
}

// Just "is a run in flight", for boxFree(): state() reads the desired-state file to
// answer `pending`, and every maintenance tick on the box asks this.
function busy() {
  return status.active;
}

module.exports = {
  record,
  pending,
  clear,
  planSteps,
  describe,
  run,
  settle,
  state,
  busy,
  STATE_FILE,
  MAX_ATTEMPTS,
};
