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

test("no stamp: a process with the local token is local; a bare request or a browser is not", () => {
  apigate.setLocalToken("tok-123");
  assert.deepStrictEqual(apigate.identify(reqWith({ host: "127.0.0.1:8097", "x-tvbox-local": "tok-123" })), local);
  assert.deepStrictEqual(apigate.identify(reqWith({ host: "127.0.0.1:8097" })), unknown, "mpv sends nothing");
  assert.deepStrictEqual(apigate.identify(reqWith({ "x-tvbox-local": "tok-124" })), unknown);
  assert.deepStrictEqual(
    apigate.identify(reqWith({ "x-tvbox-local": "tok-123", "sec-fetch-site": "same-origin" })),
    unknown,
    "a page that somehow has the token is still a page",
  );
  assert.deepStrictEqual(apigate.identify(reqWith({ origin: "http://localhost:8097" })), unknown);
  const req = reqWith({ "x-tvbox-local": "tok-123" });
  apigate.identify(req);
  assert.strictEqual(req.headers["x-tvbox-local"], undefined, "no handler sees the token");
  assert.deepStrictEqual(Object.keys(apigate.stamp({ "X-Tvbox-Local": "tok-123" }, "launcher")), ["X-Tvbox-Caller"]);
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

test("an unidentified caller gets public reads, and a plugin's routes only as the plugin declared", () => {
  assert.strictEqual(decide(unknown, "GET", "/tvbox/api/config"), null);
  assert.ok(decide(unknown, "GET", "/tvbox/api/wifi/list"));
  assert.ok(decide(unknown, "POST", "/tvbox/api/notify"));
  // A plugin that declared its public routes: only those.
  const cb = { pluginOwner: "spotify", pluginOpen: true };
  const closed = { pluginOwner: "livetv", pluginOpen: false };
  assert.strictEqual(decide(unknown, "GET", "/tvbox/api/spotify/auth/callback", cb), null);
  assert.ok(decide(unknown, "GET", "/tvbox/api/livetv/channels", closed));
  assert.ok(decide(unknown, "POST", "/tvbox/api/livetv/save", closed));
  // One that declared nothing keeps the old answer, writes included.
  const legacy = { pluginOwner: "spotify", pluginOpen: "legacy" };
  assert.strictEqual(decide(unknown, "GET", "/tvbox/api/spotify/liked", legacy), null);
  assert.strictEqual(decide(unknown, "POST", "/tvbox/api/spotify/event", legacy), null);
  // And an app is never helped by the declaration: another app's route stays shut.
  assert.ok(decide(app("files"), "GET", "/tvbox/api/spotify/auth/callback", cb));
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

test("a LAN server answers to the box's own names and addresses only", () => {
  const os = require("os");
  const ok = (host) => apigate.lanHostAllowed({ headers: { host } }, 8099);
  assert.strictEqual(ok("127.0.0.1:8099"), true);
  assert.strictEqual(ok(os.hostname().toLowerCase() + ".local:8099"), true);
  const v4 = Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4");
  if (v4) assert.strictEqual(ok(v4.address + ":8099"), true);
  assert.strictEqual(ok("rebind.example:8099"), false);
});

test("a router's LAN name and a zoned link-local address reach a LAN server; a public suffix does not", () => {
  const os = require("os");
  const host = os.hostname().toLowerCase();
  const ok = (h) => apigate.lanHostAllowed({ headers: { host: h } }, 8099);
  assert.strictEqual(ok(host + ".lan:8099"), true);
  assert.strictEqual(ok(host + ".home.arpa:8099"), true);
  assert.strictEqual(ok(host + ".attacker.example:8099"), false);
  assert.strictEqual(apigate.hostAllowed({ headers: { host: "[fe80::1%25wlan0]:8099" } }, ["fe80::1"], 8099), true);
});

test("the network's announced search domains are read from resolv.conf", () => {
  const text = "nameserver 10.0.0.1\nsearch fritz.box Corp.Example.\ndomain lan\n# search nope\n";
  assert.deepStrictEqual(
    apigate.announcedSuffixes(() => text),
    ["fritz.box", "corp.example", "lan"],
  );
  assert.deepStrictEqual(
    apigate.announcedSuffixes(() => {
      throw new Error("ENOENT");
    }),
    [],
  );
});

test("only a local app may register a service worker, and only inside its own folder", () => {
  const local = (id) => id === "files";
  assert.strictEqual(apigate.serviceWorkerAllowed("/files/sw.js", local), true);
  assert.strictEqual(apigate.serviceWorkerAllowed("/sw.js", local), false, "the root app's scope covers the launcher");
  assert.strictEqual(
    apigate.serviceWorkerAllowed("/tvbox/sw.js", () => true),
    false,
  );
  assert.strictEqual(apigate.serviceWorkerAllowed("/other/sw.js", local), false);
  assert.strictEqual(apigate.serviceWorkerAllowed("/files", local), false);
  assert.strictEqual(
    apigate.serviceWorkerAllowed("/../sw.js", () => true),
    false,
  );
});

test("an app changes the PIN, or whether it is asked for, only with the current PIN", () => {
  const caps = ["config"];
  const pinOk = (p) => p === "4321";
  const post = (parental) =>
    decide(app("livetv"), "POST", "/tvbox/api/config", { body: { parental }, caps, parentalPinOk: pinOk });
  assert.strictEqual(post({ lockedGroups: ["adult"] }), null, "the groups need no PIN");
  assert.ok(post({ pin: "" }), "clearing the PIN without it is refused");
  assert.ok(post({ requirePin: false }));
  assert.ok(post({ pin: "1111", currentPin: "0000" }));
  assert.strictEqual(post({ pin: "1111", currentPin: "4321" }), null);
  assert.ok(decide(app("livetv"), "POST", "/tvbox/api/config", { body: { parental: { pin: "" } }, caps }));
});

test("a player URL is refused only when it aims at one of the shell's own servers", () => {
  assert.strictEqual(apigate.pointsAtThisBox("http://127.0.0.1:8097/tvbox/api/apps"), true);
  assert.strictEqual(apigate.pointsAtThisBox("http://localhost:8099/"), true);
  assert.strictEqual(apigate.pointsAtThisBox("http://localhost.:8100/"), true, "a trailing dot is the same host");
  assert.strictEqual(apigate.pointsAtThisBox("http://[::1]:8098/x"), true);
  // A media server running on the box itself is a thing the box plays.
  assert.strictEqual(apigate.pointsAtThisBox("http://127.0.0.1:8096/Videos/1/stream"), false);
  assert.strictEqual(apigate.pointsAtThisBox("http://localhost:32400/library/parts/1/file.mkv"), false);
  assert.strictEqual(apigate.pointsAtThisBox("http://127.0.0.1/"), false, "port 80 is not ours");
  // An authority two URL parsers could read differently is refused outright.
  assert.strictEqual(apigate.pointsAtThisBox("http://evil.invalid\\@127.0.0.1:8097/"), true);
  assert.strictEqual(apigate.pointsAtThisBox("http://user:pass@nas.example/film.mkv"), false, "credentials are fine");
  assert.strictEqual(apigate.pointsAtThisBox("http://user:pass@127.0.0.1:8097/"), true);
  assert.strictEqual(apigate.pointsAtThisBox("https://example.com/film.mkv"), false);
  // Ports that come from config.
  apigate.setOwnPorts(() => [9222]);
  assert.strictEqual(apigate.pointsAtThisBox("http://127.0.0.1:9222/json"), true);
  apigate.setOwnPorts(null);
  assert.strictEqual(apigate.pointsAtThisBox("http://127.0.0.1:9222/json"), false);
});

test("an app may add to the parental lock, but taking a group off needs the PIN", () => {
  const base = { caps: ["config"], lockedGroups: ["adult", "news"], parentalPinOk: (p) => p === "4321" };
  const write = (parental) => decide(app("livetv"), "POST", "/tvbox/api/config", { ...base, body: { parental } });
  assert.strictEqual(write({ lockedGroups: ["adult", "news", "sport"] }), null, "adding is free");
  assert.ok(write({ lockedGroups: [] }), "emptying the lock is not");
  assert.ok(write({ lockedGroups: ["adult"] }));
  assert.ok(write({ lockedGroups: null }));
  assert.strictEqual(write({ lockedGroups: [], currentPin: "4321" }), null, "with the PIN it may");
});

test("the box's own LAN address written as IPv4-mapped IPv6 is still the box", () => {
  const os = require("os");
  let ip = null;
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (!ip && a.family === "IPv4" && !a.internal) ip = a.address;
  if (!ip) return; // a host with no LAN address has nothing to map
  const p = ip.split(".").map(Number);
  const hex = ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  assert.strictEqual(apigate.pointsAtThisBox("http://[::ffff:" + ip + "]:8100/"), true);
  assert.strictEqual(apigate.pointsAtThisBox("http://[::ffff:" + hex + "]:8098/"), true);
  assert.strictEqual(apigate.pointsAtThisBox("http://[::ffff:" + hex + "]:8888/"), false, "not a shell port");
  assert.strictEqual(apigate.pointsAtThisBox("http://[::ffff:8.8.8.8]:8097/"), false, "not the box");
});
