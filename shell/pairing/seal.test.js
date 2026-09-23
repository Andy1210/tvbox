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

test("a sealed body is opened with the session key, once; a plain one still works", async () => {
  const got = [];
  pairing.register("sealtest", {
    page: () => "<p>x</p>",
    routes: { "POST /save": (req, res, ctx) => (got.push(ctx.body), ctx.json(res, { ok: true })) },
  });
  const s = pairing.start("en", "sealtest");
  try {
    await listening();
    const key = new Uint8Array(Buffer.from(/#k=([^&]+)$/.exec(s.url)[1], "base64url"));
    assert.strictEqual(key.length, seal.KEY_BYTES, "the key is in the fragment");
    const body = { sealed: seal.seal({ code: s.code, password: "hunter2" }, key) };
    assert.strictEqual((await post("/save", body)).status, 200);
    assert.deepStrictEqual(got[0], { code: s.code, password: "hunter2" });
    assert.strictEqual((await post("/save", body)).status, 400, "a replay is refused");
    const wrong = { sealed: seal.seal({ code: s.code }, seal.newKey()) };
    assert.strictEqual((await post("/save", wrong)).status, 400);
    assert.strictEqual((await post("/save", { code: s.code, v: 1 })).status, 200, "a typed short URL has no key");
    assert.strictEqual((await post("/save", { code: s.code }, "rebind.example:" + PORT)).status, 421);
  } finally {
    pairing.stop();
  }
});

test("the page helper seals what the server opens", () => {
  const key = seal.newKey();
  const sandbox = {
    location: { hash: "#k=" + seal.keyParam(key) },
    atob: (s) => Buffer.from(s, "base64").toString("latin1"),
    btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
    TextEncoder,
    Uint8Array, // one realm's typed arrays, so nacl's type checks see the encoder's output
    crypto: { getRandomValues: (a) => require("crypto").randomFillSync(a) },
  };
  sandbox.self = sandbox;
  vm.runInNewContext(seal.script(), sandbox);
  assert.strictEqual(sandbox.tvboxSeal.sealed, true);
  const wire = JSON.parse(sandbox.tvboxSeal.body({ code: "1234", pass: "é" }));
  assert.deepStrictEqual(seal.open(wire.sealed, key, new Set()), { code: "1234", pass: "é" });
  const plain = { ...sandbox, location: { hash: "" }, tvboxSeal: undefined };
  plain.self = plain;
  vm.runInNewContext(seal.script(), plain);
  assert.strictEqual(plain.tvboxSeal.body({ a: 1 }), '{"a":1}');
});
