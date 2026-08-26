// The credential two boxes pair on, and what an app may ask about its own shares.
//
// A key is minted under a placeholder id and adopted when the answer names the
// box, so every way that sequence can be interrupted leaves a working credential
// somebody holds. "Forget this box" has to be able to reach all of them.
const test = require("node:test");
const assert = require("node:assert");

const sharing = require("./sharing");

// A whole box: a config that remembers, the manifests' shares, and the peer rules.
function boot(opts) {
  const o = opts || {};
  const cfg = { appshares: { enabled: [], peers: [], issued: [], port: 8098, ...(o.appshares || {}) } };
  let issuedCount = 0;
  const log = { applied: 0 };
  sharing.init({
    config: {
      rawAppshares: () => JSON.parse(JSON.stringify(cfg.appshares)),
      setAppshares: (patch) => Object.assign(cfg.appshares, patch),
      rawFileserver: () => ({ enabled: false }),
      rawShares: () => [],
    },
    apps: {
      onPath: (b) => (o.onPath || []).includes(b),
      getManifests: () => [],
      appShareRoot: () => null,
    },
    appshares: {
      entries: () => o.entries || [],
      start: () => ((log.applied += 1), { ok: true, shared: [], port: 8098 }),
      stop: () => {
        log.applied += 1;
      },
      status: () => ({ ok: true }),
      newCredential: () => ({ user: "u" + ++issuedCount, secret: "s" + issuedCount }),
      hashSecret: (s) => "hash:" + s,
      portOf: (p) => p || 8098,
      ensureDir: () => true,
    },
    fileserver: { start: () => ({ ok: true, shared: [] }), stop: () => {}, status: () => ({}) },
    shares: { apply: () => ({ ok: true, mounted: [] }), status: () => ({}), obscure: (t) => "obscured:" + t },
    peers: {
      onLocalSubnet: (h) => String(h).startsWith("192.168.1."),
      groupNameOk: (g) => /^[a-z0-9 _-]+$/i.test(g),
      lsArgv: () => ["rclone", "lsjson"],
      pullArgv: () => ["rclone", "copy"],
      compareListings: () => ({ newer: 1 }),
      REPLACED: "/tmp/replaced",
    },
    identity: { defaultDeviceId: () => "tvbox-here", hostname: () => "tvbox-here" },
    supervisor: {},
    childEnv: () => ({}),
    installDeps: (done) => (o.installDeps ? o.installDeps(done) : done()),
  });
  return { cfg: cfg.appshares, log };
}

const entry = (id, appId) => ({
  id,
  appId: appId || id,
  name: id,
  present: true,
  path: "/p/" + id,
  root: "/p",
  exclude: [],
});

// ---- remembering the other box ----

test("a peer off this box's own subnet is refused", () => {
  const { cfg } = boot();
  assert.equal(sharing.rememberPeer({ id: "b", name: "B", host: "10.0.0.9" }), false);
  assert.deepEqual(cfg.peers, []);
});

test("a peer on the subnet is remembered, and re-pairing REPLACES rather than appends", () => {
  // A key is reissued each time, and a stale row would be tried first.
  const { cfg } = boot();
  assert.equal(sharing.rememberPeer({ id: "b", name: "B", host: "192.168.1.5", token: "t1" }), true);
  assert.equal(sharing.rememberPeer({ id: "b", name: "B", host: "192.168.1.5", token: "t2" }), true);
  assert.equal(cfg.peers.length, 1);
  assert.equal(cfg.peers[0].token, "t2");
});

test("an id that already names a DIFFERENT box is refused - a peer id is a guessable hostname", () => {
  const { cfg } = boot({ appshares: { peers: [{ id: "b", name: "B", host: "192.168.1.5" }] } });
  assert.equal(sharing.rememberPeer({ id: "b", name: "Me", host: "192.168.1.99" }), false);
  assert.equal(cfg.peers[0].host, "192.168.1.5", "a caller must not repoint the room next door at itself");
});

// ---- the key this box hands out ----

test("a box that is offering nothing has no key to give", () => {
  boot({ entries: [entry("saves")], appshares: { enabled: [] } });
  assert.equal(sharing.issueShareKey({ id: "them" }), null);
});

test("an enabled share whose app has been uninstalled is not offering anything either", () => {
  // The list stays non-empty while the server refuses to start on "nothing
  // shared", so a peer would pair happily and be refused on its first pull.
  boot({ entries: [], appshares: { enabled: ["saves"] } });
  assert.equal(sharing.issueShareKey({ id: "them" }), null);
});

