// Whole-box scenarios, across the module boundaries the unit tests stop at.
//
// WHY THIS EXISTS: every bug found on the box in this area sat in an integration
// seam, not in a unit. `bundleStale` was right, the store was right, HOME was right
// - their sum was a dead end. The restore path is the same shape: backup.js reads
// what install.js declares, writes what appdata.js guards, records what reconcile.js
// plans, and store.js acquires. Each of those has unit tests with injected fakes,
// and the fakes agreed with each other while the real modules did not.
//
// So each test here is a SCENARIO a person would recognise ("a re-flashed box
// restores and comes back whole"), driven through the real modules, a real
// filesystem and a real HTTP registry.
//
// TWO CONSTRAINTS SHAPE THE WHOLE FILE:
//
// 1. Every module resolves `os.homedir()` at IMPORT time (install.js APPS_DATA,
//    backup.js TVBOX, config.js FILE, reconcile.js STATE_FILE, appdata.js DIR), so
//    one process can only ever be one box. A scenario with two boxes therefore runs
//    each of them as a CHILD PROCESS with its own HOME - which is also closer to the
//    truth than swapping a global would be.
// 2. No Electron. The window/mpv layer needs a display and is exercised on a real
//    box; what is NOT covered anywhere else is the module graph, and none of it
//    needs a BrowserWindow. This deliberately does not test main.js's own wiring
//    (routes, timers, publish-on-event) - that would mean booting Electron under
//    Xvfb in CI, and a flaky job is worse than an absent one.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const test = require("node:test");
const assert = require("node:assert");

const SHELL = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-integration-"));

// ---- a box ----
// A fresh HOME with a ~/.tvbox in it. Nothing else: everything a real box has is
// put there by the scenario, so a test never passes on state it did not create.
let boxSeq = 0;
function newBox(label) {
  const home = path.join(TMP, `box-${++boxSeq}-${label}`);
  fs.mkdirSync(path.join(home, ".tvbox"), { recursive: true });
  return home;
}

// Run a script AS that box: a child process with its own HOME, so the modules
// resolve their paths to it. The script reports by calling `out(value)`, which
// prints one `__RESULT__<json>` line; the LAST such line is what the test asserts
// on, so the modules' own console output can flow freely around it. Everything the
// child printed is included when it fails, which is what makes a broken scenario
// diagnosable instead of just red.
// ASYNC on purpose, and this is not a style choice: the registry below runs in THIS
// process, and a synchronous execFileSync would block this event loop for as long as
// the child runs - so the child's request for the index would never be answered and
// every scenario would fail on a ten-second fetch timeout. Measured, once.
async function inBox(home, body) {
  const file = path.join(TMP, `run-${crypto.randomBytes(4).toString("hex")}.js`);
  fs.writeFileSync(
    file,
    `const SHELL = ${JSON.stringify(SHELL)};
const path = require("node:path");
const fs = require("node:fs");
const mod = (n) => require(path.join(SHELL, n));
const out = (v) => console.log("__RESULT__" + JSON.stringify(v));
(async () => {
${body}
})().catch((e) => {
  console.error("scenario threw: " + ((e && e.stack) || e));
  process.exit(9);
});
`,
  );
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [file], {
      cwd: SHELL,
      env: { ...process.env, HOME: home, TVBOX_TEST: "1" },
      encoding: "utf8",
      timeout: 120000,
    }));
  } catch (e) {
    throw new Error(`box ${path.basename(home)} failed:\n${e.stdout || ""}\n${e.stderr || ""}`, { cause: e });
  }
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("__RESULT__"));
  if (!line) throw new Error(`box ${path.basename(home)} printed no result:\n${stdout}`);
  return JSON.parse(line.slice("__RESULT__".length));
}

