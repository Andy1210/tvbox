// The box's own record that onboarding is finished.
//
// The launcher keeps a copy in its localStorage for a synchronous first render, but
// that store is not always the truth: an Electron instance that lost Chromium's
// storage lock reads it EMPTY, and a fully configured box was then walked through
// setup again - and could not save the answer either, so it asked at every start.
// This is the copy that survives that, so it has to be on disk, not in memory.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-config-test-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const config = require("./config"); // resolves ~/.tvbox/config.json at import
const FILE = path.join(HOME, ".tvbox", "config.json");

test("a box that was never set up says so", () => {
  assert.strictEqual(config.publicConfig().setup.done, false);
});

test("recording it lands on disk, not just in memory", () => {
  assert.strictEqual(config.setSetupDone(), true);
  assert.strictEqual(config.publicConfig().setup.done, true);
  const onDisk = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.strictEqual(onDisk.setup.done, true);
  assert.ok(typeof onDisk.setup.at === "number", "when, for anyone debugging later");
});

test("re-confirming it keeps when onboarding actually finished", () => {
  // The launcher re-confirms this on any start where its own copy went missing, so
  // the timestamp has to survive that - otherwise it drifts to "last seen" and
  // stops answering the only question it is there for.
  const first = JSON.parse(fs.readFileSync(FILE, "utf8")).setup.at;
  config.setSetupDone();
  config.setSetupDone();
  assert.strictEqual(JSON.parse(fs.readFileSync(FILE, "utf8")).setup.at, first);
});

test("it is the launcher's only secret-free view of it", () => {
  // publicConfig is everything the launcher may see; the flag has to be in there or
  // the launcher has nothing to fall back on when its own store reads empty.
  assert.ok("setup" in config.publicConfig());
});

test("nothing else in the config is disturbed by recording it", () => {
  config.setAppConfig("plex", { baseUrl: "http://plex.example" });
  config.setSetupDone();
  assert.deepStrictEqual(config.appConfig("plex"), { baseUrl: "http://plex.example" });
  assert.strictEqual(config.publicConfig().setup.done, true);
});

test.after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
});
