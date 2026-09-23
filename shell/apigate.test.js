// Who may call which shell route. The launcher and the box's own processes keep
// what they had; an app window gets the documented app API and its own plugin.
const test = require("node:test");
const assert = require("node:assert");

const apigate = require("./apigate");

function reqWith(headers) {
  return { headers: { ...headers } };
}

const launcher = { kind: "launcher" };
const local = { kind: "local" };
const unknown = { kind: "unknown" };
const app = (id) => ({ kind: "app", id });

function decide(caller, method, path, extra) {
  return apigate.decide({ caller, method, path, ...(extra || {}) });
}

test("a stamp is read back, and removed so no handler sees the secret", () => {
  const stamped = apigate.stamp({ Accept: "*/*" }, "app:files");
  const req = reqWith({ "x-tvbox-caller": stamped["X-Tvbox-Caller"] });
  assert.deepStrictEqual(apigate.identify(req), { kind: "app", id: "files" });
  assert.strictEqual(req.headers["x-tvbox-caller"], undefined);
  assert.deepStrictEqual(apigate.identify(reqWith({ "x-tvbox-caller": apigate.stampValue("launcher") })), launcher);
});

test("a page cannot stamp itself: its own header is replaced, and a guessed one is unknown", () => {
  const out = apigate.stamp({ "X-TVBOX-CALLER": "whatever launcher", "x-tvbox-caller": "x" }, "app:evil");
  assert.deepStrictEqual(Object.keys(out), ["X-Tvbox-Caller"]);
  assert.deepStrictEqual(apigate.identify(reqWith({ "x-tvbox-caller": "wrongsecret launcher" })), unknown);
  assert.deepStrictEqual(apigate.identify(reqWith({ "x-tvbox-caller": "" })), unknown);
});

test("no stamp: a script is local, anything with browser headers is unknown", () => {
  assert.deepStrictEqual(apigate.identify(reqWith({ host: "127.0.0.1:8097" })), local);
  assert.deepStrictEqual(apigate.identify(reqWith({ "sec-fetch-site": "same-origin" })), unknown);
  assert.deepStrictEqual(apigate.identify(reqWith({ origin: "http://localhost:8097" })), unknown);
});

test("the launcher reaches everything, and pages are open to all", () => {
  assert.strictEqual(decide(launcher, "POST", "/tvbox/api/store/sources"), null);
  assert.strictEqual(decide(unknown, "GET", "/tvbox/"), null);
  assert.strictEqual(decide(app("files"), "GET", "/files/index.html"), null);
});

test("an app cannot add a registry, install, power the box or read backups", () => {
  for (const p of ["/tvbox/api/store/sources", "/tvbox/api/store/install", "/tvbox/api/power", "/tvbox/api/config/app"])
    assert.ok(decide(app("files"), "POST", p), p);
  for (const p of ["/tvbox/api/backup/pending-localstorage", "/tvbox/api/wifi/list", "/tvbox/api/firetvir/plan"])
    assert.ok(decide(app("files"), "GET", p), p);
});

test("an app keeps the documented app API", () => {
  for (const p of ["/tvbox/api/config", "/tvbox/api/system/info", "/tvbox/api/browse/list", "/tvbox/api/apps"])
    assert.strictEqual(decide(app("files"), "GET", p), null, p);
  for (const p of [
    "/tvbox/api/nowplaying",
    "/tvbox/api/notify",
    "/tvbox/api/browse/mount",
    "/tvbox/api/parental/verify",
  ])
    assert.strictEqual(decide(app("files"), "POST", p), null, p);
});

test("an app reaches its own plugin's routes and no other app's", () => {
  assert.strictEqual(decide(app("spotify"), "POST", "/tvbox/api/spotify/play", { pluginOwner: "spotify" }), null);
  assert.ok(decide(app("files"), "POST", "/tvbox/api/spotify/play", { pluginOwner: "spotify" }));
  assert.ok(decide(app("files"), "GET", "/tvbox/api/retroarch/folders", { pluginOwner: "retroarch" }));
  assert.ok(decide(app("files"), "GET", "/tvbox/api/x", { pluginOwner: null }), "a bare-host route is not an app's");
});

