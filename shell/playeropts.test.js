const test = require("node:test");
const assert = require("node:assert");
const { streamArgs, streamCommands, mergeStreams, propValue, subFileOf } = require("./playeropts");

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

test("the box language preference fills in only the axis the app left open", () => {
  const prefs = { audioLang: "hu", subLang: "en" };
  // App picked both: the preference stays out of it entirely.
  assert.deepStrictEqual(streamArgs({ audio: 0, sub: 1 }, prefs), ["--aid=1", "--sid=2"]);
  // App picked audio only: its subtitle language preference still applies.
  assert.deepStrictEqual(streamArgs({ audio: 0 }, prefs), ["--aid=1", "--slang=en", "--sid=auto"]);
  // App said "subtitles off": that is an opinion, and it wins over the language.
  assert.deepStrictEqual(streamArgs({ sub: -1 }, prefs), ["--alang=hu", "--sid=no"]);
  // No app opinion at all - including an empty object, which used to skip the
  // preferences entirely because it merely happened to be truthy.
  assert.deepStrictEqual(streamArgs(null, prefs), ["--alang=hu", "--slang=en", "--sid=auto"]);
  assert.deepStrictEqual(streamArgs({}, prefs), ["--alang=hu", "--slang=en", "--sid=auto"]);
  assert.deepStrictEqual(streamArgs({ audio: null, sub: null, subFile: null }, prefs), [
    "--alang=hu",
    "--slang=en",
    "--sid=auto",
  ]);
  // Junk in the settings is ignored, not passed to argv.
  assert.deepStrictEqual(streamArgs({}, { audioLang: "not a lang", subLang: "" }), []);
});

test("only subtitles can be switched off mid-playback, never the audio", () => {
  // The client sends -1 for audio when it could not match its chosen stream.
  // Reading that as "aid=no" would mute the film.
  assert.deepStrictEqual(streamCommands({ audio: -1 }), []);
  assert.deepStrictEqual(streamCommands({ audio: false }), []);
  assert.deepStrictEqual(streamCommands({ audio: -1, sub: -1 }), [["set_property", "sid", "no"]]);
});

test("a mid-playback change is folded into what a relaunch would use", () => {
  // PiP/fullscreen relaunches mpv from the remembered selection, so a track
  // picked while playing has to end up there or the next toggle undoes it.
  assert.deepStrictEqual(mergeStreams({ audio: 0, sub: -1, subFile: null }, { sub: 2 }), {
    audio: 0,
    sub: 2,
    subFile: null,
  });
  // Only the axes the change carried: switching audio leaves the subtitle be.
  assert.deepStrictEqual(mergeStreams({ audio: 0, sub: 2, subFile: null }, { audio: 1 }), {
    audio: 1,
    sub: 2,
    subFile: null,
  });
  // A sidecar and an embedded index can never both be in force.
  assert.deepStrictEqual(mergeStreams({ audio: 0, sub: 2 }, { subFile: "https://x/s.srt" }), {
    audio: 0,
    sub: null,
    subFile: "https://x/s.srt",
  });
  assert.deepStrictEqual(mergeStreams({ audio: 0, subFile: "https://x/s.srt" }, { sub: 1 }), {
    audio: 0,
    sub: 1,
    subFile: null,
  });
  assert.deepStrictEqual(mergeStreams(null, {}), { audio: null, sub: null, subFile: null });
});
