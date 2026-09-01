// The write API's dispatch and the guards on it.
//
// This became testable by moving out of main.js: `post` takes the request, the
// body, a response and the shell's context, so a fake context is a whole box.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Config writes land in a real file, so give this test its own box.
const REAL_HOME = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-routes-"));
fs.mkdirSync(path.join(home, ".tvbox"), { recursive: true });
process.env.HOME = home;

const routes = require("./routes");
const system = require("./system");

function fakeRes() {
  const res = {
    status: 200,
    body: null,
    writeHead(status) {
      res.status = status;
    },
    end(body) {
      res.body = String(body || "");
    },
  };
  return res;
}

// Some routes answer only after a couple of async hops (the boot config, then
// nmcli), so the test has to wait for the response rather than read it straight
// after the call returns.
function wrapRes(res, done) {
  const end = res.end;
  res.end = (body) => {
    end(body);
    done();
  };
  return res;
}

// The shell, as far as a route can tell.
function fakeCtx(over = {}) {
  return {
    appIsRunning: () => false,
    applyAppshares: () => ({ ok: true }),
    adoptShareKey: () => {},
    revokeShareKey: () => {},
    appsharesStatus: () => ({ running: false, shares: [] }),
    applyFileserver: () => ({ ok: true }),
    applyMqttConfig: () => {},
    publishIrDiscovery: () => {},
    notify: () => {},
    audioSink: () => null,
    childEnv: () => process.env,
    destroyAppWindow: () => {},
    clearNowPlaying: () => {},
    unloadPlugin: () => {},
    dmode: { rearm: () => {}, refresh: (cb) => cb && cb(true, "") },
    emitConfigChange: () => {},
    ensureAudio: (done) => done && done(),
    exitApp: () => {},
    fileserverStatus: () => ({ running: false }),
    applyShares: () => ({ ok: true }),
    sharesDeps: {
      onPath: () => true,
      childEnv: () => process.env,
      supervisor: { names: () => [], spawn() {}, stop() {} },
    },
    sharesStatus: () => ({ rclone: true, shares: [] }),
    mirroring: {
      start: (cb) => cb && cb(null, { name: "tvbox" }),
      stop: (cb) => cb && cb(null),
      state: () => ({}),
      isArmed: () => false,
      isStreaming: () => false,
    },
    foregroundApp: () => null,
    handlePower: () => {},
    installRclone: () => false,
    navTo: () => {},
    navToLauncher: () => {},
    publishMediaState: () => {},
    publishNowPlaying: () => {},
    remoteBridgeCmd: () => {},
    setNowPlaying: () => {},
    setSleepTimer: () => ({ ok: true }),
    setWidget: () => {},
    showLauncher: () => {},
    switchApp: () => {},
    ...over,
  };
}

const jsonOf = (res) => JSON.parse(res.body);

test("a JSON null body is a refusal, not a dead shell", () => {
  // `null` is valid JSON, so it reaches a route as the body. Every route reads a
  // field off it immediately, and a TypeError here kills the shell: nothing
  // catches it. Any page on our own origin can send this.
  for (const p of ["/tvbox/api/config", "/tvbox/api/nav", "/tvbox/api/wifi/radio", "/tvbox/api/bt/pair"]) {
    assert.doesNotThrow(() => routes.post(p, null, fakeRes(), fakeCtx()), p);
  }
});

test("a bluetooth action is looked up among own properties only", () => {
  // The action is a path segment. `__proto__` names something every object has,
  // and it is truthy and not callable - the shape that gets past a `!fn` guard and
  // then throws.
  for (const action of ["__proto__", "constructor", "toString", "nope"]) {
    const res = fakeRes();
    assert.doesNotThrow(() => routes.post("/tvbox/api/bt/" + action, { mac: "AA:BB:CC:DD:EE:FF" }, res, fakeCtx()));
    assert.strictEqual(res.status, 404, action);
  }
});

// The context is a seam between two files and nothing at runtime checks it: a
// route that asks for something main.js does not provide throws TypeError, and
// what the caller gets back is a 500 with the route's own work half done. That is how
// POST /tvbox/api/audio/default shipped broken; the fake below had the same gap,
// so the tests agreed with the bug.
function ctxKeysFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notStrictEqual(start, -1, "cannot find " + marker);
  const end = source.indexOf("\n  };", start);
  const body = source.slice(start, end === -1 ? source.indexOf("\n};", start) : end);
  return new Set([...body.matchAll(/^\s{2,4}([a-zA-Z_]+)[,:]/gm)].map((m) => m[1]));
}

