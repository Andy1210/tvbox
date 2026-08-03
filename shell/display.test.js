// Mode selection for adaptive resolution. Pinned against REAL wlr-randr output
// from the two TVs this was developed on, because the whole point is behaving
// correctly on a mode list you did not choose.
const test = require("node:test");
const assert = require("node:assert");
const display = require("./display");

// A 768p-panel LG that still accepts 1080p, and offers the film rates ONLY at
// 1080p - the case that decides refresh-over-resolution.
const LG_768 = `HDMI-A-1 "LG Electronics LG TV"
    1280x720 px, 50.000000 Hz
    1280x720 px, 59.939999 Hz
    1280x720 px, 60.000000 Hz
    1360x768 px, 60.014999 Hz (preferred)
    1920x1080 px, 23.976000 Hz
    1920x1080 px, 24.000000 Hz
    1920x1080 px, 25.000000 Hz
    1920x1080 px, 29.969999 Hz
    1920x1080 px, 30.000000 Hz
    1920x1080 px, 50.000000 Hz
    1920x1080 px, 59.939999 Hz
    1920x1080 px, 60.000000 Hz (current)
`;
// A 4K set: the UI must still come out at 1080p.
const UHD = `HDMI-A-1 "LG Electronics LG TV"
    1280x720 px, 60.000000 Hz
    1920x1080 px, 23.976000 Hz
    1920x1080 px, 60.000000 Hz
    3840x2160 px, 24.000000 Hz
    3840x2160 px, 60.000000 Hz (preferred, current)
`;
// A panel with no film rates at all - the graceful-degradation case.
const NO_FILM = `HDMI-A-1 "Generic"
    1280x720 px, 60.000000 Hz
    1920x1080 px, 60.000000 Hz (preferred, current)
`;

const modesOf = (txt) => display.parse(txt).modes;
const label = (m) => (m ? `${m.width}x${m.height}@${m.refreshExact}` : String(m));

test("parse keeps modes that share a rounded key (23.976 vs 24.000)", () => {
  const m = modesOf(LG_768).filter((x) => x.key === "1920x1080@24");
  assert.deepStrictEqual(
    m.map((x) => x.refreshExact),
    [23.976, 24],
    "both 1000/1001 variants must survive - they are not interchangeable",
  );
});

test("cadenceRank: integer multiples are smooth, 2.5x and drift are not", () => {
  assert.strictEqual(display.cadenceRank(23.976, 23.976), 0);
  assert.strictEqual(display.cadenceRank(59.94, 29.97), 0, "59.94 is exactly 2x 29.97");
  assert.strictEqual(display.cadenceRank(60, 30), 0);
  assert.strictEqual(display.cadenceRank(50, 25), 0);
  assert.strictEqual(display.cadenceRank(60, 23.976), null, "2.5023x - the judder case");
  assert.strictEqual(display.cadenceRank(59.94, 23.976), null, "2.5x is still uneven");
  assert.strictEqual(display.cadenceRank(60, 25), null, "2.4x");
  assert.strictEqual(display.cadenceRank(24, 23.976), 1, "right family, drifts 0.1%");
  assert.strictEqual(display.cadenceRank(60, 29.97), 1, "2.002x - drifts");
  assert.strictEqual(display.cadenceRank(23.976, 60), null, "slower than content");
});

test("UI mode: the panel's preferred resolution, capped at 1080p", () => {
  assert.strictEqual(label(display.pickUiMode(modesOf(LG_768))), "1360x768@60.014999");
  assert.strictEqual(label(display.pickUiMode(modesOf(UHD))), "1920x1080@60", "4K panel -> 1080p UI");
  assert.strictEqual(label(display.pickUiMode(modesOf(NO_FILM))), "1920x1080@60");
});

// The panel this was found on offers 1080p120, and taking it cost the UI dearly:
// Chromium paints at the output's rate, and the Plex client alone measured 104%
// of the Pi 5's GPU at 120 Hz against 64% at 60.
test("UI mode: a high-refresh panel is capped at 60 Hz", () => {
  const HIGH_REFRESH = `HDMI-A-1 "LG Electronics LG TV"
    1920x1080 px, 59.939999 Hz
    1920x1080 px, 60.000000 Hz (preferred)
    1920x1080 px, 100.000000 Hz
    1920x1080 px, 120.000000 Hz (current)
`;
  assert.strictEqual(label(display.pickUiMode(modesOf(HIGH_REFRESH))), "1920x1080@60");
  // A panel that offers NOTHING at or below the cap still gets a mode.
  const ONLY_FAST = `HDMI-A-1 "LG Electronics LG TV"
    1920x1080 px, 100.000000 Hz
    1920x1080 px, 120.000000 Hz (preferred)
`;
  assert.strictEqual(label(display.pickUiMode(modesOf(ONLY_FAST))), "1920x1080@120");
});

