// Tests for finding the other box and taking a credential from it. Nothing here
// touches the network: the sweep, the HTTP fetch and the clock are injected, so
// what is under test is the decisions - which hosts count as a box, which
// answers are refused, and what never reaches a command line.
const test = require("node:test");
const assert = require("node:assert");
const peers = require("./peers");

test("the sweep covers the box's own /24 and nothing wider", () => {
  const pick = (ifaces) => peers.localSubnet(ifaces);
  assert.deepStrictEqual(
    pick({ wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.24", netmask: "255.255.255.0" }] }),
    { prefix: "192.168.1", self: "192.168.1.24" },
  );
  assert.equal(pick({ lo: [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }] }), null);
  assert.equal(
    pick({ eth0: [{ family: "IPv4", internal: false, address: "10.0.0.5", netmask: "255.255.0.0" }] }),
    null,
    "a /16 is more addresses than a sweep should touch",
  );
});

test("only a box that answers with the marker counts as one", async () => {
  const openHosts = new Set(["192.168.1.7", "192.168.1.9"]);
  const pages = {
    "192.168.1.7": { status: 200, body: "<html><!-- " + peers.MARKER + " --></html>" },
    "192.168.1.9": { status: 200, body: "<html>some other device</html>" },
  };
  const found = await peers.scan({
    localSubnet: () => ({ prefix: "192.168.1", self: "192.168.1.24" }),
    portOpen: async (host) => openHosts.has(host),
    get: async (url) => pages[new URL(url).hostname] || null,
  });
  assert.deepStrictEqual(found, [{ host: "192.168.1.7" }]);
});

test("the sweep never asks the box about itself", async () => {
  const asked = [];
  await peers.scan({
    localSubnet: () => ({ prefix: "192.168.1", self: "192.168.1.24" }),
    portOpen: async (host) => {
      asked.push(host);
      return false;
    },
    get: async () => null,
  });
  assert.equal(asked.length, 253, "254 addresses less this box");
  assert.ok(!asked.includes("192.168.1.24"));
});

test("a wrong code, an unreachable box and a stranger are each their own failure", async () => {
  const answer = (r) => peers.pairWith("192.168.1.7", "1234", { get: async () => r });
  assert.deepStrictEqual(await answer(null), { ok: false, error: "unreachable" });
  assert.deepStrictEqual(await answer({ status: 403, body: "" }), { ok: false, error: "bad_code" });
  assert.deepStrictEqual(await answer({ status: 500, body: "" }), { ok: false, error: "refused" });
  assert.deepStrictEqual(await answer({ status: 200, body: "not json" }), { ok: false, error: "not_a_box" });
  assert.deepStrictEqual(
    await answer({ status: 200, body: JSON.stringify({ name: "x" }) }),
    { ok: false, error: "not_a_box" },
    "a box that is not sharing has no token to give",
  );
});

test("a paired box is remembered by where it answered, not by what it claims", async () => {
  const r = await peers.pairWith("192.168.1.7", "1234", {
    get: async () => ({
      status: 200,
      body: JSON.stringify({ id: "tvbox-gaming", name: "Gaming", port: 8096, token: "tok", host: "10.0.0.1" }),
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.peer.host, "192.168.1.7", "the address it answered on, not one it sent");
  assert.deepStrictEqual(r.peer, { id: "tvbox-gaming", name: "Gaming", host: "192.168.1.7", port: 8096, token: "tok" });
});

test("a pull reads from the peer, writes into one place, and keeps what it replaces", () => {
  const argv = peers.pullArgv(
    { host: "192.168.1.7", port: 8096, token: "secret-token" },
    "retroarch/saves",
    "/home/tv/.var/app/org.libretro.RetroArch/config/retroarch/saves",
    "/home/tv/.cache/tvbox/appshares-replaced/2026",
  );
  assert.deepStrictEqual(argv.slice(0, 3), ["rclone", "copy", ":webdav:retroarch/saves"]);
  assert.equal(argv[3], "/home/tv/.var/app/org.libretro.RetroArch/config/retroarch/saves");
  assert.ok(argv.includes("--backup-dir"), "a replaced save is moved aside, not lost");
  assert.ok(!argv.join(" ").includes("secret-token"), "the credential goes through the environment");
  assert.ok(!argv.includes("sync"), "copy, never sync: a pull must not delete on either side");
});