// ---- a registry ----
// The real store client talks HTTP, verifies sha256 per file and pins every fetch to
// the index's origin, so a stubbed function call would skip exactly the parts that
// have broken before. This serves a real index over loopback (netguard allows plain
// http to LAN/loopback for self-hosted registries, which is what this is).
// ONE server for the whole file, unref'd: a test that throws before it could clean
// up must not leave a handle holding the process open (it does not fail then - it
// HANGS, with no output, which is a far worse way to find out).
//
// `manifest.json` is derived from the manifest rather than written by hand: the
// installer refuses a package whose own manifest disagrees with the index, so a
// fixture that could disagree is a fixture that tests the wrong thing.
const registry = { apps: [], fail: false, requests: 0 };
const registryServer = http.createServer((req, res) => {
  registry.requests++;
  if (registry.fail) {
    res.writeHead(500);
    return res.end("registry is down");
  }
  const url = new URL(req.url, "http://localhost");
  const packages = {};
  for (const a of registry.apps) {
    packages[a.manifest.id] = {
      files: Object.entries(filesOf(a)).map(([rel, body]) => ({
        path: rel,
        sha256: crypto.createHash("sha256").update(body).digest("hex"),
      })),
    };
  }
  if (url.pathname === "/index.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ registryVersion: 1, apps: registry.apps.map((a) => a.manifest), packages }));
  }
  const m = /^\/apps\/([a-z0-9_-]+)\/(.+)$/.exec(url.pathname);
  const app = m && registry.apps.find((a) => a.manifest.id === m[1]);
  const body = app && filesOf(app)[m[2]];
  if (body === undefined) {
    res.writeHead(404);
    return res.end("no");
  }
  res.writeHead(200);
  res.end(body);
});
registryServer.listen(0, "127.0.0.1");
registryServer.unref();
// listen() is asynchronous and address() is null until it completes. Every run so
// far got away with it because node:test turns the event loop before the first test
// body - that is luck, not a guarantee, and the symptom would be an intermittent
// "http://127.0.0.1:null/index.json".
const listening = new Promise((resolve, reject) => {
  if (registryServer.listening) return resolve();
  registryServer.once("listening", resolve);
  registryServer.once("error", reject);
});
test.before(() => listening);

function filesOf(a) {
  return { "manifest.json": JSON.stringify(a.manifest), ...(a.files || {}) };
}
function registryUrl() {
  return `http://127.0.0.1:${registryServer.address().port}/index.json`;
}
// A package app the registry offers. Only the parts a scenario cares about.
function app(id, extra) {
  return {
    manifest: {
      id,
      name: id[0].toUpperCase() + id.slice(1),
      version: "1.0.0",
      type: "webclient",
      status: "ready",
      runtime: { serve: "local", capabilities: ["nav"] },
      ...(extra || {}),
    },
    files: { "web/index.html": `<html>${id}</html>` },
  };
}