test("arming screen mirroring reports a refusal instead of pretending it worked", () => {
  // The helper answers with a CODE and the launcher translates it - a sentence
  // from a shell script would reach a Hungarian TV in English. What matters here
  // is that it travels at all: "nothing happened" is the worst possible answer on
  // a device with only a remote.
  const why = "radio-busy";
  const res = fakeRes();
  routes.post(
    "/tvbox/api/miracast/start",
    {},
    res,
    fakeCtx({ mirroring: { start: (cb) => cb(new Error(why)), stop: (cb) => cb() } }),
  );
  assert.strictEqual(jsonOf(res).ok, false);
  assert.strictEqual(jsonOf(res).error, "radio-busy");

  const ok = fakeRes();
  routes.post("/tvbox/api/miracast/start", {}, ok, fakeCtx());
  assert.strictEqual(jsonOf(ok).ok, true);
  assert.strictEqual(jsonOf(ok).name, "tvbox", "the name a phone will look for comes back for the UI to show");
});

test("the list of shares being offered is the on/off switch, and it is applied at once", () => {
  const config = require("./config");
  let applied = 0;
  const ctx = fakeCtx({ applyAppshares: () => (applied++, { ok: true }) });
  const res = fakeRes();
  routes.post("/tvbox/api/appshares", { enabled: ["retroarch/saves"] }, res, ctx);
  assert.deepStrictEqual(config.rawAppshares().enabled, ["retroarch/saves"]);
  assert.strictEqual(applied, 1, "a setting nobody can see the effect of is a trap");
  routes.post("/tvbox/api/appshares", { enabled: [] }, fakeRes(), ctx);
  assert.deepStrictEqual(config.rawAppshares().enabled, [], "an empty list is how it is off");
});

test("a peer is dropped by name, and its token goes with it", () => {
  const config = require("./config");
  const peer = { id: "tvbox-gaming", name: "gaming", host: "192.168.1.7", port: 8096, token: "tok" };
  config.setAppshares({ peers: [peer] });
  const res = fakeRes();
  routes.post("/tvbox/api/appshares/peer-remove", { id: "tvbox-gaming" }, res, fakeCtx());
  assert.deepStrictEqual(config.rawAppshares().peers, []);
  assert.deepStrictEqual(jsonOf(res).peers, [], "and the answer never carries a token");
});

test("the write API has no way to bring files across", () => {
  // The only path is the `shares` capability, which is scoped to the calling app.
  // An HTTP route would not be: every local app shares the shell's origin, so one
  // could ask for another app's share.
  const res = fakeRes();
  routes.post("/tvbox/api/appshares/pull", { peerId: "b", shareId: "retroarch/saves" }, res, fakeCtx());
  assert.strictEqual(res.status, 404);
});

test("every ctx member a route uses is one the shell actually provides", () => {
  const used = new Set(
    [...fs.readFileSync(path.join(__dirname, "routes.js"), "utf8").matchAll(/ctx\.([a-zA-Z_]+)/g)].map((m) => m[1]),
  );
  const provided = ctxKeysFrom(fs.readFileSync(path.join(__dirname, "main.js"), "utf8"), "const routeCtx = {");

  const missing = [...used].filter((name) => !provided.has(name));
  assert.deepStrictEqual(missing, [], "main.js's routeCtx is missing these");

  // And the fake in this file has to keep up, or a route can be broken in a way
  // every test here still passes.
  const faked = new Set(Object.keys(fakeCtx()));
  assert.deepStrictEqual(
    [...used].filter((name) => !faked.has(name)),
    [],
  );
  // Nothing the shell hands over should be dead weight either.
  assert.deepStrictEqual(
    [...provided].filter((name) => !used.has(name)),
    [],
  );
});

test("an on-screen note is capped before the launcher ever sees it", () => {
  const seen = [];
  const res = fakeRes();
  routes.post(
    "/tvbox/api/notify",
    { title: "t".repeat(400), message: "m".repeat(900), duration: 999999, raise: 1 },
    res,
    fakeCtx({ notify: (n) => seen.push(n) }),
  );
  assert.strictEqual(jsonOf(res).ok, true);
  // The launcher draws what it is given, and an answer from a language model is
  // not a length anyone promised - so the cap is here, not there.
  assert.strictEqual(seen[0].title.length, 120);
  assert.strictEqual(seen[0].message.length, 400);
  assert.strictEqual(seen[0].duration, 60000);
  assert.strictEqual(seen[0].raise, true);
});

