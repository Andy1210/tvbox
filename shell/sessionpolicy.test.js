// Every session is held to the same permissions, and every request a page makes
// to the API is stamped with who made it.
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const sessionpolicy = require("./sessionpolicy");
const apigate = require("./apigate");

function fakeSession() {
  const s = new EventEmitter();
  s.handlers = {};
  s.setPermissionRequestHandler = (fn) => (s.handlers.request = fn);
  s.setPermissionCheckHandler = (fn) => (s.handlers.check = fn);
  s.setDevicePermissionHandler = (fn) => (s.handlers.device = fn);
  s.webRequest = { onBeforeSendHeaders: (filter, fn) => (s.handlers.headers = { filter, fn }) };
  return s;
}

test("the microphone, the camera, clipboard reads and MIDI are refused; fullscreen is not", () => {
  const s = fakeSession();
  sessionpolicy.harden(s, { port: 8097, identityOf: () => "unknown" });
  const asked = (p) => {
    let got;
    s.handlers.request(null, p, (v) => (got = v));
    return got;
  };
  for (const p of ["media", "clipboard-read", "midiSysex", "geolocation", "notifications", "display-capture"])
    assert.strictEqual(asked(p), false, p);
  assert.strictEqual(asked("fullscreen"), true);
  assert.strictEqual(s.handlers.check(null, "media"), false);
  assert.strictEqual(s.handlers.device({}), false);
});

test("a device chooser is cancelled rather than shown", () => {
  const s = fakeSession();
  sessionpolicy.harden(s, { port: 8097, identityOf: () => "unknown" });
  let prevented = 0;
  let answer = "x";
  s.emit("select-hid-device", { preventDefault: () => prevented++ }, {}, (v) => (answer = v));
  assert.strictEqual(prevented, 1);
  assert.strictEqual(answer, "");
});

test("requests to the API get the stamp of the window that made them", () => {
  const s = fakeSession();
  sessionpolicy.harden(s, { port: 8097, identityOf: (id) => (id === 7 ? "app:files" : "unknown") });
  assert.deepStrictEqual(s.handlers.headers.filter.urls, ["http://localhost:8097/*", "http://127.0.0.1:8097/*"]);
  let out;
  s.handlers.headers.fn(
    { webContentsId: 7, requestHeaders: { "X-Tvbox-Caller": "forged launcher" } },
    (r) => (out = r),
  );
  const req = { headers: { "x-tvbox-caller": out.requestHeaders["X-Tvbox-Caller"] } };
  assert.deepStrictEqual(apigate.identify(req), { kind: "app", id: "files" });
});

test("hardening twice is harmless", () => {
  const s = fakeSession();
  sessionpolicy.harden(s, { port: 1, identityOf: () => "unknown" });
  const first = s.handlers.request;
  sessionpolicy.harden(s, { port: 1, identityOf: () => "unknown" });
  assert.strictEqual(s.handlers.request, first);
});

test("a local window stays on the shell's own pages, inside its app's directory", () => {
  const base = "http://localhost:8097";
  const ok = (u, prefix) => sessionpolicy.localNavAllowed(u, base, prefix);
  assert.strictEqual(ok("http://localhost:8097/tvbox/#settings", null), true);
  assert.strictEqual(ok("http://evil.example/", null), false);
  assert.strictEqual(ok("http://127.0.0.1:8097/tvbox/", null), false, "the other spelling is another origin");
  assert.strictEqual(ok("http://localhost:8097/files/player", "/files/"), true);
  assert.strictEqual(ok("http://localhost:8097/files", "/files/"), true);
  assert.strictEqual(ok("http://localhost:8097/spotify/", "/files/"), false);
  assert.strictEqual(ok("javascript:alert(1)", null), false);
});