// The reconciliation's acquisition side, in-process (the shell drives it out of
// process via cli.js; the CLI drives it exactly like this). Written once here
// because three scenarios need it.
const RECONCILE_IO = `
const apps = mod("install");
const store = mod("store");
const config = mod("config");
const reconcile = mod("reconcile");
const io = {
  apps,
  installApp: (id) => store.install(config, id),
  installDeps: (id) => { const m = apps.manifestById(id); apps.installUiDeps(m, () => {}); return apps.appDeps(m).depsOk; },
  installBundle: (id) => { apps.installApp(apps.manifestById(id), { log: () => {} }); return true; },
};
`;

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ============================================================================
// A re-flashed box restores and comes back WHOLE.
//
// This is the scenario the whole reconcile feature exists for, and the one that
// used to fail silently: a backup carries the manifest-only apps but not the
// PACKAGE apps (their code cannot travel in a settings file), so a restore used to
// bring back a subset and nobody noticed which. Everything below is asserted from
// the restoring box's own disk.
// ============================================================================
test("a re-flashed box restores its config, its apps, its app data and its app files", async () => {
  registry.apps = [app("gamebox", { backup: { paths: ["saves"], state: ["gamebox-share.json"] } }), app("tunes")];

  const source = newBox("source");
  const target = newBox("target");

  // ---- the source box, as someone actually had it ----
  const backupFile = path.join(TMP, "from-source.tvbackup");
  const before = await inBox(
    source,
    `${RECONCILE_IO}
    const appdata = mod("appdata");
    const backup = mod("backup");
    const TVBOX = path.join(process.env.HOME, ".tvbox");
    fs.writeFileSync(path.join(TVBOX, "config.json"), JSON.stringify({
      store: { registry: ${JSON.stringify(registryUrl())} },
      iptv: { mode: "m3u", m3u: { url: "http://iptv.example/list.m3u" } },
      parental: { pinHash: "deadbeef", lockedGroups: ["adult"] },
      ui: { locale: "hu", hourFormat: "24" },
    }, null, 2));

    // Two PACKAGE apps, installed from the registry the way a person would.
    for (const id of ["gamebox", "tunes"]) {
      const r = await store.install(config, id);
      if (!r.ok) throw new Error(id + ": " + r.error);
    }
    // ...and one hand-dropped manifest-only app, the form a backup CAN carry.
    fs.writeFileSync(path.join(TVBOX, "apps", "handmade.json"), JSON.stringify({
      id: "handmade", name: "Handmade", type: "webclient", status: "ready",
      runtime: { serve: "remote", url: "https://example.invalid/" },
    }));
    apps.loadManifests();

    // The app's own storage (the \`storage\` capability) and its declared files.
    appdata.set("gamebox", "difficulty", "hard");
    appdata.set("gamebox", "lastPlayed", "sonic");
    const root = apps.appBackupRoot(apps.manifestById("gamebox"));
    fs.mkdirSync(path.join(root, "saves"), { recursive: true });
    fs.writeFileSync(path.join(root, "saves", "sonic.srm"), "SRAM-CONTENTS");
    fs.writeFileSync(path.join(TVBOX, "gamebox-share.json"), '{"share":"nas"}');

    const payload = backup.collect({ localStorage: JSON.stringify({ "tvbox.locale": "hu" }) });
    fs.writeFileSync(${JSON.stringify(backupFile)}, JSON.stringify(backup.encrypt(payload, "correct-horse")));
    out({
      apps: payload.apps.map((a) => a.id).sort(),
      packages: payload.apps.filter((a) => a.package).map((a) => a.id).sort(),
      userApps: Object.keys(payload.userApps).sort(),
      appdataIds: Object.keys(payload.appdata),
      appFiles: Object.keys(payload.appFiles.gamebox || {}).sort(),
    });`,
  );

  // The backup knows about all three apps, but only ONE of them travels as a
  // manifest - which is precisely why the ids have to be recorded.
  assert.deepStrictEqual(before.apps, ["gamebox", "handmade", "tunes"]);
  assert.deepStrictEqual(before.packages, ["gamebox", "tunes"]);
  assert.deepStrictEqual(before.userApps, ["handmade"], "a package app's code cannot travel in a settings file");
  assert.deepStrictEqual(before.appdataIds, ["gamebox"]);
  assert.deepStrictEqual(before.appFiles, ["saves/sonic.srm", "state/gamebox-share.json"]);

  // ---- the target box: empty, restores, reconciles ----
  const after = await inBox(
    target,
    `${RECONCILE_IO}
    const appdata = mod("appdata");
    const backup = mod("backup");
    const TVBOX = path.join(process.env.HOME, ".tvbox");
    const payload = backup.decrypt(JSON.parse(fs.readFileSync(${JSON.stringify(backupFile)}, "utf8")), "correct-horse");
    backup.apply(payload);

    const desiredBefore = reconcile.pending();
    // The boot after the restore: place what can be placed, then re-acquire.
    backup.applyPendingAppFiles();
    const state = await reconcile.run(desiredBefore, io);
    reconcile.settle(desiredBefore);
    backup.applyPendingAppFiles({ final: true });

    apps.loadManifests();
    const gb = apps.manifestById("gamebox");
    const root = gb && apps.appBackupRoot(gb);
    const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return null; } };
    out({
      desiredApps: desiredBefore.apps.map((a) => a.id).sort(),
      steps: state.steps.map((s) => s.id + ":" + s.kind + ":" + s.state),
      failed: state.failed,
      installed: apps.getManifests().map((m) => m.id).sort(),
      packageDirs: apps.getManifests().filter((m) => m._dir).map((m) => m.id).sort(),
      config: JSON.parse(read(path.join(TVBOX, "config.json"))),
      appdata: appdata.readAll("gamebox"),
      sram: root && read(path.join(root, "saves", "sonic.srm")),
      sidecar: read(path.join(TVBOX, "gamebox-share.json")),
      pendingLocalStorage: backup.pendingLocalStorage().data,
      desiredAfter: reconcile.pending(),
    });`,
  );

  assert.deepStrictEqual(
    after.desiredApps,
    ["gamebox", "handmade", "tunes"],
    "the restore recorded what to re-acquire",
  );
  // handmade came back with the config (it IS a manifest); the two packages had to
  // be fetched. Nothing should have failed.
  assert.deepStrictEqual(after.failed, []);
  assert.deepStrictEqual(
    after.steps.filter((s) => s.endsWith(":done")).sort(),
    ["gamebox:app:done", "tunes:app:done"],
    "exactly the package apps were acquired",
  );
  assert.deepStrictEqual(after.installed, ["gamebox", "handmade", "tunes"], "the box has every app it had before");
  assert.deepStrictEqual(after.packageDirs, ["gamebox", "tunes"], "and the packages are real package dirs, not stubs");

  // The settings themselves, verbatim - restore is deliberately not a merge.
  assert.equal(after.config.iptv.m3u.url, "http://iptv.example/list.m3u");
  assert.equal(after.config.parental.pinHash, "deadbeef");
  assert.equal(after.config.ui.locale, "hu");

  // The three things that used to be lost without anyone noticing.
  assert.deepStrictEqual(after.appdata, { difficulty: "hard", lastPlayed: "sonic" }, "the app's own storage");
  assert.equal(after.sram, "SRAM-CONTENTS", "the app's declared files, under ITS root");
  assert.equal(after.sidecar, '{"share":"nas"}', "and its ~/.tvbox sidecar");
  assert.ok(after.pendingLocalStorage, "the launcher's storage is parked for it to pick up");

  // A finished reconciliation stops asking.
  assert.equal(after.desiredAfter, null);
});