test("a key is issued, recorded by its HASH, and names this box", () => {
  const { cfg } = boot({ entries: [entry("saves")], appshares: { enabled: ["saves"] } });
  const key = sharing.issueShareKey({ id: "them", name: "Them" });
  assert.equal(key.id, "tvbox-here");
  assert.equal(key.user, "u1");
  assert.equal(key.token, "s1");
  assert.equal(cfg.issued.length, 1);
  assert.equal(cfg.issued[0].hash, "hash:s1");
  assert.ok(!("token" in cfg.issued[0]) && !("secret" in cfg.issued[0]), "the secret itself is never stored");
});

test("a nameless box files the key under its own user name until it is adopted", () => {
  const { cfg } = boot({ entries: [entry("saves")], appshares: { enabled: ["saves"] } });
  const key = sharing.issueShareKey(null);
  assert.equal(cfg.issued[0].id, key.user);
  sharing.adoptShareKey(key, { id: "them", name: "Them" });
  assert.equal(cfg.issued[0].id, "them");
  assert.equal(cfg.issued[0].name, "Them");
  assert.equal(cfg.issued[0].user, key.user, "the credential itself does not change on adoption");
});

test("issuing again for the same box replaces its row rather than adding one", () => {
  const { cfg } = boot({ entries: [entry("saves")], appshares: { enabled: ["saves"] } });
  sharing.issueShareKey({ id: "them" });
  sharing.issueShareKey({ id: "them" });
  assert.equal(cfg.issued.length, 1);
  assert.equal(cfg.issued[0].user, "u2");
});

test("a box's name is bounded - it arrives from the other box", () => {
  const { cfg } = boot({ entries: [entry("saves")], appshares: { enabled: ["saves"] } });
  sharing.issueShareKey({ id: "them", name: "N".repeat(500) });
  assert.equal(cfg.issued[0].name.length, 64);
});

test("adopting a key nobody minted does nothing", () => {
  const { cfg } = boot({ entries: [entry("saves")], appshares: { enabled: ["saves"], issued: [] } });
  sharing.adoptShareKey({ user: "ghost" }, { id: "them", name: "Them" });
  assert.deepEqual(cfg.issued, []);
  sharing.adoptShareKey(null, { id: "them" });
  sharing.adoptShareKey({ user: "u" }, null);
});

test("adoption does not leave a second row for the same box", () => {
  const { cfg } = boot({
    entries: [entry("saves")],
    appshares: { enabled: ["saves"], issued: [{ id: "them", name: "Them", user: "old", hash: "h" }] },
  });
  const key = sharing.issueShareKey(null);
  sharing.adoptShareKey(key, { id: "them", name: "Them" });
  assert.equal(cfg.issued.length, 1, "the old row for that box is replaced, not kept beside the new one");
  assert.equal(cfg.issued[0].user, key.user);
});

// ---- the keys nobody is named on ----

test("a key left by a shell that exited mid-pairing is dropped at startup", () => {
  const { cfg } = boot({
    appshares: {
      peers: [{ id: "them", host: "192.168.1.5" }],
      issued: [
        { id: "them", user: "kept", hash: "h" },
        { id: "u9", user: "u9", hash: "h" }, // still under its placeholder: nobody is named on it
      ],
    },
  });
  sharing.pruneOrphanShareKeys();
  assert.deepEqual(
    cfg.issued.map((x) => x.user),
    ["kept"],
  );
});

test("with nothing to drop, the config is not rewritten", () => {
  const { cfg } = boot({
    appshares: { peers: [{ id: "them", host: "192.168.1.5" }], issued: [{ id: "them", user: "kept", hash: "h" }] },
  });
  const before = cfg.issued;
  sharing.pruneOrphanShareKeys();
  assert.equal(cfg.issued, before, "same array: setAppshares was never called");
});

test("a key handed to something that was not a box is removed, not left to expire", () => {
  const { cfg } = boot({
    entries: [entry("saves")],
    appshares: {
      enabled: ["saves"],
      issued: [
        { id: "a", user: "u1", hash: "h" },
        { id: "b", user: "u2", hash: "h" },
      ],
    },
  });
  sharing.revokeShareKey({ user: "u1" });
  assert.deepEqual(
    cfg.issued.map((x) => x.user),
    ["u2"],
  );
  sharing.revokeShareKey(null);
  sharing.revokeShareKey({});
  assert.equal(cfg.issued.length, 1);
});

// ---- applying what is enabled ----

test("an enabled id no installed app declares any more is dropped from the list", () => {
  // Otherwise the screen offers nothing to switch off: it is built from the
  // manifests, so the stale entry is invisible there.
  const { cfg } = boot({ entries: [entry("saves")], appshares: { enabled: ["saves", "gone"] } });
  sharing.applyAppshares();
  assert.deepEqual(cfg.enabled, ["saves"]);
});

test("with nothing left enabled the server is stopped rather than started", () => {
  const { cfg } = boot({ entries: [], appshares: { enabled: ["gone"] } });
  const r = sharing.applyAppshares();
  assert.deepEqual(r, { ok: true, stopped: true });
  assert.deepEqual(cfg.enabled, []);
});

