const test = require("node:test");
const assert = require("node:assert");
const { redact } = require("./redact");

test("a Plex media URL keeps everything but the token", () => {
  const url =
    "https://192-168-1-19.53889e1ea4ea4c7694aaf863a70ca604.plex.direct:32400/library/parts/156135/1761584675/" +
    "file.mkv?X-Plex-Token=GMsnae688xzreM9mRyuC&X-Plex-Model=Gecko&X-Plex-Version=5.91.0";
  const out = redact(url);
  assert.ok(!out.includes("GMsnae688xzreM9mRyuC"), "the token is gone");
  assert.ok(out.includes("X-Plex-Token=REDACTED"));
  // The rest is what makes a log line worth keeping.
  assert.ok(out.includes("/library/parts/156135/"));
  assert.ok(out.includes("X-Plex-Version=5.91.0"));
});

test("the parameter that follows a redacted one survives", () => {
  // The value match must stop at the separator, or everything after the token
  // would be swallowed and the line would lose its meaning.
  assert.strictEqual(redact("?token=abc123&next=keepme"), "?token=REDACTED&next=keepme");
  assert.strictEqual(redact("?a=1;password=hunter2;b=2"), "?a=1;password=REDACTED;b=2");
});

test("case and position do not matter", () => {
  for (const name of ["X-Plex-Token", "x-plex-token", "TOKEN", "Api_Key", "access_token"]) {
    const out = redact("https://x/y?first=1&" + name + "=sensitive");
    assert.ok(!out.includes("sensitive"), name);
  }
});

test("a token logged as a JSON field is caught too", () => {
  const line = '{"url":"https://x/y","token":"abc123","volume":50}';
  const out = redact(line);
  assert.ok(!out.includes("abc123"));
  assert.ok(out.includes('"volume":50'), "the rest of the payload is intact");
});

test("lines with nothing to hide come back untouched", () => {
  for (const s of [
    "[player] action queue https://plex.direct:32400/library/parts/1/file.mkv",
    "?tokenish=notasecret",
    "playback state changed to: paused",
    "",
  ]) {
    assert.strictEqual(redact(s), s, JSON.stringify(s));
  }
});

test("non-strings pass through rather than throwing", () => {
  for (const v of [null, undefined, 5, {}]) assert.strictEqual(redact(v), v);
});
