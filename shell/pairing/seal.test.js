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
    const data = JSON.stringify(body);
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
    const t = seal.token(key);
    assert.strictEqual((await get("/list?t=" + t)).status, 200, "a read carries the token");
    assert.strictEqual((await get("/list?t=" + seal.token(seal.newKey()))).status, 403);
    assert.strictEqual((await post("/upload?t=" + t, { data: "x" })).status, 200, "a bulk upload carries the token");
    assert.strictEqual((await post("/save?t=" + t, { v: 2 })).status, 403, "the token is not the code");
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

test("the page helper seals what the server opens, and derives the server's token", () => {
  const key = seal.newKey();
  const page = pageSandbox("#c=4321&k=" + seal.keyParam(key), "", true);
  assert.strictEqual(page.tvboxSeal.sealed, true);
  assert.strictEqual(page.tvboxSeal.code, "4321");
  assert.strictEqual(page.tvboxSeal.query(), "t=" + seal.token(key));
  assert.strictEqual(page.replaced, undefined, "a current page leaves the URL alone");
  const wire = JSON.parse(page.tvboxSeal.body({ code: "1234", pass: "é" }));
  assert.deepStrictEqual(seal.open(wire.sealed, key, new Set()), { code: "1234", pass: "é" });
  const plain = pageSandbox("", "?c=1111", true);
  assert.strictEqual(plain.tvboxSeal.body({ a: 1 }), '{"a":1}');
  assert.strictEqual(plain.tvboxSeal.query(), "c=1111");
});

test("a page that reads ?c= itself still finds the code", () => {
  const page = pageSandbox("#c=4321&k=" + seal.keyParam(seal.newKey()), "", false);
  assert.strictEqual(new URLSearchParams(page.location.search).get("c"), "4321");
});