// ---- the shares capability, scoped to the calling app ----

test("an app sees its OWN shares and the peers, and never a token", async () => {
  boot({
    entries: [entry("saves", "retroarch"), entry("photos", "gallery")],
    appshares: {
      enabled: ["saves"],
      peers: [{ id: "them", name: "Them", host: "192.168.1.5", user: "u", token: "SECRET" }],
    },
  });
  const r = await sharing.appSharesCall("retroarch", "list");
  assert.deepEqual(r.shares, [{ id: "saves", name: "saves", present: true, on: true }]);
  assert.deepEqual(r.peers, [{ id: "them", name: "Them" }]);
  assert.equal(JSON.stringify(r).includes("SECRET"), false);
  assert.equal(JSON.stringify(r).includes("192.168.1.5"), false, "an app is handed a name, not an address");
});

test("another app's share is refused even when it is named", async () => {
  boot({ entries: [entry("saves", "retroarch"), entry("photos", "gallery")] });
  for (const action of ["compare", "pull"]) {
    const r = await sharing.appSharesCall("gallery", action, { shareId: "saves", peerId: "them" });
    assert.deepEqual(r, { ok: false, error: "unknown_share" }, action);
  }
});

test("a share the owner switched OFF can still be pulled into - the toggle is outbound", async () => {
  // Settings calls that group "what this box offers", so the switch governs what
  // is SERVED. Gating a pull on it would break the one-way pairing the launcher
  // has a sentence for: a box that offers nothing has no key to give, and could
  // then no longer bring anything here either.
  boot({ entries: [entry("saves", "retroarch")], onPath: ["rclone"], appshares: { enabled: [] } });
  const listed = await sharing.appSharesCall("retroarch", "list");
  assert.equal(listed.shares[0].on, false, "the app is told it is not being offered");
  // …and the pull gets as far as the peer lookup rather than being refused for
  // being switched off.
  const r = await sharing.appSharesCall("retroarch", "pull", { shareId: "saves", peerId: "nobody" });
  assert.deepEqual(r, { ok: false, error: "unknown_peer" });
});

test("an unknown action is refused", async () => {
  boot({ entries: [] });
  assert.deepEqual(await sharing.appSharesCall("x", "delete"), { ok: false, error: "unknown shares action" });
});

test("a pull with no rclone says so rather than half-running", async () => {
  boot({ entries: [entry("saves", "retroarch")], appshares: { peers: [{ id: "them", user: "u", token: "t" }] } });
  const r = await sharing.appSharesCall("retroarch", "pull", { shareId: "saves", peerId: "them" });
  assert.deepEqual(r, { ok: false, error: "rclone_missing" });
});

test("a pull names a peer this box has actually paired with", async () => {
  boot({ entries: [entry("saves", "retroarch")], onPath: ["rclone"] });
  const r = await sharing.appSharesCall("retroarch", "pull", { shareId: "saves", peerId: "nobody" });
  assert.deepEqual(r, { ok: false, error: "unknown_peer" });
});

test("a group name from a renderer is held to a name, never a path", () => {
  boot({ entries: [entry("saves", "retroarch")], appshares: { peers: [{ id: "them", user: "u", token: "t" }] } });
  const r = sharing.pullAppshare("them", "saves", "../../etc");
  assert.deepEqual(r, { ok: false, error: "unknown_group" });
});

test("compare refuses before it spawns anything it cannot reach", async () => {
  boot({ entries: [entry("saves")], appshares: { peers: [{ id: "them", user: "u", token: "t" }] } });
  assert.deepEqual(await sharing.compareAppshare("nobody", "saves"), { ok: false, error: "unknown_peer" });
  assert.deepEqual(await sharing.compareAppshare("them", "nothing"), { ok: false, error: "unknown_share" });
  assert.deepEqual(await sharing.compareAppshare("them", "saves"), { ok: false, error: "rclone_missing" });
});

// ---- the binary both features run on ----

test("installing rclone runs once, and starts what was waiting for it", () => {
  let finish = null;
  const { log } = boot({
    entries: [entry("saves")],
    appshares: { enabled: ["saves"] },
    installDeps: (done) => {
      finish = done;
    },
  });
  assert.equal(sharing.installRclone(), true);
  assert.equal(sharing.isInstallingRclone(), true);
  assert.equal(sharing.installRclone(), false, "a second press must not start a second download");
  const before = log.applied;
  finish();
  assert.equal(sharing.isInstallingRclone(), false);
  assert.equal(log.applied, before, "rclone still is not on PATH, so nothing was started");
});

test("with rclone already there, nothing is downloaded", () => {
  boot({ onPath: ["rclone"] });
  assert.equal(sharing.installRclone(), false);
});
