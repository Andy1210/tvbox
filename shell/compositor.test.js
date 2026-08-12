// The compositor client, against a real socket and real payloads.
//
// Pinned to what tvbox-wc actually answers (captured from the box), because the
// only thing that can go wrong here is the two sides disagreeing about units or
// shape - and both are easy to get wrong: refresh is mHz on the wire and Hz in
// display.js, and a rounded 60 picks the wrong mode out of a 59.94/60 pair.
const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const compositor = require("./compositor");

// Captured from `wcctl.py get_outputs` on tvbox-gaming.
const OUTPUTS = {
  outputs: [
    {
      name: "HDMIA-1",
      current: { w: 1360, h: 768, refresh: 60014, preferred: true },
      modes: [
        { w: 1360, h: 768, refresh: 60014, preferred: true },
        { w: 1920, h: 1080, refresh: 60000, preferred: false },
        { w: 1920, h: 1080, refresh: 59939, preferred: false },
        { w: 1920, h: 1080, refresh: 23976, preferred: false },
      ],
      connected: true,
      hdr: { supported: true, on: false },
    },
  ],
};

test("mHz on the wire becomes Hz with the exact value kept", () => {
  const info = compositor.toDisplayInfo(OUTPUTS);

  assert.equal(info.output, "HDMIA-1");
  assert.equal(info.modes.length, 4);

  const film = info.modes.find((m) => m.height === 1080 && m.refresh === 24);
  assert.equal(film.refreshExact, 23.976);
  // The key rounds, so 23.976 and 24 collide there on purpose and are told
  // apart by refreshExact - the pair is not interchangeable for a film.
  assert.equal(film.key, "1920x1080@24");

  // 59.94 and 60 both round to 60, so the exact value is what separates them.
  const rates = info.modes.filter((m) => m.height === 1080 && m.refresh === 60).map((m) => m.refreshExact);
  assert.deepEqual(rates.sort(), [59.939, 60]);
});

test("the current mode is the one the compositor says, not the preferred one", () => {
  const info = compositor.toDisplayInfo(OUTPUTS);

  const current = info.modes.filter((m) => m.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].width, 1360);
});

test("an answer with no outputs is no answer", () => {
  assert.equal(compositor.toDisplayInfo({ outputs: [] }), null);
  assert.equal(compositor.toDisplayInfo({}), null);
  assert.equal(compositor.toDisplayInfo(null), null);
});

