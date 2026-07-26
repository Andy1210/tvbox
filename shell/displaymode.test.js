// Arbitration tests for the adaptive display mode: who owns the output mode, when
// it goes back, and the guards that keep a TV from black-flashing in a loop.
// Mode SELECTION is tested in display.test.js; this file fakes a sink instead.
const test = require("node:test");
const assert = require("node:assert");
const display = require("./display");
const displaymode = require("./displaymode");

// Real `wlr-randr` output from the 4K LG the box is developed against, trimmed to
// the modes that matter here (both 24.000 and 23.976 present, as on a real set).
const WLR_4K = `HDMI-A-1 "LG Electronics LG TV SSCR2 (HDMI-A-1)"
  Modes:
    3840x2160 px, 60.000000 Hz (preferred, current)
    3840x2160 px, 24.000000 Hz
    3840x2160 px, 23.976000 Hz
    1920x1080 px, 60.000000 Hz
    1920x1080 px, 23.976000 Hz
    1280x720 px, 60.000000 Hz
`;
// A 60Hz-only panel: nothing divides into 23.976, so a film claim must be a no-op.
const WLR_60_ONLY = `HDMI-A-1 "Generic TV (HDMI-A-1)"
  Modes:
    1920x1080 px, 60.000000 Hz (preferred, current)
    1280x720 px, 60.000000 Hz
`;

const FILM = { width: 1920, height: 1080, fps: 23.976 };
const id = (m) => `${m.width}x${m.height}@${m.refreshExact}`;

// Fake output. `ignore: true` = a sink that reports success and stays put, which
// is what a marginal link or an AVR really does. `async: true` answers on a later
// tick like the real thing - display.list/apply are execFile calls, and a
// synchronous fake cannot expose the races that live in those gaps.
function sink(text, opts = {}) {
  const modes = display.parse(text).modes;
  let cur = modes.find((m) => m.current);
  const later = (fn) => (opts.async ? setTimeout(fn, 5) : fn());
  const s = {
    applied: [],
    reads: 0,
    getModes(cb) {
      s.reads++;
      later(() => cb({ output: "HDMI-A-1", modes: modes.map((m) => ({ ...m, current: m === cur })) }));
    },
    applyMode(_output, mode, cb) {
      s.applied.push(id(mode));
      later(() => {
        if (!opts.ignore) cur = modes.find((m) => id(m) === id(mode)) || cur;
        cb(true, "");
      });
    },
    current: () => id(cur),
  };
  return s;
}
const svc = (s) => displaymode.create({ ...s, log: () => {}, minApplyGapMs: 0 });

test("refresh puts a 4K panel's UI at 1080p60", async () => {
  const s = sink(WLR_4K);
  const d = svc(s);
  await new Promise((r) => d.refresh(r));
  assert.deepStrictEqual(s.applied, ["1920x1080@60"]);
  assert.deepStrictEqual(d.state().ui, { width: 1920, height: 1080, refresh: 60 });
});

test("a film claim takes the matching mode and release gives it back", async () => {
  const s = sink(WLR_4K);
  const d = svc(s);
  await new Promise((r) => d.refresh(r));
  const r = await new Promise((res) => d.claim("app:plex", FILM, res));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(d.state().claimedBy, "app:plex");
  assert.deepStrictEqual(s.applied, ["1920x1080@60", "1920x1080@23.976"]);
  await new Promise((res) => d.release("app:plex", res));
  assert.strictEqual(d.state().claimedBy, null);
  assert.deepStrictEqual(s.applied, ["1920x1080@60", "1920x1080@23.976", "1920x1080@60"]);
});

test("`changed` means the TV actually switched, not just that we settled", async () => {
  const s = sink(WLR_4K);
  const d = svc(s);
  await new Promise((r) => d.refresh(r));
  const first = await new Promise((res) => d.claim("app:plex", FILM, res));
  assert.strictEqual(first.changed, true); // 1080p60 -> 1080p23.976
  const again = await new Promise((res) => d.claim("app:plex", FILM, res));
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.changed, false); // already there: nothing blanked
  assert.deepStrictEqual(s.applied, ["1920x1080@60", "1920x1080@23.976"]);
});

test("no matching refresh is a successful no-op, not a failure", async () => {
  const s = sink(WLR_60_ONLY);
  const d = svc(s);
  await new Promise((r) => d.refresh(r)); // already at 1080p60 -> nothing applied
  const r = await new Promise((res) => d.claim("app:plex", FILM, res));
  assert.deepStrictEqual(r, { ok: true, changed: false, reason: "no-matching-mode" });
  assert.deepStrictEqual(s.applied, []); // the caller resamples instead
  assert.strictEqual(d.state().claimedBy, null);
});

test("a background app cannot release the foreground app's mode", async () => {
  const s = sink(WLR_4K);
  const d = svc(s);
  await new Promise((r) => d.refresh(r));
  await new Promise((res) => d.claim("app:plex", FILM, res));
  await new Promise((res) => d.release("app:youtube", res)); // not the holder
  assert.strictEqual(d.state().claimedBy, "app:plex");
  assert.deepStrictEqual(s.applied, ["1920x1080@60", "1920x1080@23.976"]);
  d.releaseIfHolder("app:youtube"); // same rule on backgrounding
  assert.strictEqual(d.state().claimedBy, "app:plex");
  d.releaseIfHolder("app:plex");
  assert.strictEqual(d.state().claimedBy, null);
});

