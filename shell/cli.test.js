// Unit tests for the security-critical bits of the tvbox CLI. Focus:
// aptRepoPlan - the pure validator behind `tvbox deps`'s third-party APT repo
// support (the only manifest-driven path that runs apt/gpg as root). Keeping it
// pure keeps these rules testable without touching sudo/curl.
// Run: node --test shell/cli.test.js
const test = require("node:test");
const assert = require("node:assert");
const cli = require("./cli");

const KEYRING = "/usr/share/keyrings/tvbox-spotify.gpg";
const okLine = "deb [signed-by=" + KEYRING + "] https://dtcooper.github.io/raspotify raspotify main";
const base = { keyUrl: "https://example.com/key.asc", line: okLine };

test("aptRepoPlan: accepts a well-formed repo and derives tvbox-owned paths", () => {
  const plan = cli.aptRepoPlan({ id: "spotify" }, base);
  assert.equal(plan.keyring, KEYRING);
  assert.equal(plan.listPath, "/etc/apt/sources.list.d/tvbox-spotify.list");
  assert.equal(plan.keyUrl, base.keyUrl);
});

test("aptRepoPlan: rejects a foreign keyring in signed-by (no system-keyring clobber)", () => {
  const line = "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://x/ y main";
  assert.throws(() => cli.aptRepoPlan({ id: "spotify" }, { keyUrl: base.keyUrl, line }), /signed-by/);
});

test("aptRepoPlan: rejects trusted=yes, plain-http repo, and a missing signed-by", () => {
  assert.throws(
    () => cli.aptRepoPlan({ id: "spotify" }, { keyUrl: base.keyUrl, line: "deb [trusted=yes] https://x/ y main" }),
    /signed-by|options/,
  );
  assert.throws(
    () =>
      cli.aptRepoPlan({ id: "spotify" }, { keyUrl: base.keyUrl, line: "deb [signed-by=" + KEYRING + "] http://x/ y" }),
    /deb \[/,
  );
  assert.throws(
    () => cli.aptRepoPlan({ id: "spotify" }, { keyUrl: base.keyUrl, line: "deb https://x/ y main" }),
    /deb \[/,
  );
});

test("aptRepoPlan: rejects a non-https keyUrl and a bad app id", () => {
  assert.throws(() => cli.aptRepoPlan({ id: "spotify" }, { keyUrl: "http://x/key.asc", line: okLine }), /keyUrl/);
  assert.throws(() => cli.aptRepoPlan({ id: "spotify" }, { keyUrl: "https://", line: okLine }), /keyUrl/); // no host
  assert.throws(() => cli.aptRepoPlan({ id: "../evil" }, base), /invalid app id/);
  assert.throws(() => cli.aptRepoPlan({ id: "Spotify" }, base), /invalid app id/); // lowercase-only, like the rest of the stack
});
