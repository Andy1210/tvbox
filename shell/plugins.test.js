// The plugin registry: what a plugin may register, and that an unload really
// takes it away.
//
// The three registries here are the ones an uninstall has to reach, and each of
// them was a way for a stopped plugin to come back or to keep answering. None of
// that could be tested while it lived in main.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const plugins = require("./plugins");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-plugins-"));

// Write a package with a plugin.js that does whatever the case needs. `body` is
// the factory's function body, with `host` in scope.
let seq = 0;
function pkg(id, body, extra) {
  const dir = path.join(root, id + "-" + ++seq);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.js"), "module.exports = (host) => {" + body + "};");
  return { id, name: id, status: "ready", service: id, _dir: dir, ...(extra || {}) };
}

function boot(manifests, opts) {
  const o = opts || {};
  const calls = [];
  plugins.init({
    apps: {
      getManifests: () => manifests,
      manifestById: (id) => manifests.find((m) => m.id === id) || null,
      appDeps: (m) => ({ depsOk: !(o.missing || {})[m.id], missing: (o.missing || {})[m.id] || [] }),
    },
    host: { calls, ...(o.host || {}) },
    setWidget: (id, w) => calls.push(["widget", id, w]),
    switchValue: (m, key) => !!((o.switches || {})[m.id] || {})[key],
  });
  return calls;
}

// ---- guardList: a guard that names nothing is the bug this exists to prevent ----

test("no guard at all is an empty list", () => {
  assert.deepEqual(plugins.guardList(undefined, {}), []);
  assert.deepEqual(plugins.guardList({}, {}), []);
  assert.deepEqual(plugins.guardList({ guard: null }, {}), []);
});

test("a guard naming a real GET handler is kept", () => {
  const table = { "GET /state": () => {}, "POST /play": () => {} };
  assert.deepEqual(plugins.guardList({ guard: ["GET /state"] }, table), ["GET /state"]);
});

test("a guard that names no route in the table throws, rather than guarding nothing", () => {
  // `guard: ["GET /waitTime"]` beside a table defining "GET /waittime" matches
  // nothing, and the costly read would stay open with nothing saying so.
  const table = { "GET /waittime": () => {} };
  assert.throws(() => plugins.guardList({ guard: ["GET /waitTime"] }, table), /names no route/);
  assert.throws(() => plugins.guardList({ guard: [42] }, table), /names no route/);
  assert.throws(() => plugins.guardList({ guard: ["GET /state"] }, undefined), /names no route/);
});

test("a guard has to be an array, and may only name a GET", () => {
  const table = { "GET /a": () => {}, "POST /b": () => {} };
  assert.throws(() => plugins.guardList({ guard: "GET /a" }, table), /must be an array/);
  assert.throws(() => plugins.guardList({ guard: ["POST /b"] }, table), /only a GET needs guarding/);
});

// ---- config listeners ----

test("a listener that throws does not stop the ones behind it", () => {
  boot([]);
  const seen = [];
  plugins.onConfigChange(() => {
    throw new Error("boom");
  });
  plugins.onConfigChange((s) => seen.push(s));
  plugins.emitConfigChange(["iptv"]);
  assert.deepEqual(seen, [["iptv"]]);
});

test("an empty change list notifies nobody", () => {
  boot([]);
  let n = 0;
  plugins.onConfigChange(() => n++);
  plugins.emitConfigChange([]);
  plugins.emitConfigChange(null);
  assert.equal(n, 0);
});

test("a non-function registration is ignored rather than stored", () => {
  boot([]);
  plugins.onConfigChange("not a function");
  plugins.emitConfigChange(["x"]); // would throw if it had been stored
});

// ---- loading ----

test("a plugin loads, and its routes and listeners arrive tagged with its app", () => {
  const m = pkg(
    "radio",
    'host.registerRoutes("/tvbox/api/radio", { "GET /x": () => {} }); return { start(){}, stop(){} };',
  );
  boot([m]);
  const before = plugins.routes().length;
  assert.ok(plugins.loadOne(m));
  assert.equal(plugins.isLoaded("radio"), true);
  assert.equal(plugins.routes().length, before + 1);
  assert.equal(plugins.routes()[plugins.routes().length - 1].id, "radio");
  plugins.unload("radio");
});

test("the same plugin does not load twice", () => {
  const m = pkg("dup", "return {};");
  boot([m]);
  assert.ok(plugins.loadOne(m));
  assert.equal(plugins.loadOne(m), null);
  plugins.unload("dup");
});

test("a plugin whose deps are missing is skipped", () => {
  const m = pkg("needy", "return {};");
  boot([m], { missing: { needy: ["librespot"] } });
  assert.equal(plugins.loadOne(m), null);
  assert.equal(plugins.isLoaded("needy"), false);
});

test("a manifest with a service but no package dir is malformed, not loaded", () => {
  boot([]);
  assert.equal(plugins.loadOne({ id: "x", service: "x" }), null);
});

test("a service name outside the id charset is refused", () => {
  const m = pkg("bad", "return {};");
  m.service = "../../etc/passwd";
  boot([m]);
  assert.equal(plugins.loadOne(m), null);
});

test("a factory that throws is logged, not rethrown at the shell", () => {
  const m = pkg("boom", 'throw new Error("nope");');
  boot([m]);
  assert.equal(plugins.loadOne(m), null);
  assert.equal(plugins.isLoaded("boom"), false);
});

test("a factory that returns nothing still counts as loaded", () => {
  const m = pkg("quiet", "return undefined;");
  boot([m]);
  assert.ok(plugins.loadOne(m));
  assert.equal(plugins.isLoaded("quiet"), true);
  plugins.unload("quiet");
});