test("config writes need the capability, and only the app sections", () => {
  const body = { iptv: { mode: "m3u" } };
  assert.ok(decide(app("files"), "POST", "/tvbox/api/config", { body }));
  assert.strictEqual(decide(app("livetv"), "POST", "/tvbox/api/config", { body, caps: ["config"] }), null);
  assert.ok(decide(app("livetv"), "POST", "/tvbox/api/config", { body: { mqtt: {} }, caps: ["config"] }));
});

test("a pairing kind is opened only by the app that registered it, or a shared built-in", () => {
  const owners = { roms: "retroarch", iptv: "livetv", photoshare: null, text: null, backup: null };
  const pairingOwner = (k) => owners[k || "iptv"];
  const start = (id, kind) =>
    decide(app(id), "POST", "/tvbox/api/pairing/start", { body: kind ? { kind } : {}, pairingOwner });
  assert.strictEqual(start("retroarch", "roms"), null);
  assert.ok(start("files", "roms"), "another app's code is not for this app");
  assert.strictEqual(start("files", "photoshare"), null);
  assert.ok(start("files", "backup"), "a built-in the launcher owns");
  assert.strictEqual(start("livetv"), null, "the default kind resolves to its owner");
});

test("navigation is for the app in front, except bringing itself forward", () => {
  assert.strictEqual(decide(app("a"), "POST", "/tvbox/api/nav", { foreground: "a", body: { dest: "home" } }), null);
  assert.ok(decide(app("a"), "POST", "/tvbox/api/nav", { foreground: "b", body: { dest: "home" } }));
  assert.strictEqual(
    decide(app("a"), "POST", "/tvbox/api/nav", { foreground: "b", body: { dest: "app", app: "a" } }),
    null,
  );
  assert.ok(decide(app("a"), "POST", "/tvbox/api/apps/quit", { body: { id: "b" } }));
  assert.strictEqual(decide(app("a"), "POST", "/tvbox/api/apps/quit", { body: { id: "a" } }), null);
});

test("a local process keeps its reads and the writes it makes, nothing else", () => {
  for (const p of ["/tvbox/api/nav", "/tvbox/api/notify", "/tvbox/api/ir/send", "/tvbox/api/remote/reset"])
    assert.strictEqual(decide(local, "POST", p), null, p);
  assert.strictEqual(decide(local, "GET", "/tvbox/api/tv/standby"), null);
  assert.strictEqual(decide(local, "POST", "/tvbox/api/spotify/event", { pluginOwner: "spotify" }), null);
  assert.ok(decide(local, "POST", "/tvbox/api/store/sources"));
  assert.ok(decide(local, "GET", "/tvbox/api/backup/pending-localstorage"));
});

test("an unidentified browser caller gets public reads and a plugin's GETs only", () => {
  assert.strictEqual(decide(unknown, "GET", "/tvbox/api/config"), null);
  assert.strictEqual(decide(unknown, "GET", "/tvbox/api/spotify/auth/callback", { pluginOwner: "spotify" }), null);
  assert.ok(decide(unknown, "GET", "/tvbox/api/wifi/list"));
  assert.ok(decide(unknown, "POST", "/tvbox/api/notify"));
});

test("a Host that is not ours is refused (DNS rebinding)", () => {
  const ok = (host) => apigate.hostAllowed(reqWith({ host }), ["localhost", "127.0.0.1"], 8097);
  assert.strictEqual(ok("localhost:8097"), true);
  assert.strictEqual(ok("127.0.0.1:8097"), true);
  assert.strictEqual(ok("evil.example:8097"), false);
  assert.strictEqual(ok("127.0.0.1:80"), false);
  assert.strictEqual(ok("127.0.0.1"), false, "no port is port 80");
  assert.strictEqual(ok("[::1]:8097"), false);
  assert.strictEqual(apigate.hostAllowed(reqWith({ host: "[::1]:8097" }), ["::1"], 8097), true);
});
