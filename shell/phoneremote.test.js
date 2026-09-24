// A phone acting as the remote.
//
// This module's whole job is deciding who may inject a key into whatever is on
// screen, so nearly every test below is a refusal. The one that matters most is
// the FIFO line: an action becomes `key <action>` on a channel that also carries
// `learn <id>` and `native on`, so anything that could put a newline through
// here would be handing a caller the bridge's whole command set.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

const phoneremote = require("./phoneremote");
const seal = require("./pairing/seal");

// A stand-in for the box: config that lives in memory, and a bridge that records
// the lines it was asked to write instead of opening a FIFO.
function box(initial) {
  const state = { enabled: true, phones: [], ...(initial || {}) };
  const wrote = [];
  phoneremote.init({
    rawPhoneRemote: () => state,
    setPhoneRemote: (patch) => Object.assign(state, patch),
    press: (action) => {
      wrote.push("key " + action);
      return true;
    },
    lanIp: () => "192.168.1.50",
    port: 0, // an ephemeral port per test: on one fixed port they race each other's close
  });
  return { state, wrote };
}

// Bring it up and WAIT for the bind, so `port` below is the real one.
const boxUp = (initial) =>
  new Promise((res) => {
    const b = box(initial);
    phoneremote.apply(() => res(b));
  });
const port = () => phoneremote.boundPort();

const postTo = (p, path, body) =>
  new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: p, path, method: "POST", headers: { "Content-Length": data.length } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(out);
          } catch (e) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", (e) => resolve({ status: 0, body: { error: e.code } }));
    req.end(data);
  });
const post = (path, body) => postTo(port(), path, body);
const arm = () => new Promise((res) => phoneremote.arm(res));

// What the page does for every request once it holds a key: the phone's id and
// clock in the query, then a nonce and an HMAC over the method, the URL and the
// exact body (seal.js).
let nonceSeq = 0;
function signedUrl(g, method, path, body, opts) {
  const o = opts || {};
  const ts = o.ts != null ? o.ts : Date.now();
  const u = path + (path.includes("?") ? "&" : "?") + "p=" + g.id + "&ts=" + ts + "&n=nonce" + ++nonceSeq + "xyz";
  const key = new Uint8Array(Buffer.from(o.key || g.key, "base64url"));
  return u + "&m=" + seal.mac(key, method, u, Buffer.from(body || ""));
}
const spost = (g, path, body, opts) => postTo(port(), signedUrl(g, "POST", path, JSON.stringify(body), opts), body);

// Awaited: the listener is on a fixed port, so a test that started before the
// previous one finished closing would race it for the bind.
test.afterEach(() => new Promise((done) => phoneremote.stop(done)));

// ------------------------------------------------------------- the vocabulary

test("only the bridge's own actions are accepted", () => {
  for (const good of ["up", "ok", "back", "volume_up", "power", "settings", "app:retroarch"]) {
    assert.equal(phoneremote.isAction(good), true, good);
  }
  // The line this becomes is `key <action>` on a FIFO that also takes `learn`
  // and `native on`. A newline would not be a bad keypress - it would be a
  // second command of the caller's choosing.
  const nasty = [
    "up\nlearn 0",
    "up\r\nnative on",
    "up\nreload",
    "up ",
    " up",
    "UP",
    "",
    "app:../../etc",
    "app:" + "x".repeat(64),
    "reload",
    "learn 0",
    "native on",
    null,
    undefined,
    42,
    {},
    ["up"],
  ];
  for (const bad of nasty) assert.equal(phoneremote.isAction(bad), false, JSON.stringify(bad));
});

// -------------------------------------------------------------- the listener

test("nothing listens until the box is asked to turn it on", async () => {
  // A port of this test's own, so "off" and "on" are compared on the SAME one -
  // otherwise a refused connection proves only that nothing was there.
  const P = 8191;
  const b = box({ enabled: false });
  phoneremote.init({ port: P });
  await new Promise((r) => phoneremote.apply(r));
  assert.equal((await postTo(P, "/ping", {})).status, 0, "no socket at all");
  assert.equal(await arm(), null, "and a code cannot be shown either");

  b.state.enabled = true;
  await new Promise((r) => phoneremote.apply(r));
  assert.notEqual((await postTo(P, "/ping", {})).status, 0, "the setting is what decides");
});

test("turning it off takes the socket down, not just the answers", async () => {
  const b = await boxUp({ enabled: true });
  const p = port(); // remembered: once it is down there is no port to ask for
  assert.notEqual((await postTo(p, "/ping", {})).status, 0, "it is up");
  b.state.enabled = false;
  await new Promise((r) => phoneremote.apply(r));
  assert.equal((await postTo(p, "/ping", {})).status, 0, "and gone");
});

