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