test("24p content prefers a matching refresh over matching resolution", () => {
  // 720p film: 1280x720 exists but only at 50/59.94/60, all of which judder.
  const m = display.pickContentMode(modesOf(LG_768), { width: 1280, height: 720, fps: 23.976 });
  assert.strictEqual(label(m), "1920x1080@23.976");
});

test("exact cadence wins over the drifting 1000/1001 sibling", () => {
  const m = display.pickContentMode(modesOf(LG_768), { width: 1920, height: 1080, fps: 29.97 });
  assert.strictEqual(label(m), "1920x1080@29.969999", "not 30.000, which would drift");
});

test("30p and 25p land on their multiples", () => {
  const l = modesOf(LG_768);
  assert.strictEqual(label(display.pickContentMode(l, { width: 1920, height: 1080, fps: 30 })), "1920x1080@30");
  assert.strictEqual(label(display.pickContentMode(l, { width: 1920, height: 1080, fps: 25 })), "1920x1080@25");
});

test("4K content gets a 4K mode; the UI cap does not apply to video", () => {
  const m = display.pickContentMode(modesOf(UHD), { width: 3840, height: 2160, fps: 24 });
  assert.strictEqual(label(m), "3840x2160@24");
});

test("a panel with no matching refresh returns null so the caller can stay put", () => {
  assert.strictEqual(display.pickContentMode(modesOf(NO_FILM), { width: 1920, height: 1080, fps: 23.976 }), null);
  assert.strictEqual(display.pickContentMode(modesOf(NO_FILM), { width: 1280, height: 720, fps: 25 }), null);
});

test("60p content is already fine on a 60 Hz panel", () => {
  const m = display.pickContentMode(modesOf(NO_FILM), { width: 1920, height: 1080, fps: 60 });
  assert.strictEqual(label(m), "1920x1080@60");
});

test("never drops below 720p, and unknown fps is not guessed at", () => {
  const tiny = display.parse(`HDMI-A-1 "x"\n    640x480 px, 60.000000 Hz\n    1920x1080 px, 24.000000 Hz\n`).modes;
  assert.strictEqual(label(display.pickContentMode(tiny, { width: 640, height: 480, fps: 24 })), "1920x1080@24");
  assert.strictEqual(display.pickContentMode(modesOf(LG_768), { width: 1920, height: 1080, fps: 0 }), null);
});

test("an UNKNOWN size never selects an SD mode (mpv reports fps before dwidth)", () => {
  // The real trap: container-fps is readable while dwidth/dheight are still
  // unavailable, so the claim arrives as { fps, width: 0, height: 0 }. Without a
  // floor the "smallest that fits" rule happily picks 640x480 - which is what the
  // TV would actually switch to for the whole film.
  const sd = display.parse(
    `HDMI-A-1 "x"\n    640x480 px, 60.000000 Hz\n    720x576 px, 50.000000 Hz\n` +
      `    1280x720 px, 60.000000 Hz\n    1920x1080 px, 50.000000 Hz\n`,
  ).modes;
  assert.strictEqual(label(display.pickContentMode(sd, { fps: 60 })), "1280x720@60");
  assert.strictEqual(label(display.pickContentMode(sd, { width: 0, height: 0, fps: 60 })), "1280x720@60");
  assert.strictEqual(label(display.pickContentMode(sd, { width: -1, height: -1, fps: 50 })), "1920x1080@50");
});

// A TV can advertise a DCI-4K mode this hardware cannot drive, so the panel's
// answer is the PREFERRED mode rather than the biggest one.
test("panelResolution prefers the preferred mode", () => {
  const modes = [
    { width: 1920, height: 1080, preferred: false },
    { width: 4096, height: 2160, preferred: false },
    { width: 3840, height: 2160, preferred: true },
  ];
  assert.deepStrictEqual(display.panelResolution(modes), { width: 3840, height: 2160 });
});

test("panelResolution falls back to the largest mode", () => {
  const modes = [
    { width: 1280, height: 720, preferred: false },
    { width: 1920, height: 1080, preferred: false },
  ];
  assert.deepStrictEqual(display.panelResolution(modes), { width: 1920, height: 1080 });
});

test("panelResolution has no answer without modes", () => {
  assert.strictEqual(display.panelResolution([]), null);
  assert.strictEqual(display.panelResolution(null), null);
});
