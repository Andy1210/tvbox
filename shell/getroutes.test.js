// The read API's dispatch and the gate on it.
//
// This became testable by moving out of main.js's server callback: `get` takes the
// path, the request, a response and the shell's context, so a fake context is a
// whole box. The half worth pinning hardest is `guardedGet` - it decides which
// reads the same-origin gate covers, and an open GET is reachable from any page
// the box loads, through an <img> tag that carries no Origin header at all.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-getroutes-"));
fs.mkdirSync(path.join(home, ".tvbox"), { recursive: true });
process.env.HOME = home;

const getroutes = require("./getroutes");

function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers || null;
      res.headersSent = true;
    },
    end(body) {
      res.body = body === undefined ? "" : String(body);
    },
    on() {},
  };
  return res;
}

const ctx = () => ({
  childEnv: () => ({}),
  dmode: { state: () => ({ mode: "ui" }) },
  mirroring: { state: () => ({ name: "tvbox" }), isArmed: () => false, isStreaming: () => false },
  restoredAt: () => 12345,
  readBridgeJson: (name) => (name === "remote-devices.json" ? { devices: [{ id: "aa" }] } : null),
  sleepTimer: () => 999,
  widgetList: () => [{ id: "spotify", title: "x" }],
  appTiles: () => [{ id: "plex" }],
  rootWebApp: () => null,
  launcherDir: path.join(home, "launcher-dist"),
});

// ---- the gate ----

test("the reads that cost something are gated", () => {
  // Each of these forks a process, drives an outbound fetch, or stops playback.
  for (const p of [
    "/tvbox/api/tv/standby",
    "/tvbox/api/firetvir/status",
    "/tvbox/api/firetvir/brand",
    "/tvbox/api/browse/sources",
    "/tvbox/api/browse/thumb",
    "/tvbox/api/photoshare",
    "/tvbox/api/photoshare/image",
    "/tvbox/api/remote/finder/capable",
  ]) {
    assert.equal(getroutes.guardedGet(p), true, p);
  }
});

test("the side-effect-free reads stay open - blocking them would break <img> and no-CORS uses", () => {
  for (const p of [
    "/tvbox/api/config",
    "/tvbox/api/apps",
    "/tvbox/api/widgets",
    "/tvbox/api/wifi/status",
    "/tvbox/api/system/info",
    "/tvbox/api/ambient/photo",
    "/tvbox/api/store/list",
    "/tvbox/",
    "/",
  ]) {
    assert.equal(getroutes.guardedGet(p), false, p);
  }
});

test("the gate is not a prefix of a longer path by accident", () => {
  assert.equal(getroutes.guardedGet("/tvbox/api/tv/standbyish"), false);
  assert.equal(getroutes.guardedGet("/tvbox/api/remote/finder/capableish"), false);
  assert.equal(getroutes.guardedGet("/tvbox/api/remote/devices"), false);
});

// ---- dispatch ----

test("a path no route claims is declined, so the files get their turn", () => {
  assert.equal(getroutes.get("/tvbox/index.html", { url: "/tvbox/index.html" }, fakeRes(), ctx()), false);
  assert.equal(getroutes.get("/", { url: "/" }, fakeRes(), ctx()), false);
  assert.equal(getroutes.get("/tvbox/api/nope", { url: "/x" }, fakeRes(), ctx()), false);
});

test("the shell-state routes answer from the context", () => {
  const cases = [
    ["/tvbox/api/backup/status", { restoredAt: 12345 }],
    ["/tvbox/api/power/sleep-timer", { at: 999 }],
    ["/tvbox/api/widgets", { widgets: [{ id: "spotify", title: "x" }] }],
    ["/tvbox/api/display/status", null],
  ];
  for (const [p, expected] of cases) {
    const res = fakeRes();
    assert.equal(getroutes.get(p, { url: p }, res, ctx()), true, p);
    if (expected) assert.deepEqual(JSON.parse(res.body), expected, p);
  }
});

test("the app list is re-read on every call, so a dropped-in manifest appears live", () => {
  const res = fakeRes();
  assert.equal(getroutes.get("/tvbox/api/apps", { url: "/tvbox/api/apps" }, res, ctx()), true);
  assert.deepEqual(JSON.parse(res.body), [{ id: "plex" }]);
});

