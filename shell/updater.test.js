// Regression: the OTA channel must ship the SAME infra set as every other
// channel. deploy/infra.list is the single source of truth (deploy.sh rsync,
// make-release.sh / image tarballs read it), but updater.js must carry its own
// INFRA_FILES allowlist (a release may only install files the RUNNING updater
// already trusts - the list can't come from the release being installed). This
// cross-check turns "added a file to infra.list, forgot updater.js" into a CI
// failure instead of a file silently missing from OTA boxes - exactly how the
// v1.1.0 remote bridge (remote_input_bridge.py + tvbox-remote.service) went
// missing. Run: node --test shell/updater.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const updater = require("./updater");

// infra.list carries repo-relative paths; basenames land flat in ~/.tvbox and
// in a release tarball's infra/ - the basename set is what updater.js speaks.
function infraListBasenames() {
  const raw = fs.readFileSync(path.join(__dirname, "..", "deploy", "infra.list"), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => path.basename(l));
}

test("updater INFRA_FILES matches deploy/infra.list (basename set)", () => {
  const listed = infraListBasenames();
  // basenames must be unique - two entries landing on the same ~/.tvbox name
  // would silently overwrite each other in every channel
  assert.equal(new Set(listed).size, listed.length, "duplicate basenames in deploy/infra.list");
  const inList = new Set(listed);
  const inUpdater = new Set(updater.INFRA_FILES);
  const missing = [...inList].filter((f) => !inUpdater.has(f));
  const extra = [...inUpdater].filter((f) => !inList.has(f));
  assert.deepEqual(
    missing,
    [],
    "shipped per deploy/infra.list but absent from INFRA_FILES - OTA would drop: " + missing,
  );
  assert.deepEqual(
    extra,
    [],
    "in INFRA_FILES but never shipped per deploy/infra.list - dead allowlist entries: " + extra,
  );
});

test("every USER_UNIT is an INFRA_FILE (a unit must ship to be installable)", () => {
  for (const unit of updater.USER_UNITS) {
    assert.ok(updater.INFRA_FILES.includes(unit), unit + " is in USER_UNITS but not INFRA_FILES");
  }
});

// The reverse direction of the drift check: a file ADDED to the infra source
// dirs but forgotten from infra.list ships in NO channel (deploy/OTA/image all
// read the list now) - fail the build instead. NOT_SHIPPED is the conscious
// exclusion set: extend it only for files that genuinely must not ship.
test("every file in the infra source dirs is listed in infra.list or consciously excluded", () => {
  const NOT_SHIPPED = new Set([
    "deploy.sh", // the dev-deploy driver itself
    "infra.list", // the list itself
  ]);
  const listed = new Set(infraListBasenames());
  const repo = path.join(__dirname, "..");
  for (const dir of ["deploy", "cec", "remote", "gamepad"]) {
    for (const name of fs.readdirSync(path.join(repo, dir))) {
      if (!fs.statSync(path.join(repo, dir, name)).isFile()) continue; // __pycache__ etc.
      if (NOT_SHIPPED.has(name)) continue;
      // A test lives next to the script it tests (deploy/tvbox-diag.test.js, the
      // python encoders' *_test.py) and must never reach a box. Both as patterns, so
      // adding a test is not a CI failure.
      if (name.endsWith(".test.js") || name.endsWith("_test.py")) continue;
      assert.ok(
        listed.has(name),
        dir +
          "/" +
          name +
          " is not in deploy/infra.list - it ships in NO channel " +
          "(add it to the list, or to this test's NOT_SHIPPED set if that is intentional)",
      );
    }
  }
});

// OTA "enable": syncInfra creates the WantedBy symlink from UNIT_WANTS - if
// that map drifts from the units' real [Install] sections, an OTA-shipped unit
// lands on disk but never starts (exactly the v1.2.0 tvbox-remote gap).
test("UNIT_WANTS mirrors each user unit's [Install] WantedBy", () => {
  for (const unit of updater.USER_UNITS) {
    const text = fs.readFileSync(path.join(__dirname, "..", "deploy", unit), "utf8");
    const m = text.match(/^WantedBy=(\S+)/m);
    if (m) {
      assert.equal(
        updater.UNIT_WANTS[unit],
        m[1] + ".wants",
        unit + " wants " + m[1] + " but UNIT_WANTS says " + updater.UNIT_WANTS[unit],
      );
    } else {
      assert.equal(
        updater.UNIT_WANTS[unit],
        undefined,
        unit + " has no [Install] WantedBy - it must not be in UNIT_WANTS",
      );
    }
  }
});

// A release can demand something an OTA cannot bring - the compositor, the session
// greetd starts, an apt package - and the point of the gate is that a box which
// cannot satisfy it is never offered the update rather than being half-broken by
// it. The check runs against a real socket path, so this drives it through
// compositor.available().
test("a release that needs the compositor is not offered to a box without one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-updater-"));
  const socketPath = path.join(dir, "tvbox-wc.sock");
  process.env.TVBOX_WC_SOCKET = socketPath;
  delete require.cache[require.resolve("./compositor")];
  delete require.cache[require.resolve("./updater")];
  const fresh = require("./updater");

  const feed = {
    feedVersion: 1,
    version: "99.0.0",
    url: "https://x/y.tgz",
    sha256: "a".repeat(64),
    requires: ["compositor"],
  };

  assert.deepStrictEqual(fresh.unmetRequirements(feed), ["compositor"]);
  assert.deepStrictEqual(fresh.unmetRequirements({ ...feed, requires: [] }), []);
  // Fail closed: a requirement this shell has never heard of is one it does not meet.
  assert.deepStrictEqual(fresh.unmetRequirements({ ...feed, requires: ["time-travel"] }), ["time-travel"]);
  // And a `requires` that is not a list at all is a broken feed, not an empty one.
  for (const bad of ["compositor", { compositor: true }, 1, true]) {
    assert.deepStrictEqual(fresh.unmetRequirements({ ...feed, requires: bad }), ["malformed-requires"], String(bad));
  }

  // listen() creates the socket file asynchronously, and the check that follows is a
  // stat: without waiting, this passes or fails on timing rather than on the code.
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(socketPath, resolve));
  assert.deepStrictEqual(fresh.unmetRequirements(feed), [], "a box with the socket meets it");

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TVBOX_WC_SOCKET;
  delete require.cache[require.resolve("./compositor")];
  delete require.cache[require.resolve("./updater")];
});
