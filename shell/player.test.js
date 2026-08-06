// The player's decisions that do not need mpv to be running.
//
// Everything that spawns or talks to a process is left to the box; what is pinned
// here is the state machine around it, because those are the parts that go wrong
// silently - a claim nobody released, a colour space nobody said no to.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

// The compositor client reads its socket path once, at require time.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-player-"));
const socketPath = path.join(dir, "tvbox-wc.sock");
process.env.TVBOX_WC_SOCKET = socketPath;

const player = require("./player");

// A compositor that answers get_outputs like the 4K set does, and records the rest.
function fakeCompositor(seen) {
  const server = net.createServer((connection) => {
    connection.on("data", (chunk) => {
      const req = JSON.parse(String(chunk).trim());
      seen.push(req);
      const ok =
        req.request === "get_outputs"
          ? {
              outputs: [
                {
                  name: "HDMIA-1",
                  current: { w: 1920, h: 1080, refresh: 60000, preferred: false },
                  modes: [{ w: 1920, h: 1080, refresh: 60000, preferred: false }],
                  connected: true,
                  hdr: { supported: true, on: false },
                },
              ],
            }
          : null;
      connection.write(JSON.stringify({ id: req.id, ok }) + "\n");
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

test("a stop with nothing playing still gives the claims back", () => {
  const released = [];
  player.init({
    dmode: { claim: (_id, _c, cb) => cb && cb(null), release: (id) => released.push(id) },
    publishMediaState: () => {},
  });

  player.stop();
  assert.deepStrictEqual(released, ["shell:mpv"]);
  assert.strictEqual(player.running(), false);
});

test("a stop that keeps the mode does not release it", () => {
  // launchMpv's own pre-launch stop: releasing here would put the UI mode back for
  // a second only for the next file to claim it again, and the TV blanks twice.
  const released = [];
  player.init({ dmode: { claim: () => {}, release: (id) => released.push(id) }, publishMediaState: () => {} });

  player.stop(true);
  assert.deepStrictEqual(released, []);
});

test("the colour space is not assumed to be off at startup", async () => {
  // The shell restarts on its own while the compositor keeps running, so the output
  // may be in PQ from a film this process never played. Saying "no" has to go out.
  //
  // On a fresh instance, because the claim being tested is the FIRST one this
  // process makes: the tests above already called stop(), and whether those reached
  // a compositor is not what this is about.
  const seen = [];
  const server = await fakeCompositor(seen);
  delete require.cache[require.resolve("./player")];
  const fresh = require("./player");

  await new Promise((resolve) => fresh.setHdr(false, resolve));
  const first = seen.filter((r) => r.request === "set_hdr");
  assert.strictEqual(first.length, 1, "the first no must reach the compositor");
  assert.strictEqual(first[0].on, false);

  // Now it knows, so the same answer costs nothing.
  seen.length = 0;
  await new Promise((resolve) => fresh.setHdr(false, resolve));
  assert.deepStrictEqual(seen, []);

  // And the other way round still goes out.
  await new Promise((resolve) => fresh.setHdr(true, resolve));
  assert.deepStrictEqual(
    seen.filter((r) => r.request === "set_hdr").map((r) => r.on),
    [true],
  );

  await new Promise((resolve) => fresh.setHdr(false, resolve));
  server.close();
});

test("the fallback rectangle is a quarter of whatever the output is at", () => {
  player.init({ outputSize: () => ({ width: 1920, height: 1080 }) });
  assert.deepStrictEqual(player.pipFallbackRect(), { x: 1363, y: 58, w: 499, h: 281 });

  // A 4K output moves it, so nothing may assume 1080p pixels.
  player.init({ outputSize: () => ({ width: 3840, height: 2160 }) });
  const uhd = player.pipFallbackRect();
  assert.strictEqual(uhd.w, 998);
  assert.strictEqual(uhd.x + uhd.w, 3840 - 115);

  // Before the first mode read there is no answer, and a guess would put a film
  // somewhere off screen: fullscreen is the honest fallback.
  player.init({ outputSize: () => null });
  assert.strictEqual(player.pipFallbackRect(), null);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