test("the mirroring answer names the sink without leaking the rest of its state", () => {
  const res = fakeRes();
  getroutes.get("/tvbox/api/miracast", { url: "/tvbox/api/miracast" }, res, ctx());
  assert.deepEqual(JSON.parse(res.body), { armed: false, streaming: false, name: "tvbox", ssid: "", channel: "" });
});

test("a remote's saved keymap is merged into the bridge's list", () => {
  const res = fakeRes();
  getroutes.get("/tvbox/api/remote/devices", { url: "/tvbox/api/remote/devices" }, res, ctx());
  const d = JSON.parse(res.body).devices;
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].keymap, {});
});

test("a bridge file that is not there answers with the fallback, not a throw", () => {
  const res = fakeRes();
  getroutes.get("/tvbox/api/remote/learned", { url: "/tvbox/api/remote/learned" }, res, ctx());
  assert.deepEqual(JSON.parse(res.body), { learned: null });
});

// ---- the two picture routes ----

test("a photo the box cannot decode is a status the UI can tell apart, with an empty body", () => {
  for (const [reason, status] of Object.entries(getroutes.IMAGE_ERROR_STATUS)) {
    const res = fakeRes();
    getroutes.imageError(res, reason);
    assert.equal(res.status, status, reason);
    assert.equal(res.headers["X-Tvbox-Reason"], reason);
    assert.equal(res.body, "");
  }
});

test("an unknown reason is a 404, and it still says what it was", () => {
  const res = fakeRes();
  getroutes.imageError(res, "who knows");
  assert.equal(res.status, 404);
  assert.equal(res.headers["X-Tvbox-Reason"], "who knows");
  const res2 = fakeRes();
  getroutes.imageError(res2);
  assert.equal(res2.headers["X-Tvbox-Reason"], "not_found");
});

test("a photoshare name that resolves to nothing answers not_found rather than reading a path", () => {
  const res = fakeRes();
  assert.equal(
    getroutes.get(
      "/tvbox/api/photoshare/image",
      { url: "/tvbox/api/photoshare/image?name=../../etc/passwd" },
      res,
      ctx(),
    ),
    true,
  );
  assert.equal(res.status, 404);
});

// A response that is a real stream, for the routes that pipe into one.
function streamRes() {
  const res = new PassThrough();
  res.status = 0;
  res.headers = null;
  res.headersSent = false;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers || null;
    res.headersSent = true;
  };
  res.setHeader = () => {};
  res.collected = "";
  res.on("data", (c) => (res.collected += c));
  return res;
}

test("a rendered photo is immutable for its URL and never sniffed", async () => {
  const file = path.join(home, "pic.jpg");
  fs.writeFileSync(file, "not really a jpeg");
  const res = streamRes();
  getroutes.sendImage(res, file);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.equal(
    res.headers["X-Content-Type-Options"],
    "nosniff",
    "the fast path forwards a JPEG a stranger's camera wrote",
  );
  assert.equal(res.collected, "not really a jpeg");
});

test("a picture that is not there answers not_found rather than an empty 200", async () => {
  // Writing the headers first and failing afterwards would put an empty response
  // in Chromium's cache under a URL it will not ask about again.
  const res = streamRes();
  getroutes.sendImage(res, path.join(home, "no-such-file.jpg"));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(res.status, 404);
});

// ---- the files, last ----

test("with no root app, a path nothing claims is an honest 404", () => {
  const res = fakeRes();
  getroutes.serveFallback("/whatever", res, ctx());
  assert.equal(res.status, 404);
  assert.match(res.body, /no root app/);
});

test("the launcher is served from its own directory", async () => {
  fs.mkdirSync(path.join(home, "launcher-dist"), { recursive: true });
  fs.writeFileSync(path.join(home, "launcher-dist", "index.html"), "<html>launcher</html>");
  for (const p of ["/tvbox", "/tvbox/", "/tvbox/index.html"]) {
    const res = streamRes();
    getroutes.serveFallback(p, res, ctx());
    await new Promise((r) => setTimeout(r, 40));
    assert.match(res.collected, /launcher/, p);
  }
});
