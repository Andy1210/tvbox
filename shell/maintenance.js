// The work the box does to itself: installing an app, fetching its binary deps,
// updating a flatpak, re-extracting a bundle whose flatpak moved on, and finishing
// a restore.
//
// It is here rather than in main.js because none of it touches a window. What it
// does touch is time and bandwidth, which is why every job asks whether the box is
// free first - a nightly update that starts while someone is watching a film is
// the failure mode this whole file is arranged around.
//
// Nothing runs in this process: every install is `cli.js` out of process, the same
// code path the `tvbox` CLI takes, because curl and flatpak take seconds to
// minutes and the Electron main thread cannot be blocked for either.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const apps = require("./install"); // manifests + install-recipe runner (shared with the tvbox CLI)
const config = require("./config");
const flatpak = require("./flatpak");
const reconcile = require("./reconcile");
const store = require("./store");

// The shell's own state, injected: whether the box is free, how to restart it,
// how to answer an HTTP request, and what to do once an app has landed.
let deps = {
  // Both default to "not free": until the shell has wired this up, nothing here
  // may decide the box is idle enough to spend its link on.
  boxIdle: () => false,
  boxFree: () => false,
  restartShell: () => {},
  hotLoadPlugin: () => {},
  applyPendingAppFiles: () => {},
  jsonRes: () => {},
  childEnv: () => process.env,
};
function init(d) {
  deps = { ...deps, ...d };
}

const installing = new Set(); // app ids whose bundle is being installed on-demand (UI)
// Per-app install progress for the store UI: id -> { phase }. `phase` is a
// coarse, reliable stage the launcher turns into "Downloading.../Installing..."
// text (not a fragile parsed %), so an install shows a live stage instead of a
// frozen screen. Every install step is also appended to ~/.tvbox/install.log so
// a slow/stuck install can be diagnosed (there was no install log before).
const installProgress = new Map(); // id -> { phase: "deps" | "bundle" | "finishing" }
const INSTALL_LOG = path.join(os.homedir(), ".tvbox", "install.log");
function setInstallPhase(id, phase) {
  if (phase) installProgress.set(id, { phase });
  else installProgress.delete(id);
}
function logInstall(id, line) {
  try {
    fs.appendFileSync(INSTALL_LOG, "[" + id + "] " + line + "\n");
  } catch (e) {
    /* best effort - a missing log must never fail an install */
  }
}
// Run `cli.js <args>` for app <id> at stage <phase>, piping its output to the
// install log (so flatpak/curl progress is inspectable) and resolving true on a
// clean exit. Used for both the bundle fetch and the no-root binary-dep install.
function spawnCli(args, id, phase) {
  return new Promise((resolve) => {
    setInstallPhase(id, phase);
    logInstall(id, phase + " start: cli " + args.join(" "));
    const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), ...args], {
      env: { ...deps.childEnv(), ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (d) =>
      String(d)
        .split(/\r?\n/)
        .forEach((l) => l.trim() && logInstall(id, l.trim()));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      logInstall(id, phase + " spawn error: " + e.message);
      resolve(false);
    });
    child.on("exit", (code) => {
      logInstall(id, phase + " exit " + code);
      resolve(code === 0);
    });
  });
}
// Full provision of a just-installed store app: fetch its no-root binary deps
// AND its bundle (whichever it declares), in order, from ONE store action - so
// the user never has to press the HOME tile to finish an install, and the app
// only reaches HOME once it is actually launchable. A `service` app's plugin
// still loads at boot, so it restarts once at the end (gated on idle); that is
// the last step, after everything is in place (hot-loading without a restart is
// a follow-up). Progress + the installing flag drive the store UI.
async function provisionFull(id) {
  const m = apps.manifestById(id);
  if (!m || installing.has(id)) return;
  installing.add(id);
  let ok = true;
  try {
    const need = apps.appDeps(m);
    if (!need.depsOk && need.installable) ok = await spawnCli(["deps", id, "--download-only"], id, "deps");
    if (ok && m.install && m.install.source && !apps.isInstalled(id))
      ok = await spawnCli(["install", id], id, "bundle");
  } catch (e) {
    logInstall(id, "provision error: " + (e.message || e));
    ok = false;
  }
  // Activate a service app's plugin WITHOUT a restart: hot-load registers its
  // routes on the live server and starts its daemon. Only if hot-load fails do
  // we fall back to a one-off restart (and only when idle, so nothing playing is
  // interrupted); otherwise the plugin just loads on the next natural boot.
  if (ok && m.service) {
    setInstallPhase(id, "finishing");
    if (deps.hotLoadPlugin(id)) {
      installing.delete(id);
      setInstallPhase(id, null);
      return;
    }
    if (deps.boxIdle()) {
      setTimeout(() => deps.restartShell("service install (hot-load failed): " + id), 1200);
      return; // keep installing/phase set until the restart
    }
  }
  installing.delete(id);
  setInstallPhase(id, null);
}

