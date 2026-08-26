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

test("credentials in a URL PATH are why a log line gets an origin, not a slice", () => {
  // redact() handles name=value, which is where a Plex token lives. An IPTV URL
  // puts the username and password in the path instead, and no denylist of
  // parameter names can catch that - which is why the player log prints the
  // origin and never the URL (see originOf in main.js).
  const iptv = "http://live.example.net:8080/live/myuser/mypassword/12345.ts";
  assert.strictEqual(redact(iptv), iptv, "nothing here looks like a parameter, and nothing is redacted");
  assert.ok(iptv.slice(0, 55).includes("mypassword"), "a slice of it leaks the password");
  assert.strictEqual(new URL(iptv).origin, "http://live.example.net:8080", "the origin carries none of it");
});

test("an exception carries its secrets in shapes a query string never had", () => {
  // The three below all reached shell.log unredacted, which tvbox-diag copies onto
  // the FAT boot partition. They matter more since the shell writes an uncaught
  // exception's stack to a file of its own: that text is whatever threw, not a line
  // this repo wrote, so it is the one log channel nobody here curates.
  assert.strictEqual(redact("X-Plex-Token: abc123def"), "X-Plex-Token: REDACTED");
  assert.strictEqual(redact("  Authorization: Bearer eyJhbGciOi"), "  Authorization: REDACTED");
  assert.strictEqual(redact("Cookie: PHPSESSID=deadbeef"), "Cookie: REDACTED");
  assert.strictEqual(
    redact("connect mqtt://tvbox:hunter2@192.168.1.19:1884"),
    "connect mqtt://tvbox:REDACTED@192.168.1.19:1884",
    "the user is kept: it is what makes the line worth reading, and it is not the secret",
  );
  assert.strictEqual(
    redact("Error: Command failed: nmcli device wifi connect Home password hunter2"),
    "Error: Command failed: nmcli REDACTED",
    "the program is the diagnostic part; its arguments carry the PSK",
  );
  // Only one line of a multi-line stack is the header.
  const stack = "Error: boom\n    at f (/home/tv/.tvbox/shell/main.js:1:1)\nX-Plex-Token: abc";
  assert.ok(stack.includes("at f ("));
  assert.ok(redact(stack).includes("at f (/home/tv/.tvbox/shell/main.js:1:1)"), "the frames survive");
  assert.ok(!redact(stack).includes("abc"));
});

test("the new shapes do not eat ordinary text", () => {
  for (const s of [
    "authorization is required for this endpoint",
    "at Object.token (/home/tv/.tvbox/shell/main.js:12:3)",
    "https://user@host/path",
    "the Command failed: mid-sentence",
    "a cookie: something sweet", // not at the start of a line
  ]) {
    assert.strictEqual(redact(s), s, JSON.stringify(s));
  }
});
