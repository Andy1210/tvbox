// A still of what is on the TV, small enough to send to a phone.
//
// This exists for ONE reason: driving the box from a phone is only half a
// testing tool if you cannot see what the press did. It is not screen mirroring
// and is deliberately bad at it - a frame takes about half a second to produce,
// so the honest description is "a picture every few seconds", not a picture of a
// film.
//
// It is also the most sensitive thing this box can hand out. The remote lets a
// paired phone press what the physical remote presses; a frame shows whatever is
// on screen, which includes a wifi password being typed on the on-screen keyboard
// and the pairing code itself. So it is off by default, separate from the remote,
// and it EXPIRES - a switch left on is the failure mode here, not a switch nobody
// found.
//
// Cost, measured on a Pi 5: the compositor's readback is ~350 ms and produces a
// ~700 KB PNG; scaling it to 960 wide costs another ~175 ms and 31 KB. So a frame
// is about half a second and the encode is the cheap half. Polling every two
// seconds cost about a quarter of one core.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const compositor = require("./compositor");

const RAW = path.join(os.tmpdir(), "tvbox-screenframe.png");
const OUT = path.join(os.tmpdir(), "tvbox-screenframe.jpg");

const WIDTH = 960; // a phone screen's worth; the whole point is not to be a mirror
const QUALITY = "6"; // ffmpeg -q:v, where 2 is best and 31 worst

// Two guards on how often this can run, and they are different guards. A frame in
// flight is not started twice (the readback is half a second, and a phone that
// polls faster would queue them behind each other). And a frame just taken is
// handed out again rather than retaken, so several viewers cost what one does.
const MIN_GAP_MS = 900;
const FFMPEG_TIMEOUT_MS = 15000;

let inFlight = null;
let takenAt = 0;

function convert(cb) {
  execFile(
    "ffmpeg",
    ["-v", "error", "-y", "-i", RAW, "-vf", "scale='min(" + WIDTH + ",iw)':-2", "-q:v", QUALITY, OUT],
    { timeout: FFMPEG_TIMEOUT_MS },
    (e) => cb(e ? (e.code === "ENOENT" ? "no_ffmpeg" : "failed") : null),
  );
}

// The current frame, as a path to a JPEG. `maxAgeMs` is how stale a picture the
// caller will accept before a new one is taken.
function frame(maxAgeMs, cb) {
  const age = Date.now() - takenAt;
  if (takenAt && age < Math.max(maxAgeMs, MIN_GAP_MS)) return cb(null, OUT, age);
  if (inFlight) return inFlight.push(cb);
  inFlight = [cb];
  const done = (err) => {
    const waiting = inFlight || [];
    inFlight = null;
    if (!err) takenAt = Date.now();
    for (const fn of waiting) fn(err, err ? null : OUT, 0);
  };
  // The compositor writes the PNG itself - there is no other way to read the
  // screen without a capture protocol, and it already answers this request.
  compositor.request({ request: "screenshot", path: RAW }, (err, ok) => {
    if (err || !ok) return done("unavailable");
    convert(done);
  });
}

// Nothing here should outlive the session that asked for it.
function forget() {
  takenAt = 0;
  for (const f of [RAW, OUT]) {
    try {
      fs.unlinkSync(f);
    } catch (e) {}
  }
}

module.exports = { WIDTH, frame, forget };
