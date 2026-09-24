// A phone's form reaches the pairing server sealed with a key the QR code carries
// in its fragment, and a sealed body is opened once and only with that key.
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const vm = require("vm");

const seal = require("./seal");
const pairing = require("./index");

const PORT = 18099;
pairing._setPortForTest(PORT);

function post(path, body, host) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "POST", headers: { host: host || "127.0.0.1:" + PORT } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
const listening = () => new Promise((r) => setTimeout(r, 150));

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: PORT, path, headers: { host: "127.0.0.1:" + PORT } }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      })
      .on("error", reject);
  });
}

function fromFragment(url, name) {
  return new RegExp("[#&]" + name + "=([^&]+)").exec(url)[1];
}

test("a sealed body is opened with the session key, once; the code never leaves the fragment", async () => {
  const got = [];
  pairing.register("sealtest", {
    page: () => "<p>x</p>",
    routes: {
      "POST /save": (req, res, ctx) => (got.push(ctx.body), ctx.json(res, { ok: true })),
      "GET /list": (req, res, ctx) => ctx.json(res, { ok: true }),
      "POST /upload": { bulk: true, maxBody: 1e6, handler: (req, res, ctx) => ctx.json(res, { ok: true }) },
    },
  });
  const s = pairing.start("en", "sealtest");
  try {
    await listening();
    assert.ok(!/\?c=/.test(s.url), "no code in the query of the QR URL");
    assert.strictEqual(fromFragment(s.url, "c"), s.code);
    const key = new Uint8Array(Buffer.from(fromFragment(s.url, "k"), "base64url"));
    assert.strictEqual(key.length, seal.KEY_BYTES, "the key is in the fragment");
    assert.strictEqual((await post("/save", { code: s.code, v: 0 })).status, 200, "plain works before a sealed body");
    const body = { sealed: seal.seal({ code: s.code, password: "hunter2" }, key) };
    assert.strictEqual((await post("/save", body)).status, 200);
    assert.deepStrictEqual(got[1], { code: s.code, password: "hunter2" });
    assert.strictEqual((await post("/save", body)).status, 400, "a replay is refused");
    const wrong = { sealed: seal.seal({ code: s.code }, seal.newKey()) };
    assert.strictEqual((await post("/save", wrong)).status, 400);
    assert.strictEqual((await post("/save", { code: s.code, v: 1 })).status, 403, "plain is refused once sealed");
    const page = pageSandbox("#c=" + s.code + "&k=" + seal.keyParam(key), "", true).tvboxSeal;
    assert.strictEqual((await get(page.url("GET", "/list"))).status, 200, "a signed read");
    const other = pageSandbox("#k=" + seal.keyParam(seal.newKey()), "", true).tvboxSeal;
    assert.strictEqual((await get(other.url("GET", "/list"))).status, 403, "signed with another key");
    const chunk = JSON.stringify({ data: "é".repeat(20000) });
    const signed = page.url("POST", "/upload", chunk);
    assert.strictEqual((await post(signed, chunk)).status, 200, "a bulk upload signed over its bytes");
    assert.strictEqual((await post(signed, chunk)).status, 403, "the same signed write twice is a replay");
    const again = page.url("POST", "/upload", chunk);
    assert.strictEqual((await post(again, JSON.stringify({ data: "evil" }))).status, 403, "the MAC covers the body");
    assert.strictEqual((await post(page.url("POST", "/save", '{"v":2}'), '{"v":2}')).status, 403, "only bulk is plain");
    assert.strictEqual((await post("/upload?c=" + s.code, { data: "x" })).status, 403, "the code is not enough now");
    assert.strictEqual((await post("/save", { code: s.code }, "rebind.example:" + PORT)).status, 421);
  } finally {
    pairing.stop();
  }
});

function pageSandbox(hash, search, v2) {
  const sandbox = {
    location: { hash, search: search || "", pathname: "/" },
    history: {
      replaceState(_s, _t, url) {
        const u = new URL(url, "http://box");
        sandbox.location.search = u.search;
        sandbox.replaced = url;
      },
    },
    document: { currentScript: { getAttribute: (n) => (n === "data-v" && v2 ? "2" : null) } },
    URLSearchParams,
    URL,
    atob: (s) => Buffer.from(s, "base64").toString("latin1"),
    btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
    TextEncoder,
    Uint8Array, // one realm's typed arrays, so nacl's type checks see the encoder's output
    crypto: { getRandomValues: (a) => require("crypto").randomFillSync(a) },
  };
  sandbox.self = sandbox;
  vm.runInNewContext(seal.script(), sandbox);
  return sandbox;
}

