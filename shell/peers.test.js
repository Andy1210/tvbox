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

test("only an address the sweep could have produced counts as a peer", () => {
  const ifaces = { wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.24", netmask: "255.255.255.0" }] };
  assert.equal(peers.onLocalSubnet("192.168.1.7", ifaces), true);
  assert.equal(peers.onLocalSubnet("192.168.1.24", ifaces), false, "this box is not its own peer");
  assert.equal(peers.onLocalSubnet("192.168.2.7", ifaces), false, "another subnet never came from a sweep");
  assert.equal(peers.onLocalSubnet("8.8.8.8", ifaces), false);
  for (const junk of ["192.168.1.999", "192.168.1", "192.168.1.7.7", "", "evil.example", null])
    assert.equal(peers.onLocalSubnet(junk, ifaces), false, JSON.stringify(junk));
});

test("an answer that does not fit is refused here, not dropped later", async () => {
  const answer = (obj) =>
    peers.pairWith("192.168.1.7", "1234", { post: async () => ({ status: 200, body: JSON.stringify(obj) }) });
  // Each of these used to come back ok and then vanish in the config store, which
  // told the user they were paired with a box that was not there.
  for (const bad of [
    { name: "x", user: "box-a1", token: "t", port: "not a number" },
    { name: "x", user: "box-a1", token: "t", port: 0 },
    { name: "x", user: "box-a1", token: "t", port: 70000 },
    { name: "x", user: "box-a1", token: 5, port: 8096 },
    { name: "", user: "box-a1", token: "t", port: 8096 },
    { name: "x", user: "box-a1", token: "t".repeat(300), port: 8096 },
    // A key is useless without the name it was minted under, and a user name that
    // is not one would end up in an Authorization header.
    { name: "x", token: "t", port: 8096 },
    { name: "x", user: "box a1:", token: "t", port: 8096 },
  ]) {
    assert.deepStrictEqual(await answer(bad), { ok: false, error: "not_a_box" }, JSON.stringify(bad));
  }
  const ok = await answer({ name: "gaming", user: "box-a1", token: "t", port: 8096 });
  assert.equal(ok.peer.id, "gaming", "a box that sends no id is known by its name");
});

test("a wrong code, an unreachable box and a stranger are each their own failure", async () => {
  const answer = (r) => peers.pairWith("192.168.1.7", "1234", { post: async () => r });
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
    post: async () => ({
      status: 200,
      body: JSON.stringify({
        id: "tvbox-gaming",
        name: "Gaming",
        port: 8096,
        user: "box-a1",
        token: "tok",
        host: "10.0.0.1",
      }),
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.peer.host, "192.168.1.7", "the address it answered on, not one it sent");
  assert.deepStrictEqual(r.peer, {
    id: "tvbox-gaming",
    name: "Gaming",
    host: "192.168.1.7",
    port: 8096,
    user: "box-a1",
    token: "tok",
  });
});

test("a pull reads from the peer, writes into one place, and keeps what it replaces", () => {
  const argv = peers.pullArgv(
    { host: "192.168.1.7", port: 8096, user: "box-a1", token: "secret-token" },
    "retroarch/saves",
    "/home/tv/.var/app/org.libretro.RetroArch/config/retroarch/saves",
    "/home/tv/.cache/tvbox/appshares-replaced/2026",
    ["**/Cache/**", "**/Logs/**"],
  );
  assert.deepStrictEqual(argv.slice(0, 3), ["rclone", "copy", ":webdav:retroarch/saves"]);
  assert.equal(argv[3], "/home/tv/.var/app/org.libretro.RetroArch/config/retroarch/saves");
  assert.ok(argv.includes("--backup-dir"), "a replaced save is moved aside, not lost");
  assert.ok(!argv.join(" ").includes("secret-token"), "the credential goes through the environment");
  // The user name is not secret - it is a random label, and it has to match the
  // line that box wrote for this one in its own key file.
  assert.deepStrictEqual(
    argv.filter((a, i) => argv[i - 1] === "--webdav-user"),
    ["box-a1"],
  );
  assert.ok(!argv.includes("sync"), "copy, never sync: a pull must not delete on either side");
  // The app's own list of what is not a save. Without it the first pull of an
  // emulator's saves drags its shader cache across, which is hundreds of megabytes
  // and rebuilt on arrival anyway.
  assert.deepStrictEqual(
    argv.filter((a, i) => argv[i - 1] === "--exclude"),
    ["**/Cache/**", "**/Logs/**"],
  );
});

test("a share with nothing to exclude passes no filters at all", () => {
  const argv = peers.pullArgv({ host: "h", port: 1, user: "box-a1", token: "t" }, "a/b", "/dest", "/backup");
  assert.ok(!argv.includes("--exclude"));
});

test("one code pairs both ways: our own credentials travel with the request", async () => {
  let sent = null;
  const own = { id: "tvbox-livingroom", name: "livingroom", port: 8096, user: "box-b2", token: "ours" };
  const r = await peers.pairWith(
    "192.168.1.7",
    "1234",
    {
      post: async (_url, body) => {
        sent = body;
        return {
          status: 200,
          body: JSON.stringify({ name: "gaming", port: 8096, user: "box-a1", token: "theirs", mutual: true }),
        };
      },
    },
    own,
  );
  assert.equal(sent.code, "1234");
  assert.equal(sent.token, "ours", "the other box needs ours to be able to ask us for anything");
  assert.equal(sent.user, "box-b2", "and the name that key was minted under");
  assert.equal(r.mutual, true, "and it says whether it could take them");
});

test("a box that offers nothing is still worth pairing with, one way", async () => {
  // It has no credentials to send, so the other end cannot pull from it - which is
  // reported rather than left to be discovered.
  const r = await peers.pairWith("192.168.1.7", "1234", {
    post: async () => ({
      status: 200,
      body: JSON.stringify({ name: "gaming", port: 8096, user: "box-a1", token: "t" }),
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.mutual, false);
});

test("what a box says about itself is checked once, wherever it arrives", () => {
  // Both ends of the exchange read the same answer now, so the rules live in one
  // place. The address is never the box's to choose.
  const said = { name: "x", user: "box-a1", token: "t", port: 8096 };
  assert.equal(peers.peerFrom(said, ""), null, "no address, no peer");
  assert.deepStrictEqual(peers.peerFrom(said, "192.168.1.7"), {
    id: "x",
    name: "x",
    host: "192.168.1.7",
    port: 8096,
    user: "box-a1",
    token: "t",
  });
  assert.equal(peers.callerAddress({ socket: { remoteAddress: "::ffff:192.168.1.7" } }), "192.168.1.7");
  assert.equal(peers.callerAddress({}), "");
});

test("a listing asks both sides the same question, with the copy's own filters", () => {
  // The filters are the point. An emulator rewrites its own config on every exit,
  // so an unfiltered comparison says "the other box is newer" forever and the
  // answer means nothing - measured on a real pair of boxes, where every file under
  // Dolphin's User/Config carried the same fresh timestamp.
  const exclude = ["**/Cache/**", "**/Config/**"];
  const local = peers.lsArgv("/home/tv/.var/app/x/saves", exclude, null);
  const remote = peers.lsArgv(":webdav:retroarch/saves", exclude, {
    host: "192.168.1.7",
    port: 8096,
    user: "box-a1",
    token: "secret-token",
  });
  assert.deepStrictEqual(local.slice(0, 3), ["rclone", "lsjson", "/home/tv/.var/app/x/saves"]);
  assert.ok(local.includes("--files-only") && local.includes("--recursive"));
  assert.deepStrictEqual(
    local.filter((a, i) => local[i - 1] === "--exclude"),
    exclude,
    "the same list on this box",
  );
  assert.deepStrictEqual(
    remote.filter((a, i) => remote[i - 1] === "--exclude"),
    exclude,
    "and on the other one",
  );
  assert.ok(!local.includes("--webdav-url"), "a local path is not a remote");
  assert.deepStrictEqual(
    remote.filter((a, i) => remote[i - 1] === "--webdav-user"),
    ["box-a1"],
  );
  assert.ok(!remote.join(" ").includes("secret-token"), "the key goes through the environment");
});

test("the comparison answers what a pull would do, not what differs", () => {
  const t = (iso) => ({ Path: iso[0], ModTime: iso[1], Size: 10 });
  const here = [
    t(["a.sav", "2026-08-10T09:00:00Z"]), // newer here
    t(["b.sav", "2026-08-09T09:00:00Z"]), // newer there
    t(["c.sav", "2026-08-08T09:00:00Z"]), // same
  ];
  const there = [
    t(["a.sav", "2026-08-09T09:00:00Z"]),
    t(["b.sav", "2026-08-10T09:00:00Z"]),
    t(["c.sav", "2026-08-08T09:00:00Z"]),
    t(["d.sav", "2026-08-07T09:00:00Z"]), // only there
  ];
  const r = peers.compareListings(here, there);
  assert.equal(r.newerThere, 2, "b is newer there and d is missing here - both would arrive");
  assert.equal(r.sameTimeDiffers, 0);
  assert.equal(r.olderThere, 1, "a would be replaced by an older copy, which is the regret");
  assert.equal(r.here.files, 3);
  assert.equal(r.there.files, 4);
  assert.equal(new Date(r.here.newest).toISOString(), "2026-08-10T09:00:00.000Z");
  assert.equal(new Date(r.there.newest).toISOString(), "2026-08-10T09:00:00.000Z");
});

test("a second's difference is not a difference", () => {
  // WebDAV carries a modification time to the second, and a copy lands a moment
  // after the file it came from. Without slack every pull would report the box it
  // just copied from as newer again.
  const here = [{ Path: "a.sav", ModTime: "2026-08-10T09:00:00Z" }];
  const there = [{ Path: "a.sav", ModTime: "2026-08-10T09:00:01Z" }];
  const r = peers.compareListings(here, there);
  assert.equal(r.newerThere, 0);
  assert.equal(r.olderThere, 0);
});

test("the same second is not the same file, and the copy knows it", () => {
  // rclone's default check is size AND modification time, so a file written in the
  // same second on both boxes but of a different length is copied. A verdict built
  // on timestamps alone would answer "nothing to do" for a pull that replaces it.
  const here = [{ Path: "a.sav", ModTime: "2026-08-10T09:00:00Z", Size: 100 }];
  const there = [{ Path: "a.sav", ModTime: "2026-08-10T09:00:01Z", Size: 220 }];
  const r = peers.compareListings(here, there);
  assert.equal(r.newerThere, 0, "one second apart is not newer");
  assert.equal(r.olderThere, 0);
  assert.equal(r.sameTimeDiffers, 1, "but it would still be replaced");

  const same = peers.compareListings(here, [{ Path: "a.sav", ModTime: "2026-08-10T09:00:00Z", Size: 100 }]);
  assert.equal(same.sameTimeDiffers, 0, "identical size and time is the one case rclone skips");
});

test("nothing here yet means everything there is worth bringing", () => {
  const r = peers.compareListings([], [{ Path: "a.sav", ModTime: "2026-08-10T09:00:00Z" }]);
  assert.equal(r.here.newest, null, "a box that has never played has no date to show");
  assert.equal(r.newerThere, 1);
  assert.equal(r.olderThere, 0);
});

test("a comparison is per emulator, because one date per box answers the wrong question", () => {
  // Somebody played the SNES in one room and the GameCube in the other. Each box is
  // "newer" and neither answer helps - the useful one is per emulator, which is
  // exactly how the saves are already laid out.
  const f = (p, iso, size) => ({ Path: p, ModTime: iso, Size: size || 10 });
  const here = [
    f("Snes9x/Mario.srm", "2026-08-10T09:00:00Z"),
    f("dolphin-emu/User/GC/SRAM.raw", "2026-08-01T09:00:00Z"),
  ];
  const there = [
    f("Snes9x/Mario.srm", "2026-08-02T09:00:00Z"),
    f("dolphin-emu/User/GC/SRAM.raw", "2026-08-10T09:00:00Z"),
  ];
  const r = peers.compareListings(here, there);
  assert.equal(r.newerThere, 1, "in total, one file would arrive");
  assert.equal(r.olderThere, 1, "and one would be replaced by an older copy");
  const by = Object.fromEntries(r.groups.map((g) => [g.name, g]));
  assert.deepStrictEqual(Object.keys(by).sort(), ["Snes9x", "dolphin-emu"]);
  assert.equal(by["dolphin-emu"].newerThere, 1, "the GameCube save is newer in the other room");
  assert.equal(by["dolphin-emu"].olderThere, 0);
  assert.equal(by["Snes9x"].olderThere, 1, "and the SNES one is newer here");
  assert.equal(by["Snes9x"].newerThere, 0);
  assert.equal(new Date(by["Snes9x"].here.newest).toISOString(), "2026-08-10T09:00:00.000Z");
});

test("a file lying loose in a share belongs to no emulator", () => {
  const r = peers.compareListings([], [{ Path: "loose.srm", ModTime: "2026-08-10T09:00:00Z", Size: 1 }]);
  assert.equal(r.newerThere, 1, "it still counts in the total");
  assert.deepStrictEqual(r.groups, [], "but there is nothing to ask for by name");
});

test("a group nobody could ask for is not offered as one", () => {
  // The screen turns each group into a row with a copy button. A name a pull would
  // refuse - a dot-name, a stray space - would be a row that answers unknown_group
  // every time it is pressed, so it is left out of the list and kept in the totals.
  const f = (p) => ({ Path: p, ModTime: "2026-08-10T09:00:00Z", Size: 1 });
  const r = peers.compareListings([], [f("../escape/x.srm"), f(" odd /x.srm"), f("Snes9x/x.srm")]);
  assert.deepStrictEqual(
    r.groups.map((g) => g.name),
    ["Snes9x"],
  );
  assert.equal(r.newerThere, 3, "all three would still arrive with the whole share");
});

test("a path that is not a string does not take the comparison down with it", () => {
  assert.equal(peers.groupOf(undefined), "");
  assert.equal(peers.groupOf(42), "");
  assert.equal(peers.groupOf("Snes9x/x.srm"), "Snes9x");
});

test("the folder a pull may name is one folder, and not a way out of the share", () => {
  // Emulator folders carry spaces and dashes ("Beetle PSX HW"), so the rule cannot
  // be a tidy identifier - it is "one segment, nothing that traverses".
  assert.equal(peers.groupNameOk("Beetle PSX HW"), true);
  assert.equal(peers.groupNameOk("dolphin-emu"), true);
  for (const bad of ["", "..", ".", "a/b", "a\\b", "x ", " x", "a".repeat(129)]) {
    assert.equal(peers.groupNameOk(bad), false, JSON.stringify(bad));
  }
  const argv = peers.pullArgv(
    { host: "h", port: 1, user: "box-a1", token: "t" },
    "retroarch/saves",
    "/dest/Snes9x",
    "/b",
    [],
    "Snes9x",
  );
  assert.equal(argv[2], ":webdav:retroarch/saves/Snes9x", "one level below the share, never above it");
  assert.equal(argv[3], "/dest/Snes9x");
  const whole = peers.pullArgv(
    { host: "h", port: 1, user: "box-a1", token: "t" },
    "retroarch/saves",
    "/dest",
    "/b",
    [],
  );
  assert.equal(whole[2], ":webdav:retroarch/saves", "and the whole share when none is named");
});
