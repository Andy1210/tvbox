// Which renderer a stream gets. Every "false" here is a real failure on the box:
// the zero-copy output shows nothing at all for a software-decoded stream, does
// not exist under XWayland, and throws away tone mapping - so it has to stay
// pinned to the one case that needs it.
const test = require("node:test");
const assert = require("node:assert");
const videoout = require("./videoout");

const uhd = { fps: 23.976, width: 3840, height: 2160, hwdec: "drm" };

test("4K hardware-decoded fullscreen video takes the zero-copy output", () => {
  assert.equal(videoout.zeroCopyVideo(uhd, false), true);
});

test("software-decoded video keeps the GPU renderer", () => {
  // dmabuf-wayland fails at the hwupload for these and leaves a black screen.
  assert.equal(videoout.zeroCopyVideo({ ...uhd, hwdec: "no" }, false), false);
  assert.equal(videoout.zeroCopyVideo({ ...uhd, hwdec: "" }, false), false);
  assert.equal(videoout.zeroCopyVideo({ fps: 24, width: 3840, height: 2160 }, false), false);
});

test("below 4K the GPU renderer keeps up, so its tone mapping is kept", () => {
  assert.equal(videoout.zeroCopyVideo({ ...uhd, width: 1920, height: 1080 }, false), false);
  assert.equal(videoout.zeroCopyVideo({ ...uhd, width: 1280, height: 720 }, false), false);
  // 1440p is the floor, not an exclusive bound.
  assert.equal(videoout.zeroCopyVideo({ ...uhd, width: 2560, height: 1440 }, false), true);
});

test("PiP never takes it - that window runs under XWayland", () => {
  assert.equal(videoout.zeroCopyVideo(uhd, true), false);
});

test("an undecided hwdec is waited for, but only where it decides anything", () => {
  // "property unavailable" right after a paused start - ask again.
  assert.equal(videoout.hwdecPending({ ...uhd, hwdec: "" }, false), true);
  // Settled answers, either way: nothing to wait for.
  assert.equal(videoout.hwdecPending(uhd, false), false);
  assert.equal(videoout.hwdecPending({ ...uhd, hwdec: "no" }, false), false);
  // Below 4K and in PiP the answer changes nothing, so the film is not held up.
  assert.equal(videoout.hwdecPending({ ...uhd, height: 1080, hwdec: "" }, false), false);
  assert.equal(videoout.hwdecPending({ ...uhd, hwdec: "" }, true), false);
});

test("missing video properties do not pick it", () => {
  assert.equal(videoout.zeroCopyVideo(null, false), false);
  assert.equal(videoout.zeroCopyVideo({ hwdec: "drm" }, false), false);
  assert.equal(videoout.zeroCopyVideo({ ...uhd, height: 0 }, false), false);
});
