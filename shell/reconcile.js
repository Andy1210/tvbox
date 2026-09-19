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
const ID_RE = /^[a-z0-9_-]{1,40}$/;

// One gate for every id that comes out of the state file, which is
// attacker-supplied until the backup's password verifies: the shape, the
// duplicates and the count, in one place so a second list cannot forget one.
function validIds(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const id = raw && typeof raw === "object" ? raw.id : raw;
    if (typeof id !== "string" || !ID_RE.test(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_APPS) break;
  }
  return out;
}

function record(appList, reason) {
  const apps = validIds(appList).map((id) => ({ id }));
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

function save(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch (e) {
    /* only the retry budget and the trimmed list are lost; the run itself already happened */
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
let status = { active: false, reason: null, startedAt: null, finishedAt: null, steps: [], retired: [], wanted: 0 };

// A step that will not be tried again in this run, whatever its outcome. `gone`
// belongs here for the same reason `failed` does: the progress bar is counting
// how much of the plan is behind it, not how much of it worked.
const SETTLED = new Set(["done", "failed", "skipped", "gone"]);

function state() {
  const steps = status.steps;
  const done = steps.filter((s) => SETTLED.has(s.state)).length;
  const current = steps.find((s) => s.state === "running") || null;
  return {
    active: status.active,
    // A restore has been recorded but its run hasn't started (or finished) yet -
    // the launcher watches this so it starts polling BEFORE the first step runs.
    pending: !!pending(),
    reason: status.reason,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    // Steps, for the progress bar. One app can owe two of them (deps and bundle)
    // and an app the backup restored whole owes none, so this is not a count of
    // apps and must not be used as one - `wanted` below is.
    total: steps.length,
    done,
    // Apps: what this restore is about, across all of its passes. The sentence on
    // screen counts apps ("8 of 9 apps restored"), and counting steps there said
    // "nothing to bring back" for a restore that had brought an app back without
    // needing a single step.
    wanted: status.wanted,
    current: current ? { id: current.id, name: current.name, kind: current.kind } : null,
    failed: steps.filter((s) => s.state === "failed").map((s) => ({ id: s.id, kind: s.kind, error: s.error || "" })),
    // Separate from `failed` because it is a different sentence to the person
    // watching: nothing went wrong, the app is simply not published any more.
    //
    // Ids, not names, and there is no name to be had: a step only reaches `gone`
    // when its app is absent, and describe() carries no name for an app that is
    // not on the box. Nothing else knows one either - the app is installed
    // nowhere and no registry offers it - so the id is what the box calls it, in
    // the log, in the CLI and on screen.
    //
    // Every app THIS RESTORE has found retired, not only the ones this pass did.
    // A run that retires one app and fails on another keeps the desired state
    // alive for the retry, and the launcher stays on its "still working" label
    // while it does - so the summary naming the retired app is only ever drawn on
    // the LAST pass, by which time settle() had taken the id out of the list and
    // the next run planned no step for it. It was reported to nobody.
    gone: [...status.retired, ...steps.filter((s) => s.state === "gone").map((s) => s.id)],
    steps: steps.map((s) => ({ id: s.id, name: s.name, kind: s.kind, state: s.state })),
  };
}

// io:
//   apps            - install.js (manifestById / appDeps / bundleMissing / loadManifests)
//   installApp(id)  - acquire the app itself from the registry
//                     -> { ok, error?, reason? }; reason "unlisted" means every
//                     configured registry answered and none offers it any more
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
    // What earlier passes of this same restore already found retired. Read back
    // through the same id rule record() uses, because the file is
    // attacker-supplied until the backup's password verifies.
    retired: validIds(desired && desired.retired),
    wanted: 0,
  };
  // Every app this restore is about: the ones still wanted plus the ones earlier
  // passes retired, which left the wanted list but not the restore.
  status.wanted = new Set([...ids, ...status.retired]).size;
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
      // An app the catalogue no longer carries is the one outcome retrying cannot
      // change: the acquisition asked every configured registry, they all answered,
      // and none of them has it. Only the store's own verdict may say so
      // (`reason: "unlisted"`, store.js) - a registry that could not be read looks
      // exactly the same from here and means the opposite.
      let gone = false;
      if (step.kind === "app") {
        const r = await io.installApp(step.id);
        ok = !!(r && r.ok);
        if (!ok) {
          step.error = String((r && r.error) || "install failed").slice(0, 160);
          gone = !!r && r.reason === "unlisted";
        }
      } else if (step.kind === "deps") {
        ok = !!(await io.installDeps(step.id));
        if (!ok) step.error = "dependency install failed";
      } else {
        ok = !!(await io.installBundle(step.id));
        if (!ok) step.error = "bundle install failed";
      }
      step.state = ok ? "done" : gone ? "gone" : "failed";
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
//
// A third outcome leaves the desired state altogether. An app that no configured
// registry offers any more cannot be acquired by asking them again, so counting it
// as a failure spends the budget on a question with a known answer - and until the
// budget runs out, every boot re-runs the restore, puts its banner back on the
// television and reports the app as one that could not be downloaded. It is dropped
// from the list instead, and what remains is retried on its own terms.
//
// That drop is made on ONE observation, where every other outcome here gets a
// budget, and the trade is deliberate. The verdict already requires every
// configured registry to have answered - one that errored makes it `unreachable`
// and nothing is dropped - so being wrong needs all of them to agree wrongly at
// once, e.g. a source caught mid-republish serving a well-formed index that is
// missing the app. What it costs when that happens is one app id off a restore,
// which a person can install again; what a second opinion would cost is the
// banner coming back on the television for a settled question, which is the thing
// being fixed.
function settle(desired) {
  const gone = new Set(status.steps.filter((s) => s.state === "gone").map((s) => s.id));
  const apps = (desired && Array.isArray(desired.apps) ? desired.apps : []).filter((a) => !gone.has(a.id));
  // Taken out of the wanted list, kept in the record of what this restore found.
  // Without that the only pass on which the summary is drawn - the last one - has
  // already forgotten them, and the person is never told which app is gone.
  const retired = validIds([...status.retired, ...gone]);
  const failed = status.steps.some((s) => s.state === "failed");
  const skipped = status.steps.some((s) => s.state === "skipped");
  const attempts = Number(desired && desired.attempts) || 0;
  // Nothing left to come back for - either every step landed, or every app the
  // backup named has been retired. The two halves overlap today: a retired app is
  // absent, so it plans no deps or bundle step of its own, and an empty list can
  // therefore only arise when every step was a retirement and nothing failed or
  // stood down. The empty check is kept anyway for what it guards, which is
  // writing a state file with no apps in it - one `pending()` refuses to read, so
  // it would mean the same as no file while sitting on the card for ever.
  if (!apps.length || (!failed && !skipped)) {
    clear();
    return false;
  }
  if (failed) {
    if (attempts + 1 >= MAX_ATTEMPTS) {
      clear();
      return false; // out of budget: stop asking at every tick
    }
    save({ ...desired, apps, retired, attempts: attempts + 1 });
    return true;
  }
  save({ ...desired, apps, retired, attempts }); // interrupted only - budget untouched
  return true;
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
