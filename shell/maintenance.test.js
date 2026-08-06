// The guards on the box's background work.
//
// What is worth pinning here is not the installing itself - that is cli.js, out
// of process, covered by install.test.js - but the answers that decide whether it
// starts at all. Getting one of those wrong means a nightly update running while
// someone is watching a film.
const test = require("node:test");
const assert = require("node:assert");

const maintenance = require("./maintenance");

function answers() {
  const seen = [];
  maintenance.init({ jsonRes: (_res, body) => seen.push(body) });
  return seen;
}

test("an app nobody has heard of is not installable", () => {
  const seen = answers();
  maintenance.startInstall("no-such-app", {});
  assert.deepStrictEqual(seen, [{ ok: false, error: "not installable" }]);
  assert.strictEqual(maintenance.isInstalling("no-such-app"), false);
});

test("deps for an unknown app are refused rather than attempted", () => {
  const seen = answers();
  maintenance.startDeps("no-such-app", {});
  assert.deepStrictEqual(seen, [{ ok: false, error: "unknown app" }]);
});

test("a flatpak update needs an app with a flatpak", () => {
  const seen = answers();
  maintenance.startFlatpakUpdate("no-such-app", {});
  assert.deepStrictEqual(seen, [{ ok: false, error: "no flatpak" }]);
});

test("an app with nothing in flight has no progress and no status", () => {
  assert.strictEqual(maintenance.progressFor("plex"), null);
  assert.strictEqual(maintenance.flatpakStatusFor("plex"), null);
  assert.deepStrictEqual(maintenance.installingIds(), []);
});

test("an idle box with nothing running is not busy", () => {
  assert.strictEqual(maintenance.busy(), false);
});

test("the background jobs refuse to start before the shell has wired them up", async () => {
  // The defaults are "not free" on purpose: a job that reads them before init
  // would decide the box is idle while the shell is still coming up.
  maintenance.init({});
  delete require.cache[require.resolve("./maintenance")];
  const fresh = require("./maintenance");

  let installed = 0;
  fresh.init({ jsonRes: () => {}, hotLoadPlugin: () => installed++ });
  await fresh.reconcileTick();
  await fresh.appsAutoTick();
  assert.strictEqual(installed, 0);
  assert.strictEqual(fresh.busy(), false);

  delete require.cache[require.resolve("./maintenance")];
});