// Manual flatpak update for one app, the counterpart of the nightly
// tvbox-flatpak-update timer: a flatpak-backed app (RetroArch runs one, Plex's
// bundle is extracted from one) has a version the registry knows nothing about, so
// the store needs a way to move it NOW rather than at 03:30.
//
// Out of process for the same reason an install is - a flatpak is hundreds of MB -
// and it reuses `installing` + the progress phase, so the store shows the same
// progress it does for an install. What actually changed is decided by the commit
// before and after, since a rebuild can keep the version string.
const flatpakResult = new Map(); // id -> { ok, changed, version } for the store's status line
function startFlatpakUpdate(id, res) {
  const m = apps.manifestById(id);
  const refs = m ? flatpak.refsFor(m) : [];
  if (!m || !refs.length) return deps.jsonRes(res, { ok: false, error: "no flatpak" });
  // Busy is a refusal, not a start. Reporting `installing` here would make the
  // launcher wait for a flatpak result that a bundle install is never going to
  // produce, and then read its absence as a failure.
  if (installing.has(id)) return deps.jsonRes(res, { ok: false, error: "busy" });
  installing.add(id);
  flatpakResult.delete(id);
  (async () => {
    const before = flatpak.commitsSync(refs);
    const ok = await spawnCli(["flatpak-update", id], id, "flatpak");
    flatpak.invalidate();
    const after = flatpak.commitsSync(refs);
    const changed = refs.some((f) => before[f.ref] !== after[f.ref]);
    // The bundle is a copy of the flatpak's files, so a moved flatpak means the
    // copy is now behind: bring it level in the same action.
    if (ok && changed && apps.bundleStale(m)) await spawnCli(["install", id, "--force"], id, "bundle");
    const versions = await flatpak.list({ fresh: true });
    flatpakResult.set(id, {
      ok,
      changed,
      version: refs.map((f) => (versions.get(f.ref) || {}).version).filter(Boolean)[0] || null,
    });
    installing.delete(id);
    setInstallPhase(id, null);
  })();
  return deps.jsonRes(res, { ok: true, updating: true });
}

// An extracted bundle stays behind when its flatpak moves, and the flatpak moves
// on its own: the nightly timer updates it with the shell none the wiser. This is
// what notices - out of process (a bundle can be large) and only when the box is
// idle, since it replaces files an app may be serving from.
let bundleRefreshBusy = false;
async function bundleRefreshTick() {
  if (!deps.boxFree()) return;
  // Behind its flatpak OR absent entirely. The second case is a settings restore:
  // the manifest comes back, the bundle does not, and nothing else would ever pick
  // that up (see bundleMissing in install.js).
  const stale = apps.getManifests().filter((m) => apps.bundleStale(m) || apps.bundleMissing(m));
  if (!stale.length) return;
  bundleRefreshBusy = true;
  try {
    for (const m of stale) {
      // a wake-up aborts the run; not boxFree(), whose flag this run itself holds
      if (installing.size || !deps.boxIdle()) break;
      console.log(
        apps.bundleMissing(m)
          ? "[install] bundle missing, acquiring:"
          : "[install] bundle behind its flatpak, refreshing:",
        m.id,
      );
      installing.add(m.id);
      await spawnCli(["install", m.id, "--force"], m.id, "bundle");
      installing.delete(m.id);
      setInstallPhase(m.id, null);
    }
  } finally {
    bundleRefreshBusy = false;
  }
}