// ============================================================================
// A clone does not inherit the source box's identity.
// ============================================================================
test("a clone seed gives the second box its own MQTT and Spotify identity", async () => {
  const source = newBox("clone-source");
  const target = newBox("clone-target");
  const seed = path.join(TMP, "clone.tvbackup");

  const a = await inBox(
    source,
    `const config = mod("config");
    const backup = mod("backup");
    const identity = mod("identity");
    const TVBOX = path.join(process.env.HOME, ".tvbox");
    // Configured through the UI: setMqtt is what a settings save calls.
    config.setMqtt({ host: "broker.lan", username: "tvbox", password: "s3cret", deviceId: identity.defaultDeviceId() });
    config.setSpotify({ enabled: true, deviceName: identity.defaultSpotifyName() });
    fs.writeFileSync(${JSON.stringify(seed)}, JSON.stringify(backup.encrypt(backup.collect(null, { clone: true }), "pw-1234")));
    out({
      hostname: identity.hostname(),
      storedDeviceId: (JSON.parse(fs.readFileSync(path.join(TVBOX, "config.json"), "utf8")).mqtt || {}).deviceId ?? null,
      effectiveDeviceId: config.publicConfig().mqtt.deviceId,
      effectiveSpotify: config.publicConfig().spotify.deviceName,
    });`,
  );

  // Saving the settings form must NOT freeze the derived value into config.json -
  // that is what would later read as "a name its owner chose" and be inherited.
  assert.equal(a.storedDeviceId, null, "the derived default is not stored");
  assert.equal(a.effectiveDeviceId, a.hostname.replace(/[^a-zA-Z0-9_-]/g, "_"));

  const b = await inBox(
    target,
    `const config = mod("config");
    const backup = mod("backup");
    const identity = mod("identity");
    const payload = backup.decrypt(JSON.parse(fs.readFileSync(${JSON.stringify(seed)}, "utf8")), "pw-1234");
    if (!payload.clone) throw new Error("the seed did not declare itself a clone");
    // Pretend the owner named the new box while restoring it (the phone form does
    // this before apply, because identity derives from the CURRENT hostname).
    const os = require("node:os");
    os.hostname = () => "halo-szoba";
    backup.apply(payload);
    out({
      sourceHostname: payload.hostname,
      storedDeviceId: (config.publicConfig ? (JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".tvbox", "config.json"), "utf8")).mqtt || {}).deviceId : null) ?? null,
      effectiveDeviceId: config.publicConfig().mqtt.deviceId,
      effectiveSpotify: config.publicConfig().spotify.deviceName,
      // the setup itself must still travel
      broker: (config.rawMqtt() || {}).host,
      hasPassword: !!(config.rawMqtt() || {}).password,
    });`,
  );

  assert.equal(b.broker, "broker.lan", "the settings travelled");
  assert.ok(b.hasPassword, "including the credential");
  assert.equal(b.storedDeviceId, null, "still nothing stored - the derivation stays live");
  assert.notEqual(b.effectiveDeviceId, a.effectiveDeviceId, "the two boxes must not share a topic segment");
  assert.equal(b.effectiveDeviceId, "halo-szoba");
  assert.notEqual(b.effectiveSpotify, a.effectiveSpotify, "nor a Connect name");
});