test("the address can be handed out without opening the adoption window", async () => {
  // Settings shows this so a phone that is already paired can find its way back.
  // If it went through arm() instead, looking up the address would replace the
  // code another phone is halfway through typing - and there is nothing on the
  // TV to say so.
  const b = await boxUp();
  const armed = await arm();
  assert.equal(phoneremote.address(), `http://192.168.1.50:${port()}`, "no code on it");

  const still = await post("/adopt", { code: armed.code, name: "late" });
  assert.equal(still.status, 200, "the code that was already out still works");
  assert.equal(b.state.phones.length, 1);

  b.state.enabled = false;
  await new Promise((r) => phoneremote.apply(r));
  assert.equal(phoneremote.address(), "", "and nothing to point anyone at while it is off");
});

test("the address is the socket's, not the one that was asked for", async () => {
  // `enabled` is a setting, not a listener. A box whose port was taken has the
  // switch on and nothing bound, and an address handed out then points at nobody -
  // which on the TV looks like the phone is at fault. A REAL port number here, not
  // the ephemeral 0 the other tests use: falling back to the configured one is
  // exactly the mistake under test, and 0 hides it.
  box({ enabled: true });
  phoneremote.init({ port: 8197 }); // configured, never started
  assert.equal(phoneremote.address(), "", "nothing is listening yet");
  await new Promise((r) => phoneremote.apply(r));
  assert.equal(phoneremote.address(), "http://192.168.1.50:8197");
});

// --------------------------------------------------------------- adoption

