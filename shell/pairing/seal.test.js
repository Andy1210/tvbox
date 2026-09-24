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
    const unbound = { sealed: seal.seal({ code: s.code, password: "hunter2" }, key) };
    assert.strictEqual((await post("/save", unbound)).status, 400, "a v2 body names its route");
    const elsewhere = { sealed: seal.seal({ code: s.code, _r: "POST /other" }, key) };
    assert.strictEqual((await post("/save", elsewhere)).status, 400, "a body sealed for another route");
    const body = { sealed: seal.seal({ code: s.code, password: "hunter2", _r: "POST /save" }, key) };
    assert.strictEqual((await post("/save", body)).status, 200);
    assert.deepStrictEqual(got[1], { code: s.code, password: "hunter2" }, "the route is not handed on");
    assert.strictEqual((await post("/save", body)).status, 400, "a replay is refused");
    const wrong = { sealed: seal.seal({ code: s.code }, seal.newKey()) };
    assert.strictEqual((await post("/save", wrong)).status, 400);
    assert.strictEqual((await post("/save", { code: s.code, v: 1 })).status, 403, "plain is refused once sealed");
    const page = pageSandbox("#c=" + s.code + "&k=" + seal.keyParam(key), "", true).tvboxSeal;
    assert.strictEqual((await get(page.url("GET", "/list"))).status, 200, "a signed read");
    // A browser escapes ' in a query; the page signs what it will really send.
    const quoted = page.url("GET", "/list?name=" + encodeURIComponent("Dad's.jpg"));
    assert.ok(quoted.includes("%27"), quoted);
    assert.strictEqual((await get(quoted)).status, 200, "a name with an apostrophe");
    const other = pageSandbox("#k=" + seal.keyParam(seal.newKey()), "", true).tvboxSeal;
    for (let i = 0; i < 12; i++)
      assert.strictEqual((await get(other.url("GET", "/list"))).status, 403, "signed with another key");
    assert.strictEqual((await get(page.url("GET", "/list"))).status, 200, "a MAC mismatch is not a code guess");
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

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function pageSandbox(hash, search, v2, storage, scriptOpts, overrides) {
  const sandbox = {
    location: { hash, search: search || "", pathname: "/", href: "http://box/" + (search || "") + hash },
    history: {
      replaceState(_s, _t, url) {
        const u = new URL(url, "http://box");
        sandbox.location.search = u.search;
        sandbox.location.hash = u.hash;
        sandbox.replaced = url;
      },
    },
    sessionStorage: storage || undefined,
    document: { currentScript: { getAttribute: (n) => (n === "data-v" && v2 ? "2" : null) } },
    URLSearchParams,
    URL,
    atob: (s) => Buffer.from(s, "base64").toString("latin1"),
    btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
    TextEncoder,
    Uint8Array, // one realm's typed arrays, so nacl's type checks see the encoder's output
    crypto: { getRandomValues: (a) => require("crypto").randomFillSync(a) },
  };
  Object.assign(sandbox, overrides || {});
  sandbox.self = sandbox;
  vm.runInNewContext(seal.script(scriptOpts), sandbox);
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
  assert.strictEqual(page.replaced, "/", "a v2 page takes the code and key out of the address bar");
  const wire = JSON.parse(page.tvboxSeal.body({ code: "1234", pass: "é" }, "/save"));
  assert.deepStrictEqual(seal.open(wire.sealed, key, new Set()), { code: "1234", pass: "é", _r: "POST /save" });
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

test("a v2 page still has its key after a reload in the same tab", () => {
  const key = seal.newKey();
  const store = memoryStorage();
  const first = pageSandbox("#c=4321&k=" + seal.keyParam(key), "", true, store, { key });
  assert.strictEqual(first.tvboxSeal.sealed, true);
  const reloaded = pageSandbox("", "", true, store, { key });
  assert.strictEqual(reloaded.tvboxSeal.sealed, true);
  assert.strictEqual(reloaded.tvboxSeal.code, "4321");
});

test("a later session opened in the same tab does not reuse the earlier one's key", () => {
  const a = seal.newKey();
  const b = seal.newKey();
  const store = memoryStorage();
  pageSandbox("#c=1111&k=" + seal.keyParam(a), "", true, store, { key: a });
  // Session A is over and B is running; the phone types the short URL in the same tab.
  const typed = pageSandbox("", "", true, store, { key: b });
  assert.strictEqual(typed.tvboxSeal.sealed, false, "no key: the page asks for the code");
  assert.strictEqual(typed.tvboxSeal.code, "");
  assert.strictEqual(store.getItem("tvboxSeal"), null, "what A left behind is dropped");
  // With no session at all, a kept key is not used either.
  pageSandbox("#c=2222&k=" + seal.keyParam(b), "", true, store, { key: b });
  assert.strictEqual(pageSandbox("", "", true, store, {}).tvboxSeal.sealed, false);
});

test("forget() drops what the tab kept", () => {
  const key = seal.newKey();
  const store = memoryStorage();
  pageSandbox("#c=4321&k=" + seal.keyParam(key), "", true, store, { key }).tvboxSeal.forget();
  assert.strictEqual(pageSandbox("", "", true, store, { key }).tvboxSeal.sealed, false);
});

test("the script carries only a tag of the session key, never the key", () => {
  const key = seal.newKey();
  const src = seal.script({ key, keepalive: true });
  assert.ok(src.includes('__tvboxSealSession="' + seal.sessionTag(key) + '"'));
  assert.ok(!src.includes(seal.keyParam(key)));
  assert.strictEqual(seal.sessionTag(null), "");
  assert.notStrictEqual(seal.sessionTag(key), seal.sessionTag(seal.newKey()));
});

test("a read with the code does not hold the session open; a keepalive does", async () => {
  pairing.register(
    "ttltest",
    {
      page: () => "<p>x</p>",
      routes: { "GET /list": (req, res, ctx) => ctx.json(res, { ok: true }) },
    },
    "someapp",
  );
  const s = pairing.start("en", "ttltest");
  try {
    await listening();
    // Seven wrong codes, then reads with the right one: the count is not reset by a read.
    for (let i = 0; i < 7; i++) await get("/list?c=0000");
    assert.strictEqual((await get("/list?c=" + s.code)).status, 200);
    assert.strictEqual((await get("/list?c=" + s.code)).status, 200);
    assert.strictEqual((await get("/list?c=0000")).status, 403);
    // The eighth wrong one ended the session (a kept-alive socket may still get an answer).
    const after = await get("/list?c=" + s.code).catch(() => ({ status: 0 }));
    assert.notStrictEqual(after.status, 200);
  } finally {
    pairing.stop();
  }
  const t = pairing.start("en", "ttltest");
  try {
    await listening();
    const key = new Uint8Array(Buffer.from(fromFragment(t.url, "k"), "base64url"));
    const page = pageSandbox("", "", true, undefined, {});
    const signed = page.tvboxSeal.lib.sign(page.tvboxSeal.lib.key(seal.keyParam(key)), "POST", "/tvbox-keepalive", "");
    assert.strictEqual((await post(signed, "")).status, 204);
    assert.strictEqual((await post(signed, "")).status, 403, "a keepalive cannot be replayed");
    assert.strictEqual((await post("/tvbox-keepalive", "")).status, 403, "and needs the key");
    assert.strictEqual((await get("/list?c=" + t.code)).status, 200, "a refused keepalive is not a code guess");
  } finally {
    pairing.stop();
  }
});

test("a keepalive that carries a body is refused unread", async () => {
  pairing.register("kabody", { page: () => "<p>x</p>", routes: {} }, "someapp");
  const t = pairing.start("en", "kabody");
  try {
    await listening();
    const key = new Uint8Array(Buffer.from(fromFragment(t.url, "k"), "base64url"));
    const page = pageSandbox("", "", true, undefined, {});
    const signed = page.tvboxSeal.lib.sign(page.tvboxSeal.lib.key(seal.keyParam(key)), "POST", "/tvbox-keepalive", "x");
    const r = await post(signed, "x").catch(() => ({ status: 0 }));
    assert.notStrictEqual(r.status, 204);
    assert.notStrictEqual(r.status, 403, "refused before the signature is even looked at");
  } finally {
    pairing.stop();
  }
});

test("a key in the fragment that is not base64 leaves the page working without one", () => {
  const strict = (s) => {
    if (s.length % 4 === 1) throw new Error("InvalidCharacterError");
    return Buffer.from(s, "base64").toString("latin1");
  };
  const page = pageSandbox("#c=4321&k=A", "", true, undefined, undefined, { atob: strict });
  assert.strictEqual(page.tvboxSeal.sealed, false);
  assert.strictEqual(page.tvboxSeal.code, "4321");
});

function askDom(hasAttr) {
  const made = [];
  const el = () => {
    const e = {
      attrs: {},
      children: [],
      listeners: {},
      value: "",
      setAttribute(n, v) {
        this.attrs[n] = v;
      },
      appendChild(c) {
        this.children.push(c);
      },
      addEventListener(n, f) {
        this.listeners[n] = f;
      },
      focus() {},
    };
    made.push(e);
    return e;
  };
  const body = el();
  return {
    made,
    body,
    document: {
      currentScript: {
        getAttribute: (n) => (n === "data-v" ? "2" : n === "data-ask-code" && hasAttr ? "" : null),
      },
      documentElement: { lang: "hu" },
      body,
      createElement: () => el(),
      addEventListener() {},
    },
  };
}

test("a typed short URL is asked for its code, and the answer reloads the page with it", () => {
  const dom = askDom(true);
  let went = null;
  const page = pageSandbox("", "", true, undefined, undefined, {
    document: dom.document,
    navigator: { language: "hu" },
  });
  page.location.replace = (u) => (went = u);
  assert.strictEqual(dom.body.children.length, 1, "the form is on the page");
  const form = dom.body.children[0];
  const input = form.children.find((c) => c.attrs.inputmode === "numeric");
  assert.match(form.children[0].textContent, /kódot/);
  input.value = "12";
  form.listeners.submit({ preventDefault() {} });
  assert.strictEqual(went, null, "a short code is not sent");
  input.value = "1 2 3 4";
  form.listeners.submit({ preventDefault() {} });
  assert.strictEqual(went, "/?c=1234");
});

test("the code form is shown only when there is neither a key nor a code, and only when asked for", () => {
  for (const [hash, search, attr] of [
    ["#c=4321&k=" + seal.keyParam(seal.newKey()), "", true],
    ["", "?c=4321", true],
    ["", "", false],
  ]) {
    const dom = askDom(attr);
    pageSandbox(hash, search, true, undefined, undefined, { document: dom.document, navigator: { language: "en" } });
    assert.strictEqual(dom.body.children.length, 0, JSON.stringify([hash, search, attr]));
  }
});