test("the page helper seals and signs what the server opens and verifies", () => {
  const key = seal.newKey();
  const page = pageSandbox("#c=4321&k=" + seal.keyParam(key), "", true);
  assert.strictEqual(page.tvboxSeal.sealed, true);
  assert.strictEqual(page.tvboxSeal.code, "4321");
  assert.throws(() => page.tvboxSeal.query(), /tvboxSeal.url/);
  const u = page.tvboxSeal.url("POST", "/x?a=1", "body");
  assert.ok(/^\/x\?a=1&n=[\w-]+&m=[\w-]{22}$/.test(u), u);
  assert.strictEqual(seal.macOk(key, "POST", u, Buffer.from("body")), true);
  assert.strictEqual(seal.macOk(key, "GET", u, Buffer.from("body")), false, "the method is covered");
  assert.strictEqual(seal.macOk(key, "POST", u.replace("a=1", "a=2"), Buffer.from("body")), false);
  assert.strictEqual(seal.macOk(key, "POST", u, Buffer.from("bodY")), false);
  assert.strictEqual(page.replaced, undefined, "a current page leaves the URL alone");
  const wire = JSON.parse(page.tvboxSeal.body({ code: "1234", pass: "é" }));
  assert.deepStrictEqual(seal.open(wire.sealed, key, new Set()), { code: "1234", pass: "é" });
  const plain = pageSandbox("", "?c=1111", true);
  assert.strictEqual(plain.tvboxSeal.body({ a: 1 }), '{"a":1}');
  assert.strictEqual(plain.tvboxSeal.query(), "c=1111");
  assert.strictEqual(plain.tvboxSeal.url("GET", "/list"), "/list?c=1111");
});

test("a page that reads ?c= itself still finds the code", () => {
  const page = pageSandbox("#c=4321&k=" + seal.keyParam(seal.newKey()), "", false);
  assert.strictEqual(new URLSearchParams(page.location.search).get("c"), "4321");
});

test("an older page gets the code in the query, and an empty code is not an attempt", async () => {
  pairing.register(
    "legacytest",
    {
      page: () => "<p>x</p>",
      routes: { "GET /list": (req, res, ctx) => ctx.json(res, { ok: true }) },
    },
    "someapp",
  );
  const s = pairing.start("en", "legacytest");
  try {
    await listening();
    assert.ok(s.url.includes("/?c=" + s.code + "#k="), s.url);
    // A page that found no code loads its lists with an empty one, many times over.
    for (let i = 0; i < 12; i++) assert.strictEqual((await get("/list?c=")).status, 403);
    assert.strictEqual((await get("/list?c=" + s.code)).status, 200, "the session is still open");
  } finally {
    pairing.stop();
  }
});

test("the page's own-key primitives match the server's (the phone remote uses them)", () => {
  const page = pageSandbox("", "", true);
  page.TextDecoder = TextDecoder;
  const lib = page.tvboxSeal.lib;
  const raw = seal.keyParam(seal.newKey());
  const key = lib.key(raw);
  assert.ok(key && key.length === 32);
  assert.strictEqual(lib.key("short"), null);
  const u = lib.sign(key, "POST", "/key?p=a&ts=1", '{"action":"up"}');
  assert.strictEqual(
    seal.macOk(new Uint8Array(Buffer.from(raw, "base64url")), "POST", u, Buffer.from('{"action":"up"}')),
    true,
  );
  const k = new Uint8Array(Buffer.from(raw, "base64url"));
  assert.deepStrictEqual(seal.open(lib.seal(key, { code: "1" }), k), { code: "1" });
  assert.strictEqual(JSON.stringify(lib.open(key, seal.seal({ id: "x" }, k))), '{"id":"x"}');
  const frame = Buffer.from("jpeg bytes");
  assert.strictEqual(
    Buffer.from(lib.openBytes(key, new Uint8Array(seal.sealBytes(frame, k)))).toString(),
    "jpeg bytes",
  );
});