test("newest claim wins", async () => {
  const s = sink(WLR_4K);
  const d = svc(s);
  await new Promise((r) => d.refresh(r));
  await new Promise((res) => d.claim("app:plex", FILM, res));
  await new Promise((res) => d.claim("app:live", { width: 3840, height: 2160, fps: 60 }, res));
  assert.strictEqual(d.state().claimedBy, "app:live");
  assert.deepStrictEqual(d.state().desired, { width: 3840, height: 2160, refresh: 60 });
});

test("a hotplug refresh under a live claim re-asserts the CONTENT mode", async () => {
  // The TV power-cycles mid-film: the output comes back at EDID preferred, and the
  // watcher's refresh must put the FILM's mode back, not the UI's.
  const s = sink(WLR_4K);
  const d = svc(s);
  await new Promise((r) => d.refresh(r));
  await new Promise((res) => d.claim("app:plex", FILM, res));
  s.applied.length = 0;
  await new Promise((r) => d.refresh(r));
  assert.deepStrictEqual(s.applied, []); // already there, nothing to do
  assert.deepStrictEqual(d.state().desired, { width: 1920, height: 1080, refresh: 23.976 });
});

test("a mode that never sticks is retried a few times, then left alone", async () => {
  const s = sink(WLR_4K, { ignore: true });
  const d = svc(s);
  for (let i = 0; i < 6; i++) await new Promise((r) => d.refresh(r));
  assert.strictEqual(s.applied.length, 3); // MAX_TRIES, not once per event
  d.rearm(); // a hotplug: the new sink may well accept it
  await new Promise((r) => d.refresh(r));
  assert.strictEqual(s.applied.length, 4);
});

test("switches are rate-limited (a mode change blanks HDMI)", async () => {
  const s = sink(WLR_4K);
  const d = displaymode.create({ ...s, log: () => {}, minApplyGapMs: 150 });
  await new Promise((r) => d.refresh(r));
  const t0 = Date.now();
  await new Promise((res) => d.claim("app:plex", FILM, res));
  assert.ok(Date.now() - t0 >= 140, "second apply waited for the gap");
});

// ---- races. The sink answers on a later tick here, like wlr-randr does. --------

test("a release that lands DURING a claim cancels it (no leaked mode)", async () => {
  // Press Play then Home half a second later: the release used to arrive before the
  // claim had a holder, no-op, and the launcher stayed at the film's mode forever
  // with nothing able to release it.
  const s = sink(WLR_4K, { async: true });
  const d = svc(s);
  await new Promise((r) => d.refresh(r));
  const claimed = new Promise((res) => d.claim("shell:mpv", FILM, res));
  const released = new Promise((res) => d.release("shell:mpv", res));
  const [c] = await Promise.all([claimed, released]);
  assert.strictEqual(c.changed, false);
  assert.strictEqual(c.reason, "superseded");
  assert.strictEqual(d.state().claimedBy, null);
  await new Promise((r) => d.refresh(r));
  assert.strictEqual(s.current(), "1920x1080@60"); // the UI mode, not the film's
});

test("concurrent settles apply ONCE and every waiter is answered", async () => {
  const s = sink(WLR_4K, { async: true });
  const d = svc(s);
  const answers = await Promise.all([0, 1, 2, 3].map(() => new Promise((r) => d.refresh((ok) => r(ok)))));
  assert.deepStrictEqual(answers, [true, true, true, true]); // no callback dropped
  assert.deepStrictEqual(s.applied, ["1920x1080@60"]); // not four HDMI blanks
});

test("a claim storm spawns one mode read at a time and cannot strobe the TV", async () => {
  const s = sink(WLR_4K, { async: true });
  const d = svc(s);
  await new Promise((r) => d.refresh(r));
  s.applied.length = 0;
  const before = s.reads;
  // Alternating targets defeat a per-target budget, so the window cap is what
  // stops this; the single-flight read is what stops the process pile-up.
  const storm = [];
  for (let i = 0; i < 200; i++) {
    const fps = i % 2 ? 23.976 : 60;
    storm.push(new Promise((res) => d.claim("app:evil", { width: 1920, height: 1080, fps }, res)));
  }
  await Promise.all(storm);
  assert.ok(s.reads - before <= 3, `mode reads coalesced (was ${s.reads - before})`);
  assert.ok(s.applied.length <= displaymode.APPLY_WINDOW_MAX, `applies capped (was ${s.applied.length})`);
});

test("no output (TV off) fails softly and applies nothing", async () => {
  const s = { getModes: (cb) => cb(null), applyMode: () => assert.fail("must not apply") };
  const d = svc(s);
  const [ok, err] = await new Promise((r) => d.refresh((a, b) => r([a, b])));
  assert.strictEqual(ok, false);
  assert.strictEqual(err, "no output");
  const r = await new Promise((res) => d.claim("app:plex", FILM, res));
  assert.deepStrictEqual(r, { ok: false, reason: "no output" });
});
