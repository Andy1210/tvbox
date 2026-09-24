// The now-playing claim: what survives into MQTT, HOME and Home Assistant.
const test = require("node:test");
const assert = require("node:assert");

const nowplaying = require("./nowplaying");

test("an app's claim is about itself, whatever the body says", () => {
  assert.strictEqual(nowplaying.sanitize({ app: "spotify", state: "playing" }, "files").app, "files");
  assert.strictEqual(nowplaying.sanitize({ app: "spotify", state: "playing" }, null).app, "spotify");
});

test("only the fields the readers use survive, each bounded", () => {
  const out = nowplaying.sanitize(
    { app: "x", state: "playing", title: "a\u0000b".padEnd(1000, "c"), extra: { deep: 1 }, position: -1, duration: 12 },
    null,
  );
  assert.deepStrictEqual(Object.keys(out).sort(), ["app", "duration", "state", "title"]);
  assert.strictEqual(out.title.length, nowplaying.MAX_TEXT);
  assert.ok(!out.title.includes("\u0000"));
  assert.strictEqual(nowplaying.sanitize({ state: "haunted" }, "x").state, "idle");
});

test("artwork is an http(s) URL or an inline image, nothing else", () => {
  const img = (image) => nowplaying.sanitize({ state: "playing", image }, "x").image;
  assert.strictEqual(img("https://cdn.example/a.jpg"), "https://cdn.example/a.jpg");
  assert.strictEqual(img("http://10.0.0.5:32400/t?X-Token=1"), "http://10.0.0.5:32400/t?X-Token=1");
  assert.ok(img("data:image/png;base64,iVBORw0KGgo="));
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "http://u:p@h/x", "data:text/html,<b>", 5])
    assert.strictEqual(img(bad), undefined, String(bad));
});

test("a playing claim with no page left is believed for a while, then not", () => {
  const np = { app: "spotify", state: "playing" };
  const at = 1_000_000;
  assert.strictEqual(nowplaying.stillPlaying(np, at, at + 60_000, false), true);
  assert.strictEqual(nowplaying.stillPlaying(np, at, at + nowplaying.ORPHAN_TRUST_MS + 1, false), false);
  assert.strictEqual(nowplaying.stillPlaying(np, at, at + 10 * nowplaying.ORPHAN_TRUST_MS, true), true);
  assert.strictEqual(nowplaying.stillPlaying({ ...np, state: "paused" }, at, at, true), false);
});