test("a path with no route is a 404, not a silent success", () => {
  const res = fakeRes();
  routes.post("/tvbox/api/does-not-exist", {}, res, fakeCtx());
  assert.strictEqual(res.status, 404);
});

test("a config write answers with the PUBLIC config, never the secrets", () => {
  const res = fakeRes();
  routes.post("/tvbox/api/config", { ui: { clock24: true } }, res, fakeCtx());

  const body = jsonOf(res);
  assert.strictEqual(body.ok, true);
  // publicConfig is the launcher's whole view of the box; a route answering with
  // the raw config would hand it the IPTV password and the parental PIN hash.
  assert.ok(body.config, "the answer carries a config");
  assert.strictEqual(JSON.stringify(body.config).includes("password"), false);
});

test("the config fan-out names the sections that moved, and only those", () => {
  // It is what makes a plugin drop its cache - Live TV throws away its channel
  // list on a new IPTV source - so a save that touched the UI must not say iptv.
  let told = null;
  const ctx = fakeCtx({ emitConfigChange: (s) => (told = s) });

  routes.post("/tvbox/api/config", { ui: { clock24: true } }, fakeRes(), ctx);
  assert.deepStrictEqual(told, ["ui"]);

  routes.post("/tvbox/api/config", {}, fakeRes(), ctx);
  assert.deepStrictEqual(told, [], "a save that changed nothing invalidates nothing");
});

test("the wifi radio is never turned off by a malformed body", async () => {
  // `data.on === true` would read a missing field, the string "false" and a JSON
  // null body as "turn it off" - the one direction that can take the box off the
  // network with nothing left to undo it.
  const ran = [];
  system.init({
    execFile: (cmd, args, opts, cb) => {
      ran.push([cmd].concat(args).join(" "));
      const done = typeof opts === "function" ? opts : cb;
      setImmediate(() => done(null, "", ""));
    },
  });

  for (const body of [{}, { on: "false" }, { on: 0 }, null]) {
    const res = fakeRes();
    routes.post("/tvbox/api/wifi/radio", body, res, fakeCtx());
    assert.strictEqual(jsonOf(res).error, "bad-request", JSON.stringify(body));
  }
  assert.deepStrictEqual(ran, [], "nothing may reach nmcli for a body that is not a boolean");
});

test("the built-in radio route refuses a body that is not a boolean", () => {
  const started = [];
  const radio = require("./builtinradio");
  const realApply = radio.apply;
  radio.apply = (a, cb) => {
    started.push(a);
    cb(null);
  };
  for (const body of [{}, { radio: "wifi" }, { radio: "wifi", on: "false" }, { radio: "zigbee", on: false }, null]) {
    const res = fakeRes();
    routes.post("/tvbox/api/radios", body, res, fakeCtx());
    assert.strictEqual(jsonOf(res).error, "bad-request", JSON.stringify(body));
  }
  radio.apply = realApply;
  assert.deepStrictEqual(started, [], "nothing may reach systemd for a malformed body");
});

test("turning off the second radio on a cableless box asks first", async () => {
  // Both radios off with no cable leaves nothing that can reach the box, and it
  // survives a reboot - so this one state costs a confirmation. It is NOT a
  // refusal: the second press carries `confirm` and goes through.
  const radio = require("./builtinradio");
  const real = { apply: radio.apply, readState: radio.readState };
  const started = [];
  radio.readState = (cb) => cb({ readable: true, wifi: "on", bt: "off" });
  radio.apply = (a, cb) => {
    started.push(a);
    cb(null);
  };
  system.init({
    execFile: (cmd, args, opts, cb) => {
      const done = typeof opts === "function" ? opts : cb;
      // No carrier: nmcli reports the wired device disconnected.
      setImmediate(() => done(null, "eth0:ethernet:unavailable:\n", ""));
    },
  });

  const asked = fakeRes();
  await new Promise((r) => {
    routes.post("/tvbox/api/radios", { radio: "wifi", on: false }, wrapRes(asked, r), fakeCtx());
  });
  assert.strictEqual(jsonOf(asked).error, "needs-confirm");
  assert.deepStrictEqual(started, [], "and nothing was applied");

  const confirmed = fakeRes();
  await new Promise((r) => {
    routes.post("/tvbox/api/radios", { radio: "wifi", on: false, confirm: true }, wrapRes(confirmed, r), fakeCtx());
  });
  assert.strictEqual(jsonOf(confirmed).ok, true);
  assert.deepStrictEqual(started, [{ radio: "wifi", on: false }]);

  radio.apply = real.apply;
  radio.readState = real.readState;
});