// A restore brings the box's SETTINGS back; this brings back what sat behind
// them. The desired state was recorded by the restore itself (reconcile.js), so
// this only has to drive the acquisitions - out of process for the same reason
// every other install is, and only while the box is free, since a restored box
// is usually one someone is standing in front of.
//
// It runs on the boot AFTER the restore: the restart is what makes plugins re-read
// the restored credentials, and doing this before it would race the very files the
// restore just wrote.
async function reconcileTick() {
  // An app whose manifest was in the backup itself (the single-json form) is
  // already here, so its own files can land before anything is downloaded.
  deps.applyPendingAppFiles();
  const desired = reconcile.pending();
  if (!desired || !deps.boxFree()) return;
  console.log("[reconcile] re-acquiring", desired.apps.length, "app(s) after a", desired.reason);
  await reconcile.run(desired, {
    apps,
    free: () => deps.boxIdle() && installing.size === 0, // not boxFree(): this run holds that flag itself
    installApp: (id) => store.install(config, id),
    installDeps: (id) => withInstalling(id, () => spawnCli(["deps", id, "--download-only"], id, "deps")),
    installBundle: (id) => withInstalling(id, () => spawnCli(["install", id], id, "bundle")),
  });
  const s = reconcile.state();
  const retrying = reconcile.settle(desired);
  console.log(
    "[reconcile] done:",
    s.done - s.failed.length,
    "of",
    s.total,
    s.failed.length
      ? "(" + s.failed.map((f) => f.id + "/" + f.kind).join(", ") + " failed" + (retrying ? ", will retry" : "") + ")"
      : "",
  );
  // Every app that was going to arrive has arrived, so the files an app asked to
  // have carried can be placed - and whatever still has no app to belong to is
  // dropped rather than retried at every boot from here on.
  deps.applyPendingAppFiles({ final: !retrying });
  // Tiles come back on their own (manifests reload per /apps request), but a
  // `service` app's plugin loads at boot only. Hot-load each one instead of
  // restarting: the user is watching this happen on a box they just restored, and
  // an unexplained restart at the end is exactly what a restore should not do.
  //
  // A `deps` step counts as much as an `app` one: loadOnePlugin is deps-gated, so an
  // app whose package survived the restore but whose flatpak did not was SKIPPED at
  // boot - installing the flatpak here is exactly what makes it loadable, and
  // without this its routes and daemon would stay dead until some unrelated restart.
  // hotLoadPlugin is idempotent (loadedPluginIds) and refuses anything still short
  // of a dep, so calling it for every landed step is safe.
  for (const step of s.steps) {
    if ((step.kind === "app" || step.kind === "deps") && step.state === "done") deps.hotLoadPlugin(step.id);
  }
}

// Mark an app as installing for the duration of one step, so the store UI shows
// the same progress it does for a manual install and nothing else starts work on
// the same app underneath it.
async function withInstalling(id, fn) {
  installing.add(id);
  try {
    return await fn();
  } finally {
    installing.delete(id);
    setInstallPhase(id, null);
  }
}

// Nightly app auto-update (the Fire TV model): in the OTA updater's 03-06h
// window, when the box is idle and update.appsAuto isn't turned off, install
// every pending registry update through the EXACT same path as the store's
// Update button (store.install + provisionFull) - provisionFull's own idle
// gating handles any service-plugin restart. One app at a time; re-checked
// between apps so a wake-up aborts the run.
let appsAutoBusy = false;
async function appsAutoTick() {
  const u = config.rawUpdate() || {};
  if (u.appsAuto === false) return;
  const h = new Date().getHours();
  if (h < 3 || h > 5) return;
  if (!deps.boxFree()) return;
  appsAutoBusy = true;
  try {
    const l = await store.listForUi(config)(true);
    for (const id of l.updates || []) {
      // re-checked per app: a user install started during the awaited registry
      // refresh (or a provisionFull that just scheduled a service restart)
      // must stop the run - store.install would swap ~/.tvbox/apps/<id> under it.
      // Not boxFree(), whose flag this run itself holds.
      if (!deps.boxIdle() || installing.size) break;
      console.log("[store] nightly app auto-update:", id);
      const r = await store.install(config, id);
      if (r && r.ok) await provisionFull(id);
    }
  } catch (e) {
    console.warn("[store] nightly app auto-update failed:", String(e.message || e).slice(0, 160));
  } finally {
    appsAutoBusy = false;
  }
}