test("a clone seed does not carry the first box's app identity in localStorage", async () => {
  // The unit tests prove the filter; this proves the SEAM - collect on one box,
  // decrypt and apply on another, and read back what the launcher would actually
  // be handed. That is where this bug lived: every part was right on its own and
  // two real boxes still ended up as one Plex device.
  const source = newBox("ls-source");
  const target = newBox("ls-target");
  const seed = path.join(TMP, "ls-clone.tvbackup");

  // The snapshot the launcher hands over is the whole ORIGIN's storage, so it
  // mixes its own keys with those of every local app - here a client identifier
  // and the login that came with it.
  const SNAPSHOT = JSON.stringify({
    "tvbox.locale": "hu",
    "tvbox.appPrefs": '{"order":["plex"]}',
    ClientID: "fsbet2zresma446qnnvt4kst",
    PlexAuthToken: "a-real-token",
  });

  await inBox(
    source,
    `const backup = mod("backup");
    const identity = mod("identity");
    identity.machineId = () => "1111111111111111";
    const payload = backup.collect({ localStorage: ${JSON.stringify(SNAPSHOT)} }, { clone: true });
    fs.writeFileSync(${JSON.stringify(seed)}, JSON.stringify(backup.encrypt(payload, "pw-1234")));
    out({ machineId: payload.machineId, carried: !!payload.localStorage });`,
  );

  const b = await inBox(
    target,
    `const backup = mod("backup");
    const identity = mod("identity");
    identity.machineId = () => "2222222222222222";
    const payload = backup.decrypt(JSON.parse(fs.readFileSync(${JSON.stringify(seed)}, "utf8")), "pw-1234");
    backup.apply(payload);
    const parked = backup.pendingLocalStorage().data;
    out({ keys: parked ? Object.keys(JSON.parse(parked)).sort() : null });`,
  );

  assert.deepStrictEqual(b.keys, ["tvbox.appPrefs", "tvbox.locale"], "only the launcher's own keys are parked");
});