test("turning a radio back ON is never gated", async () => {
  const radio = require("./builtinradio");
  const real = { apply: radio.apply, readState: radio.readState };
  const started = [];
  radio.readState = (cb) => cb({ readable: true, wifi: "off", bt: "off" });
  radio.apply = (a, cb) => {
    started.push(a);
    cb(null);
  };
  const res = fakeRes();
  await new Promise((r) => {
    routes.post("/tvbox/api/radios", { radio: "wifi", on: true }, wrapRes(res, r), fakeCtx());
  });
  assert.strictEqual(jsonOf(res).ok, true);
  assert.deepStrictEqual(started, [{ radio: "wifi", on: true }]);
  radio.apply = real.apply;
  radio.readState = real.readState;
});

// A switch an app declared in its manifest, flipped from Settings. The value lands
// in the box's config and the app's own plugin acts on it, so the manifest is the
// only thing that may decide a key exists.
test("an app switch is written only for a key its installed manifest declares", async () => {
  const config = require("./config");
  const apps = require("./install");
  const dir = path.join(home, ".tvbox", "apps");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "youtube.json"),
    JSON.stringify({
      id: "youtube",
      name: "YouTube",
      type: "webclient",
      status: "ready",
      // A switch is only offered with a plugin to act on it, so the manifest that
      // declares one has to carry the service too - the validator refuses it
      // otherwise, and a refused manifest takes the whole app off the box.
      service: "youtube",
      switches: [{ key: "cast", label: "Cast", default: true }],
    }),
  );
  apps.loadManifests();

  let told = null;
  const ctx = fakeCtx({ emitConfigChange: (s) => (told = s) });
  const off = fakeRes();
  await new Promise((r) => {
    routes.post("/tvbox/api/apps/switch", { id: "youtube", key: "cast", on: false }, wrapRes(off, r), ctx);
  });
  assert.strictEqual(jsonOf(off).ok, true);
  assert.strictEqual(config.appSwitches("youtube").cast, false);
  // The plugin is what turns the thing off, and it learns about it from a config
  // change - without this the box would need a restart to catch up.
  assert.ok(told && told.length, "plugins were not told");

  // Undeclared key, unknown app, and a value that is not a boolean: none of them
  // may reach the config file.
  for (const body of [
    { id: "youtube", key: "somethingelse", on: true },
    { id: "nosuchapp", key: "cast", on: true },
    { id: "youtube", key: "cast", on: "true" },
    { id: "youtube", key: "__proto__", on: true },
  ]) {
    const res = fakeRes();
    await new Promise((r) => {
      routes.post("/tvbox/api/apps/switch", body, wrapRes(res, r), fakeCtx());
    });
    assert.strictEqual(jsonOf(res).ok, false, JSON.stringify(body));
  }
  assert.strictEqual(config.appSwitches("youtube").cast, false, "the stored value is untouched");
  assert.strictEqual(Object.keys(config.appSwitches("youtube")).length, 1, "and nothing else was written");
});

test("uninstalling an app stops its plugin, not only its window", async () => {
  // A window is ours to destroy; a daemon or a socket on the LAN belongs to the
  // plugin, and only its own `stop` releases it. Without this the receiver keeps
  // listening after the app is gone - and its switch has left Settings with it, so
  // there is nothing left to turn off.
  const called = [];
  const ctx = fakeCtx({
    unloadPlugin: (id) => called.push(id),
    destroyAppWindow: (id) => called.push("window:" + id),
  });
  const res = fakeRes();
  await new Promise((r) => {
    routes.post("/tvbox/api/store/uninstall", { id: "youtube" }, wrapRes(res, r), ctx);
  });
  assert.deepStrictEqual(called, ["window:youtube", "youtube"], "window first, then the plugin");
});

test.after(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});
