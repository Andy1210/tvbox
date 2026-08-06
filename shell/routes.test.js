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

// The shell, as far as a route can tell.
function fakeCtx(over = {}) {
  return {
    appIsRunning: () => false,
    applyFileserver: () => ({ ok: true }),
    applyMqttConfig: () => {},
    audioSink: () => null,
    childEnv: () => process.env,
    destroyAppWindow: () => {},
    dmode: { rearm: () => {}, refresh: (cb) => cb && cb(true, "") },
    emitConfigChange: () => {},
    ensureAudio: (done) => done && done(),
    exitApp: () => {},
    fileserverStatus: () => ({ running: false }),
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
// route that asks for something main.js does not provide throws TypeError inside
// the request handler, which has no try/catch above it and no uncaughtException
// handler behind it - the shell dies and the session respawns it. That is how
// POST /tvbox/api/audio/default shipped broken; the fake below had the same gap,
// so the tests agreed with the bug.
function ctxKeysFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notStrictEqual(start, -1, "cannot find " + marker);
  const end = source.indexOf("\n  };", start);
  const body = source.slice(start, end === -1 ? source.indexOf("\n};", start) : end);
  return new Set([...body.matchAll(/^\s{2,4}([a-zA-Z_]+)[,:]/gm)].map((m) => m[1]));
}

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

test.after(() => {
  process.env.HOME = REAL_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});