test("a phone is adopted with the code on the TV, and then keeps working", async () => {
  const b = await boxUp();
  const armed = await arm();
  assert.match(armed.url, /^http:\/\/192\.168\.1\.50:\d+\/#c=\d{4}&k=[\w-]{43}$/, "the code and key in the fragment");

  const wrong = await post("/adopt", { code: "0000", name: "Andy's phone" });
  assert.equal(wrong.status, 403);
  assert.equal(b.state.phones.length, 0, "a wrong code adopts nothing");

  // Sealed with the one-time key from the fragment, and answered sealed.
  const oneTime = new Uint8Array(Buffer.from(/k=([\w-]+)/.exec(armed.url)[1], "base64url"));
  const ok = await post("/adopt", { sealed: seal.seal({ code: armed.code, name: "Kitchen phone" }, oneTime) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.key, undefined, "the key does not cross the network in clear");
  const grant = seal.open(ok.body.sealed, oneTime);
  assert.match(grant.key, /^[\w-]{43}$/);
  assert.equal(b.state.phones.length, 1);
  assert.equal(b.state.phones[0].name, "Kitchen phone");

  // And it works from then on, with no code anywhere.
  const press = await spost(grant, "/key", { action: "up" });
  assert.equal(press.status, 200);
  assert.deepEqual(b.wrote, ["key up"]);
});

test("it will not show a code that leads nowhere", async () => {
  // A box with no LAN address yet would otherwise put a QR on the TV pointing at
  // itself. Someone types the four digits in for nothing, which is worse than
  // being told it is not ready.
  const b = box();
  phoneremote.init({ lanIp: () => "127.0.0.1" });
  await new Promise((r) => phoneremote.apply(r));
  assert.equal(await arm(), null, "loopback is not an address a phone can reach");
  phoneremote.init({ lanIp: () => "" });
  assert.equal(await arm(), null, "and neither is nothing at all");
  assert.equal(b.state.phones.length, 0);
});

test("one code adopts one phone", async () => {
  const b = await boxUp();
  const armed = await arm();
  assert.equal((await post("/adopt", { code: armed.code, name: "first" })).status, 200);
  // Leaving the window open would let a second device onto the same four digits.
  assert.equal((await post("/adopt", { code: armed.code, name: "second" })).status, 403);
  assert.equal(b.state.phones.length, 1);
});

test("guessing the code closes the window", async () => {
  const b = await boxUp();
  const armed = await arm();
  for (let i = 0; i < 8; i++) await post("/adopt", { code: "0001", name: "x" });
  // Even the RIGHT code is refused now - the window is gone, not merely counting.
  assert.equal((await post("/adopt", { code: armed.code, name: "x" })).status, 403);
  assert.equal(b.state.phones.length, 0);
});

test("a name from a phone cannot carry control characters into the log or the config", async () => {
  const b = await boxUp();
  const armed = await arm();
  await post("/adopt", { code: armed.code, name: "kitchen\n[phoneremote] adopted  evil" });
  const name = b.state.phones[0].name;
  assert.ok(!/[ -]/.test(name), "no control characters: " + JSON.stringify(name));
  assert.ok(name.length <= 40);
});

test("an unnamed phone still gets a name", async () => {
  const b = await boxUp();
  const armed = await arm();
  await post("/adopt", { code: armed.code, name: "   " });
  assert.equal(b.state.phones[0].name, "phone", "a blank row is one nobody can tell from another");
});

// ------------------------------------------------------------------- tokens

test("a press needs a signature under a key this box issued", async () => {
  const b = await boxUp();
  const armed = await arm();
  const g = (await post("/adopt", { code: armed.code, name: "p" })).body;

  const other = seal.keyParam(seal.newKey());
  assert.equal((await post("/key", { action: "up" })).status, 403, "unsigned");
  assert.equal((await spost(g, "/key", { action: "up" }, { key: other })).status, 403, "signed with another key");
  assert.equal(
    (await spost({ ...g, id: "nope" }, "/key", { action: "up" })).status,
    403,
    "an id this box never issued",
  );
  // The body is covered: a signature for one press does not carry another.
  const url = signedUrl(g, "POST", "/key", JSON.stringify({ action: "up" }));
  assert.equal((await postTo(port(), url, { action: "power" })).status, 403, "the body is covered");
  assert.deepEqual(b.wrote, [], "not one of them reached the bridge");
  assert.equal((await postTo(port(), url, { action: "up" })).status, 200);
  assert.equal((await postTo(port(), url, { action: "up" })).status, 403, "and the same request twice is a replay");
  const late = await spost(g, "/key", { action: "up" }, { ts: Date.now() - phoneremote.CLOCK_SKEW_MS - 60000 });
  assert.equal(late.status, 403);
  assert.equal(late.body.error, "time");
  assert.ok(Math.abs(late.body.now - Date.now()) < 5000, "with the box's clock, so the page can correct");
  assert.deepEqual(b.wrote, ["key up"]);
});

test("a forgotten phone stops working immediately", async () => {
  const b = await boxUp();
  const armed = await arm();
  const g = (await post("/adopt", { code: armed.code, name: "p" })).body;
  assert.equal((await spost(g, "/key", { action: "ok" })).status, 200);

  const id = phoneremote.list()[0].id;
  assert.equal(phoneremote.forget(id), true);
  assert.equal(phoneremote.forget(id), false, "and forgetting it twice is not an error");
  assert.equal((await spost(g, "/key", { action: "ok" })).status, 403);
  assert.equal(b.wrote.length, 1, "only the press from before it was forgotten");
});

test("what the launcher may see carries no key", async () => {
  await boxUp();
  const armed = await arm();
  await post("/adopt", { code: armed.code, name: "kitchen" });
  const rows = phoneremote.list();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["addedAt", "id", "lastSeenAt", "name"]);
});

// ------------------------------------------------------------------ requests

test("a refused action never reaches the bridge", async () => {
  const b = await boxUp();
  const armed = await arm();
  const g = (await post("/adopt", { code: armed.code, name: "p" })).body;
  for (const bad of ["up\nlearn 0", "reload", "", "app:!!"]) {
    assert.equal((await spost(g, "/key", { action: bad })).status, 400, bad);
  }
  assert.deepEqual(b.wrote, []);
});

test("a body that is not JSON, or is enormous, is refused rather than parsed", async () => {
  await boxUp();
  const armed = await arm();
  const g = (await post("/adopt", { code: armed.code, name: "p" })).body;
  // Sent raw, so it is not valid JSON at all.
  const raw = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: port(), path: "/key", method: "POST" }, (res) =>
      resolve({ status: res.statusCode }),
    );
    req.on("error", () => resolve({ status: 0 }));
    req.end("not json at all");
  });
  assert.equal(raw.status, 400);
  const huge = await spost(g, "/key", { action: "up", pad: "x".repeat(20000) });
  assert.ok(huge.status === 400 || huge.status === 0, "capped, not read: got " + huge.status);
});

test("the page is served without a token, and carries none", async () => {
  // It has to be reachable before a phone has anything: the page IS the pairing
  // form. What it must not do is arrive with a way in already in it.
  await boxUp();
  const html = await new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port: port(), path: "/?c=1234" }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], out }));
      })
      .on("error", () => resolve({ status: 0, out: "" }));
  });
  assert.equal(html.status, 200);
  assert.match(html.type, /text\/html/);
  assert.match(html.out, /<title>tvbox remote<\/title>/);
  assert.ok(!/[0-9a-f]{64}/.test(html.out), "no token is baked into the page");
  assert.ok(html.out.includes('src="/tvbox-seal.js"'), "it signs with the shared helper");
});