test("a request goes out as one line and the reply comes back parsed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-wc-test-"));
  const socketPath = path.join(dir, "tvbox-wc.sock");
  process.env.TVBOX_WC_SOCKET = socketPath;
  delete require.cache[require.resolve("./compositor")];
  const client = require("./compositor");

  const seen = [];
  const server = net.createServer((connection) => {
    connection.on("data", (chunk) => {
      seen.push(JSON.parse(String(chunk).trim()));
      connection.write(JSON.stringify({ id: 1, ok: OUTPUTS }) + "\n");
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  assert.equal(client.available(), true);

  const info = await new Promise((resolve) => client.list(resolve));
  assert.equal(info.output, "HDMIA-1");
  assert.equal(seen[0].request, "get_outputs");
  assert.ok(seen[0].id > 0);

  const applied = await new Promise((resolve) =>
    client.apply("HDMIA-1", { width: 1920, height: 1080, refreshExact: 23.976 }, (ok) => resolve(ok)),
  );
  assert.equal(applied, true);
  assert.deepEqual(
    { request: seen[1].request, w: seen[1].w, h: seen[1].h, refresh: seen[1].refresh },
    { request: "set_mode", w: 1920, h: 1080, refresh: 23976 },
  );

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TVBOX_WC_SOCKET;
  delete require.cache[require.resolve("./compositor")];
});

test("an error reply is an error, not a silent success", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-wc-test-"));
  const socketPath = path.join(dir, "tvbox-wc.sock");
  process.env.TVBOX_WC_SOCKET = socketPath;
  delete require.cache[require.resolve("./compositor")];
  const client = require("./compositor");

  const server = net.createServer((connection) => {
    connection.on("data", () => connection.write(JSON.stringify({ id: 1, error: "no mode 1x1 on HDMIA-1" }) + "\n"));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const applied = await new Promise((resolve) =>
    client.apply("HDMIA-1", { width: 1, height: 1, refreshExact: 60 }, (ok, err) => resolve({ ok, err })),
  );
  assert.equal(applied.ok, false);
  assert.match(applied.err, /no mode/);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TVBOX_WC_SOCKET;
  delete require.cache[require.resolve("./compositor")];
});

test("focus goes out as the owner, and the app id only when there is one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-wc-test-"));
  const socketPath = path.join(dir, "tvbox-wc.sock");
  process.env.TVBOX_WC_SOCKET = socketPath;
  delete require.cache[require.resolve("./compositor")];
  const client = require("./compositor");

  const seen = [];
  const server = net.createServer((connection) => {
    connection.on("data", (chunk) => {
      seen.push(JSON.parse(String(chunk).trim()));
      connection.write(JSON.stringify({ id: 1, ok: {} }) + "\n");
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  await new Promise((resolve) => client.setFocus("app", "plex", resolve));
  await new Promise((resolve) => client.setFocus("launcher", null, resolve));

  assert.deepEqual(seen[0].request, "set_focus");
  assert.deepEqual({ owner: seen[0].owner, app: seen[0].app }, { owner: "app", app: "plex" });
  // The launcher has no app id, and an empty string is not one: the compositor
  // reads the owner, and a stale id would keep the Back key rewritten.
  assert.equal(seen[1].owner, "launcher");
  assert.ok(!("app" in seen[1]));

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TVBOX_WC_SOCKET;
  delete require.cache[require.resolve("./compositor")];
});

test("a placement goes out as pixels, and a null one puts the window back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-wc-test-"));
  const socketPath = path.join(dir, "tvbox-wc.sock");
  process.env.TVBOX_WC_SOCKET = socketPath;
  delete require.cache[require.resolve("./compositor")];
  const client = require("./compositor");

  const seen = [];
  const server = net.createServer((connection) => {
    connection.on("data", (chunk) => {
      seen.push(JSON.parse(String(chunk).trim()));
      connection.write(JSON.stringify({ id: 1, ok: null }) + "\n");
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  // The launcher measures its placeholder in CSS pixels, so the numbers arrive
  // fractional; the compositor works in whole pixels.
  await new Promise((resolve) => client.placeWindow("mpv", { x: 1417.6, y: 32.4, w: 499.2, h: 280.8 }, resolve));
  await new Promise((resolve) => client.placeWindow("mpv", null, resolve));

  assert.deepEqual(
    { request: seen[0].request, app_id: seen[0].app_id, x: seen[0].x, y: seen[0].y, w: seen[0].w, h: seen[0].h },
    { request: "place_window", app_id: "mpv", x: 1418, y: 32, w: 499, h: 281 },
  );
  // No rectangle at all, rather than a zero one: the compositor reads the absence
  // as "the whole output".
  assert.deepEqual(seen[1], { id: seen[1].id, request: "place_window", app_id: "mpv" });

  // One window of a client that has several: named by title, and NEVER carrying an
  // app id as well. Every window of this process shares the shell's, so an app id
  // here would drag the launcher into the note's little rectangle.
  await new Promise((resolve) =>
    client.placeWindowByTitle("tvbox-overlay", { x: 0, y: 900, w: 1920, h: 180 }, resolve),
  );
  assert.deepEqual(
    { ...seen[2], id: undefined },
    { id: undefined, request: "place_window", title: "tvbox-overlay", x: 0, y: 900, w: 1920, h: 180 },
  );
  assert.equal("app_id" in seen[2], false);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TVBOX_WC_SOCKET;
  delete require.cache[require.resolve("./compositor")];
});

test("no socket means no compositor, and callers fall back", () => {
  process.env.TVBOX_WC_SOCKET = path.join(os.tmpdir(), "tvbox-wc-does-not-exist.sock");
  delete require.cache[require.resolve("./compositor")];
  const client = require("./compositor");

  assert.equal(client.available(), false);

  delete process.env.TVBOX_WC_SOCKET;
  delete require.cache[require.resolve("./compositor")];
});

// ---- which compositor is RUNNING -----------------------------------------------
// The shell gates a behaviour on this (the typing screen only offers a field's own
// text back once `type_text` replaces rather than appends), so the comparison has to
// be wrong in the SAFE direction when it cannot tell.

test("a version is compared as numbers, and an unknown one loses", () => {
  const { versionAtLeast } = require("./compositor")._test;

  assert.equal(versionAtLeast("0.1.10", "0.1.10"), true);
  assert.equal(versionAtLeast("0.1.11", "0.1.10"), true);
  assert.equal(versionAtLeast("0.2.0", "0.1.10"), true);
  assert.equal(versionAtLeast("1.0.0", "0.1.10"), true);
  // The one a string comparison gets wrong: "0.1.9" > "0.1.10" as text.
  assert.equal(versionAtLeast("0.1.9", "0.1.10"), false);
  assert.equal(versionAtLeast("0.1.2", "0.1.10"), false);
  // A shorter version is padded rather than refused: 0.2 is past 0.1.10.
  assert.equal(versionAtLeast("0.2", "0.1.10"), true);
  assert.equal(versionAtLeast("0.1", "0.1.10"), false);
  // Nothing to compare - every one of these must fail closed, because they are what
  // a compositor too old to report its version at all leaves behind.
  for (const nothing of ["", null, undefined, "unknown", "v0.1.10"]) {
    assert.equal(versionAtLeast(nothing, "0.1.10"), false, `"${nothing}" must not pass`);
  }
});

test("the running version comes off the socket, and a build that omits it fails closed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-wc-version-"));
  const sock = path.join(dir, "wc.sock");
  process.env.TVBOX_WC_SOCKET = sock;
  delete require.cache[require.resolve("./compositor")];
  const client = require("./compositor");

  // What tvbox-wc 0.1.10 answers, trimmed to the field this asks about.
  let reply = { id: 1, ok: { focus: { owner: "app" }, windows: [], version: "0.1.10" } };
  const server = net.createServer((c) => c.on("data", () => c.end(JSON.stringify(reply) + "\n")));
  await new Promise((r) => server.listen(sock, r));

  await new Promise((r) => client.refreshVersion(r));
  assert.equal(client.atLeast("0.1.10"), true);
  assert.equal(client.atLeast("0.2.0"), false);

  // An older build answers get_state without the field at all. The cached answer
  // must not survive into it - a stale yes is the one that types the text twice.
  delete require.cache[require.resolve("./compositor")];
  const older = require("./compositor");
  reply = { id: 1, ok: { focus: { owner: "app" }, windows: [] } };
  await new Promise((r) => older.refreshVersion(r));
  assert.equal(older.atLeast("0.1.10"), false);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TVBOX_WC_SOCKET;
  delete require.cache[require.resolve("./compositor")];
});

test("with no compositor at all, nothing is claimed", async () => {
  process.env.TVBOX_WC_SOCKET = path.join(os.tmpdir(), "tvbox-wc-absent.sock");
  delete require.cache[require.resolve("./compositor")];
  const client = require("./compositor");

  await new Promise((r) => client.refreshVersion(r));
  assert.equal(client.atLeast("0.1.10"), false);

  delete process.env.TVBOX_WC_SOCKET;
  delete require.cache[require.resolve("./compositor")];
});
