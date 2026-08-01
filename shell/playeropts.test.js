const test = require("node:test");
const assert = require("node:assert");
const { streamArgs, streamCommands, propValue, subFileOf } = require("./playeropts");

test("an app's 0-based ordinals become mpv's 1-based aid/sid", () => {
  assert.deepStrictEqual(streamArgs({ audio: 0, sub: 1 }), ["--aid=1", "--sid=2"]);
  assert.deepStrictEqual(streamCommands({ audio: 1, sub: 0 }), [
    ["set_property", "aid", 2],
    ["set_property", "sid", 1],
  ]);
});

test("subtitles off is spelled out, and is not the same as saying nothing", () => {
  // The whole point: without --sid=no mpv turns on whatever track carries the
  // container's default flag, which is what put Hungarian subtitles on a film
  // Plex started with subtitles disabled.
  assert.deepStrictEqual(streamArgs({ audio: 0, sub: -1 }), ["--aid=1", "--sid=no"]);
  assert.deepStrictEqual(streamCommands({ sub: -1 }), [["set_property", "sid", "no"]]);
  assert.deepStrictEqual(streamArgs({ audio: 0 }), ["--aid=1"]);
  assert.deepStrictEqual(streamCommands({}), []);
  assert.deepStrictEqual(streamCommands({ audio: null, sub: undefined }), []);
});

test("a sidecar subtitle wins over any index sent with it", () => {
  const sel = { audio: 0, sub: 3, subFile: "https://plex.example/sub.srt" };
  assert.deepStrictEqual(streamArgs(sel), ["--aid=1", "--sub-file=https://plex.example/sub.srt"]);
  assert.deepStrictEqual(streamCommands(sel), [["sub-add", "https://plex.example/sub.srt", "select"]]);
});

test("a subtitle file that isn't an http(s) URL is refused, not passed to argv", () => {
  for (const bad of ["/etc/passwd", "file:///etc/passwd", "-o=x", "", null, 5]) {
    assert.strictEqual(subFileOf({ subFile: bad }), null, String(bad));
    // ...and it must not silently turn into "play with whatever mpv picks":
    // the index that came with it still applies.
    assert.deepStrictEqual(streamArgs({ sub: 0, subFile: bad }), ["--sid=1"]);
  }
});

test("nonsense ordinals are dropped rather than guessed", () => {
  for (const bad of [1.5, -2, 100, "1", NaN, {}]) {
    assert.deepStrictEqual(streamArgs({ audio: bad }), [], String(bad));
  }
  assert.deepStrictEqual(streamArgs(null), []);
  assert.deepStrictEqual(streamCommands(undefined), []);
});

test("only allowlisted properties, only in range", () => {
  assert.strictEqual(propValue("sub-delay", -1.5), -1.5);
  assert.strictEqual(propValue("speed", 1.5), 1.5);
  assert.strictEqual(propValue("sub-color", "#ff00aa"), "#ff00aa");
  assert.strictEqual(propValue("sub-visibility", false), false);
  assert.strictEqual(propValue("volume", 0), 0);

  assert.strictEqual(propValue("speed", 99), null, "out of range");
  assert.strictEqual(propValue("sub-delay", "1.5"), null, "a string is not a number");
  assert.strictEqual(propValue("sub-color", "red"), null, "colours must be #hex");
  assert.strictEqual(propValue("volume", NaN), null);
  assert.strictEqual(propValue("sub-visibility", 1), null, "1 is not a boolean");
});

test("the allowlist is a list, not a prototype walk", () => {
  // A renderer that asks for "constructor" or "toString" must be refused like
  // any other unknown property.
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "script-opts", "sub-file"]) {
    assert.strictEqual(propValue(name, "x"), null, name);
  }
});