test("a plugin writes its OWN card and reads its OWN switches", () => {
  const m = pkg("scoped", 'host.widget.set({ title: "x" }); host.log(host.switchOn("k")); return {};', {
    switches: [{ key: "k" }],
  });
  const calls = boot([m], { switches: { scoped: { k: true } }, host: { log: () => {} } });
  plugins.loadOne(m);
  assert.deepEqual(calls[0], ["widget", "scoped", { title: "x" }]);
  plugins.unload("scoped");
});

// ---- unloading: the three ways a plugin came back ----

test("unloading takes the plugin's routes and listeners with it", () => {
  const m = pkg(
    "gone",
    'host.registerRoutes("/tvbox/api/gone", { "GET /a": () => {} }); host.onConfigChange(() => { throw new Error("a dead listener answered"); }); return { stop(){} };',
  );
  boot([m]);
  plugins.loadOne(m);
  const withIt = plugins.routes().filter((r) => r.id === "gone").length;
  assert.equal(withIt, 1);
  assert.equal(plugins.unload("gone"), true);
  assert.equal(plugins.routes().filter((r) => r.id === "gone").length, 0);
  plugins.emitConfigChange(["anything"]); // the listener is gone, so nothing throws
  assert.equal(plugins.isLoaded("gone"), false);
});

test("its own stop runs BEFORE the handle is dropped, and a stop that throws still unloads", () => {
  const order = [];
  const m = pkg("st", 'return { stop(){ throw new Error("half-closed"); } };');
  boot([m]);
  plugins.loadOne(m);
  order.push(plugins.isLoaded("st"));
  assert.equal(plugins.unload("st"), true);
  assert.deepEqual(order, [true]);
  assert.equal(plugins.isLoaded("st"), false);
});

test("unloading something that was never loaded is false, not a throw", () => {
  boot([]);
  assert.equal(plugins.unload("nothing"), false);
});

test("the require cache is dropped for the WHOLE package dir, not just plugin.js", () => {
  const m = pkg("cached", 'require("./lib.js"); return {};');
  fs.writeFileSync(path.join(m._dir, "lib.js"), "module.exports = 1;");
  boot([m]);
  plugins.loadOne(m);
  const lib = path.join(m._dir, "lib.js");
  assert.ok(Object.keys(require.cache).includes(lib), "the package's own module should be cached while loaded");
  plugins.unload("cached");
  assert.ok(!Object.keys(require.cache).includes(lib), "an update's plugin.js must not get the old version's lib");
});

// ---- hot load: an update arrives through the same door as an install ----

test("hot-loading an already-loaded plugin replaces it", () => {
  const stops = [];
  const m = pkg(
    "hot",
    'return { start(){}, stop(){ require("fs").appendFileSync(process.env.TVBOX_TEST_LOG, "stop\\n"); } };',
  );
  const log = path.join(root, "hot.log");
  process.env.TVBOX_TEST_LOG = log;
  fs.writeFileSync(log, "");
  boot([m]);
  assert.equal(plugins.hotLoad("hot"), true);
  assert.equal(plugins.hotLoad("hot"), true, "an update reloads rather than standing down");
  assert.equal(fs.readFileSync(log, "utf8").trim(), "stop", "the old code's stop ran before the new code loaded");
  plugins.unload("hot");
  stops.length = 0;
});

test("an app with no service cannot be hot-loaded", () => {
  boot([{ id: "plain", status: "ready" }]);
  assert.equal(plugins.hotLoad("plain"), false);
  assert.equal(plugins.hotLoad("missing"), false);
});

// ---- call: a plugin's failure must not reach us ----

test("a synchronous throw is caught and reported as not-through", () => {
  assert.equal(
    plugins.call("x", "start", () => {
      throw new Error("no");
    }),
    false,
  );
});

test("`throw null` is caught too - reading .message off it would throw again", () => {
  assert.equal(
    plugins.call("x", "start", () => {
      throw null;
    }),
    false,
  );
});

test("a rejected promise is caught, and the call still reports it got through synchronously", async () => {
  // A rejection walks straight past a synchronous catch and lands as an unhandled
  // rejection in the main process.
  assert.equal(
    plugins.call("x", "start", () => Promise.reject(new Error("later"))),
    true,
  );
  await new Promise((r) => setTimeout(r, 10)); // an unhandled rejection would fail the run here
});

// ---- appClosed ----

test("appClosed reaches a plugin that has one, and nothing else", () => {
  const log = path.join(root, "closed.log");
  process.env.TVBOX_TEST_LOG = log;
  fs.writeFileSync(log, "");
  const m = pkg(
    "cl",
    'return { appClosed(){ require("fs").appendFileSync(process.env.TVBOX_TEST_LOG, "closed\\n"); } };',
  );
  const plain = pkg("plain2", "return {};");
  boot([m, plain]);
  plugins.loadOne(m);
  plugins.loadOne(plain);
  plugins.appClosed("cl");
  plugins.appClosed("plain2"); // no appClosed: a no-op, not a throw
  plugins.appClosed("never-loaded");
  assert.equal(fs.readFileSync(log, "utf8").trim(), "closed");
  plugins.unload("cl");
  plugins.unload("plain2");
});

test("a truthy non-function appClosed is not called", () => {
  // A plugin is somebody's JavaScript object; calling a truthy non-function would
  // throw out of here into the route that asked for the quit.
  const m = pkg("weird", 'return { appClosed: "yes" };');
  boot([m]);
  plugins.loadOne(m);
  plugins.appClosed("weird"); // must not throw
  plugins.unload("weird");
});