// ------------------------------------------------------------------ the screen
//
// The most sensitive thing this box hands out: a frame shows whatever is on the
// TV, including a password being typed on the on-screen keyboard and the pairing
// code itself. So it is a SECOND permission, and it runs out on its own.

const getScreen = (q) =>
  new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port: port(), path: q }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", () => resolve(0));
  });

test("being able to press buttons does not mean being able to see the screen", async () => {
  const b = await boxUp();
  const armed = await arm();
  const g = (await post("/adopt", { code: armed.code, name: "p" })).body;
  // The remote works...
  assert.equal((await spost(g, "/key", { action: "up" })).status, 200);
  // ...and the screen does not, until it is asked for separately.
  assert.equal(await getScreen(signedUrl(g, "GET", "/screen")), 403);
  assert.equal(b.state.screenUntil, undefined);
});

test("the screen needs a token of its own, not just the switch", async () => {
  await boxUp();
  const armed = await arm();
  const g = (await post("/adopt", { code: armed.code, name: "p" })).body;
  phoneremote.shareScreen(10);
  assert.equal(await getScreen("/screen"), 403, "unsigned");
  assert.equal(await getScreen(signedUrl(g, "GET", "/screen", "", { key: seal.keyParam(seal.newKey()) })), 403);
  // The real one gets PAST the gate: it fails on there being no compositor here,
  // which is a different answer and the one that proves the check let it through.
  assert.notEqual(await getScreen(signedUrl(g, "GET", "/screen")), 403, "a paired phone is not refused");
});

test("sharing the screen runs out on its own", async () => {
  const b = await boxUp();
  assert.equal(phoneremote.screenOn(), false);

  const until = phoneremote.shareScreen(30);
  assert.ok(until > Date.now(), "it is on");
  assert.equal(phoneremote.screenOn(), true);
  assert.equal(b.state.screenUntil, until);

  // A switch left on is the failure mode here, so the expiry is the feature.
  b.state.screenUntil = Date.now() - 1;
  assert.equal(phoneremote.screenOn(), false, "an expired window is a closed one");

  // And it can be closed by hand.
  phoneremote.shareScreen(30);
  assert.equal(phoneremote.shareScreen(0), 0);
  assert.equal(phoneremote.screenOn(), false);
});

test("a request for a wild number of minutes is clamped, not honoured", () => {
  const b = box();
  const day = 24 * 60;
  phoneremote.shareScreen(day);
  assert.ok(b.state.screenUntil - Date.now() <= 120 * 60000 + 1000, "two hours is the most it will hold open");
  assert.equal(phoneremote.shareScreen(-5), 0, "and a negative one is off, not forever");
});

test("forgetting a phone takes its view of the screen with it", async () => {
  await boxUp();
  const armed = await arm();
  const g = (await post("/adopt", { code: armed.code, name: "p" })).body;
  phoneremote.shareScreen(10);
  const id = phoneremote.list()[0].id;
  phoneremote.forget(id);
  assert.equal(await getScreen(signedUrl(g, "GET", "/screen")), 403);
});

test("an unknown path answers nothing useful", async () => {
  await boxUp();
  const armed = await arm();
  const g = (await post("/adopt", { code: armed.code, name: "p" })).body;
  assert.equal((await spost(g, "/nope", {})).status, 404);
});

test("a phone paired before requests were signed has no key, and is refused until it pairs again", async () => {
  const b = await boxUp({ phones: [{ id: "old1", name: "old", tokenHash: "a".repeat(64), addedAt: 1 }] });
  const g = { id: "old1", key: seal.keyParam(seal.newKey()) };
  assert.equal((await spost(g, "/key", { action: "up" })).status, 403);
  assert.deepEqual(b.wrote, []);
  assert.equal(phoneremote.list().length, 0, "it is not listed either: it can never connect");
});

test("a phone paired before phones held keys is dropped, and does not count toward the limit", async () => {
  const legacy = { id: "old1", name: "old", tokenHash: "ab".repeat(32), addedAt: 1 };
  const keyed = { id: "new1", name: "new", key: Buffer.alloc(32, 7).toString("base64url"), addedAt: 2 };
  const b = await boxUp({ enabled: true, phones: [legacy, keyed] });
  assert.deepEqual(
    b.state.phones.map((p) => p.id),
    ["new1"],
    "the keyless row is gone from the config",
  );
  assert.deepEqual(
    phoneremote.list().map((p) => p.id),
    ["new1"],
  );
});