// ============================================================================
// The retry budget, against a registry that is actually down.
// ============================================================================
test("a reconciliation that fails keeps retrying, then stops asking", async () => {
  registry.apps = [app("tunes")];
  registry.fail = true; // the box was restored while the registry was unreachable
  const box = newBox("offline");

  const r = await inBox(
    box,
    `${RECONCILE_IO}
    const TVBOX = path.join(process.env.HOME, ".tvbox");
    fs.writeFileSync(path.join(TVBOX, "config.json"), JSON.stringify({ store: { registry: ${JSON.stringify(registryUrl())} } }));
    reconcile.record([{ id: "tunes" }], "restore");
    const rounds = [];
    for (let i = 0; i < reconcile.MAX_ATTEMPTS + 1; i++) {
      const desired = reconcile.pending();
      if (!desired) { rounds.push({ round: i, gaveUp: true, retrying: "gave-up", attempts: null }); break; }
      const st = await reconcile.run(desired, io);
      const retrying = reconcile.settle(desired);
      const left = reconcile.pending();
      rounds.push({ round: i, failed: st.failed.length, retrying, attempts: left ? left.attempts : null });
    }
    out({ rounds });`,
  );

  // Three real failures, then it stops - so a permanently broken app does not
  // re-run at every tick forever.
  assert.equal(r.rounds[0].failed, 1, "the registry being down is a failure, and it is reported");
  assert.deepStrictEqual(
    r.rounds.map((x) => x.retrying),
    [true, true, false, "gave-up"],
  );
  assert.deepStrictEqual(
    r.rounds.map((x) => x.attempts),
    [1, 2, null, null],
    "the budget is spent one failure at a time",
  );
});

// ============================================================================
// An interruption is not a failure - the case that would otherwise throw a
// restored box's desired state away after three ordinary evenings.
// ============================================================================
test("a reconciliation interrupted by the user keeps its full retry budget", async () => {
  registry.apps = [app("tunes")];
  registry.fail = false;
  const box = newBox("interrupted");

  const r = await inBox(
    box,
    `${RECONCILE_IO}
    const TVBOX = path.join(process.env.HOME, ".tvbox");
    fs.writeFileSync(path.join(TVBOX, "config.json"), JSON.stringify({ store: { registry: ${JSON.stringify(registryUrl())} } }));
    reconcile.record([{ id: "tunes" }], "restore");
    const rounds = [];
    // Five times the box stops being free the moment the run starts.
    for (let i = 0; i < 5; i++) {
      const desired = reconcile.pending();
      const st = await reconcile.run(desired, { ...io, free: () => false });
      const retrying = reconcile.settle(desired);
      const left = reconcile.pending();
      rounds.push({ skipped: st.steps.filter((s) => s.state === "skipped").length, retrying, attempts: left ? left.attempts : null });
    }
    // ...and then the box is finally left alone.
    const desired = reconcile.pending();
    const st = await reconcile.run(desired, io);
    const retrying = reconcile.settle(desired);
    const apps2 = mod("install");
    apps2.loadManifests();
    out({ rounds, finalFailed: st.failed, retrying, installed: apps2.getManifests().map((m) => m.id) });`,
  );

  for (const [i, round] of r.rounds.entries()) {
    assert.equal(round.skipped, 1, `round ${i}: the step stood down`);
    assert.equal(round.retrying, true, `round ${i}: it will come back`);
    assert.equal(round.attempts, 0, `round ${i}: an interruption must not spend the budget`);
  }
  assert.deepStrictEqual(r.finalFailed, [], "and when the box is free, it finishes");
  assert.equal(r.retrying, false);
  assert.deepStrictEqual(r.installed, ["tunes"]);
});
