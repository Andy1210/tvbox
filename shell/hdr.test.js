const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const hdr = require("./hdr");

// EDID parsing lives in edid.js and is tested there.

test("wants: PQ content on the plane path, on a capable panel", () => {
  const pq = { gamma: "pq" };
  assert.strictEqual(hdr.wants(pq, true, true), true);
  // Not on the plane path: mpv renders and tone-maps it, so the output stays SDR
  // or the picture would be mapped twice.
  assert.strictEqual(hdr.wants(pq, false, true), false);
  assert.strictEqual(hdr.wants({ gamma: "bt.1886" }, true, true), false);
  assert.strictEqual(hdr.wants(pq, true, false), false);
  assert.strictEqual(hdr.wants(null, true, true), false);
});

test("claim asks the compositor for the output's colour space", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-hdr-test-"));
  const socketPath = path.join(dir, "tvbox-wc.sock");
  process.env.TVBOX_WC_SOCKET = socketPath;
  for (const mod of ["./compositor", "./hdr"]) delete require.cache[require.resolve(mod)];
  const hdrLive = require("./hdr");

  const seen = [];
  const server = net.createServer((connection) => {
    connection.on("data", (chunk) => {
      const req = JSON.parse(String(chunk).trim());
      seen.push(req);
      const ok =
        req.request === "get_outputs"
          ? { outputs: [{ name: "HDMIA-1", modes: [], connected: true, hdr: { supported: true, on: false } }] }
          : null;
      connection.write(JSON.stringify({ id: req.id, ok }) + "\n");
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const applied = await new Promise((resolve) => hdrLive.claim(true, (ok) => resolve(ok)));
  assert.equal(applied, true);
  assert.deepEqual(
    seen.map((r) => r.request),
    ["get_outputs", "set_hdr"],
  );
  assert.equal(seen[1].output, "HDMIA-1");
  assert.equal(seen[1].on, true);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TVBOX_WC_SOCKET;
  for (const mod of ["./compositor", "./hdr"]) delete require.cache[require.resolve(mod)];
});

test("a connector with no HDR properties is refused, not silently claimed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-hdr-test-"));
  const socketPath = path.join(dir, "tvbox-wc.sock");
  process.env.TVBOX_WC_SOCKET = socketPath;
  for (const mod of ["./compositor", "./hdr"]) delete require.cache[require.resolve(mod)];
  const hdrLive = require("./hdr");

  let setHdrCalls = 0;
  const server = net.createServer((connection) => {
    connection.on("data", (chunk) => {
      const req = JSON.parse(String(chunk).trim());
      if (req.request === "set_hdr") setHdrCalls++;
      connection.write(
        JSON.stringify({
          id: req.id,
          ok: { outputs: [{ name: "HDMIA-1", modes: [], connected: true, hdr: { supported: false, on: false } }] },
        }) + "\n",
      );
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const applied = await new Promise((resolve) => hdrLive.claim(true, (ok, err) => resolve({ ok, err })));
  assert.equal(applied.ok, false);
  assert.match(applied.err, /HDR/);
  assert.equal(setHdrCalls, 0);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TVBOX_WC_SOCKET;
  for (const mod of ["./compositor", "./hdr"]) delete require.cache[require.resolve(mod)];
});

test("gammaPending waits only where the colour space matters", () => {
  assert.strictEqual(hdr.gammaPending({ gamma: "" }, true), true);
  assert.strictEqual(hdr.gammaPending({ gamma: "pq" }, true), false);
  // Below the zero-copy threshold the output stays SDR either way, so an
  // unavailable answer must not hold the film up.
  assert.strictEqual(hdr.gammaPending({ gamma: "" }, false), false);
});