// On-demand bundle install (e.g. Plex's flatpak) triggered from the launcher.
// Runs the recipe OUT OF PROCESS (`node cli.js install <id>`) so a multi-minute
// flatpak download never blocks the Electron main process / UI; the launcher
// polls /tvbox/api/apps and sees `installing` then `installed` flip. User-space
// only (flatpak --user / curl / git) - never root; apt deps are the `tvbox deps`
// CLI's job. Restricted to a ready app that declares an install recipe.
function startInstall(id, res) {
  const m = apps.manifestById(id);
  if (!m || !(m.install && m.install.source) || m.status !== "ready")
    return deps.jsonRes(res, { ok: false, error: "not installable" });
  if (apps.isInstalled(id)) return deps.jsonRes(res, { ok: true, installed: true });
  if (installing.has(id)) return deps.jsonRes(res, { ok: true, installing: true });
  installing.add(id);
  console.log("[install] on-demand start:", id);
  // Run cli.js as Node via Electron's own binary (ELECTRON_RUN_AS_NODE) so we
  // don't depend on a separate `node` being on PATH in the shell's env.
  const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "install", id], {
    env: { ...deps.childEnv(), ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  child.on("error", (e) => {
    console.warn("[install]", id, "spawn error:", e.message);
    installing.delete(id);
  });
  child.on("exit", (code) => {
    console.log("[install]", id, "exit", code);
    installing.delete(id);
  });
  return deps.jsonRes(res, { ok: true, installing: true });
}

// Install an app's no-root binary deps (requires.download) from the UI - the
// "remote-only, no CLI" path. Runs `cli.js deps <id> --download-only` out of
// process (curl/tar can take seconds; never block the main process) and reuses
// the `installing` flag so the launcher's poll shows progress. apt-only deps
// are NOT touched here (they need root / the image / `tvbox deps`).
function startDeps(id, res) {
  const m = apps.manifestById(id);
  if (!m) return deps.jsonRes(res, { ok: false, error: "unknown app" });
  const need = apps.appDeps(m);
  if (need.depsOk) return deps.jsonRes(res, { ok: true, depsOk: true });
  if (!need.installable)
    return deps.jsonRes(res, { ok: false, error: "needs setup on the box: tvbox deps " + id, missing: need.missing });
  if (installing.has(id)) return deps.jsonRes(res, { ok: true, installing: true });
  installing.add(id);
  console.log("[deps] on-demand start:", id);
  const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "deps", id, "--download-only"], {
    env: { ...deps.childEnv(), ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  child.on("error", (e) => {
    console.warn("[deps]", id, "spawn error:", e.message);
    installing.delete(id);
  });
  child.on("exit", (code) => {
    console.log("[deps]", id, "exit", code);
    installing.delete(id);
    // A freshly downloaded binary is now on PATH; activate a `service` plugin
    // by hot-load (no restart) - same as the store install path.
    if (code === 0 && m.service) deps.hotLoadPlugin(id);
  });
  return deps.jsonRes(res, { ok: true, installing: true });
}

// Is any of this running? boxFree() in main.js asks, because a job that started
// while the box looked idle still owns the link.
function busy() {
  return installing.size > 0 || bundleRefreshBusy || appsAutoBusy || reconcile.busy();
}

// What the store UI shows next to an app: the coarse stage, never a parsed %.
function progressFor(id) {
  return installProgress.get(id) || null;
}

// The result of the last manual flatpak update, for the store's status line.
function flatpakStatusFor(id) {
  return flatpakResult.get(id) || null;
}

// Is this app being installed right now? A tile says so instead of pretending it
// is launchable, and a second install of the same app is refused.
function isInstalling(id) {
  return installing.has(id);
}

function installingIds() {
  return [...installing];
}

module.exports = {
  init,
  busy,
  progressFor,
  flatpakStatusFor,
  isInstalling,
  installingIds,
  provisionFull,
  startInstall,
  startDeps,
  startFlatpakUpdate,
  bundleRefreshTick,
  reconcileTick,
  appsAutoTick,
};
