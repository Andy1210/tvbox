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

// NOT the shared temp directory. A frame can hold a wifi password being typed on
// the on-screen keyboard and the pairing code itself, and a predictable path
// there is one another local process can pre-create, symlink or read. Own
// directory under ~/.tvbox, created 0700, like every other secret this box keeps.
const DIR = path.join(os.homedir(), ".tvbox", "screenframe");
const RAW = path.join(DIR, "frame.png");
const out = (w) => path.join(DIR, "frame-" + w + ".jpg");

function ensureDir() {
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    // recursive:true does not chmod a directory that already existed, and one
    // left behind by an older build would keep its old mode.
    fs.chmodSync(DIR, 0o700);
    return true;
  } catch (e) {
    console.warn("[screenframe] cannot create", DIR, e.message);
    return false;
  }
}

// Two sizes, and the second one exists because of zoom: pinching into a 960-wide
// JPEG magnifies its artefacts, not the screen. The readback is the expensive
// half and it is shared - one PNG, whichever widths are asked for - so the larger
// one costs an encode, not another capture.
const WIDTHS = [960, 1440];
const WIDTH = WIDTHS[0];
const snapWidth = (w) => (Number(w) >= WIDTHS[1] ? WIDTHS[1] : WIDTHS[0]);
const QUALITY = "6"; // ffmpeg -q:v, where 2 is best and 31 worst

// Two guards on how often this can run, and they are different guards. A frame in
// flight is not started twice (the readback is half a second, and a phone that
// polls faster would queue them behind each other). And a frame just taken is
// handed out again rather than retaken, so several viewers cost what one does.
const MIN_GAP_MS = 900;
const FFMPEG_TIMEOUT_MS = 15000;

let inFlight = null;
let takenAt = 0;

function convert(width, cb) {
  execFile(
    "ffmpeg",
    ["-v", "error", "-y", "-i", RAW, "-vf", "scale='min(" + width + ",iw)':-2", "-q:v", QUALITY, out(width)],
    { timeout: FFMPEG_TIMEOUT_MS },
    (e) => {
      // ffmpeg creates the file under the process umask, which is not ours to
      // assume. The 0700 directory is the real boundary; this is so the answer
      // does not depend on which of the two is checked.
      if (!e) {
        try {
          fs.chmodSync(out(width), 0o600);
        } catch (e2) {}
      }
      cb(e ? (e.code === "ENOENT" ? "no_ffmpeg" : "failed") : null);
    },
  );
}

// The current frame, as a path to a JPEG. `maxAgeMs` is how stale a picture the
// caller will accept before a new one is taken.
function frame(maxAgeMs, width, cb) {
  const w = snapWidth(width);
  const age = Date.now() - takenAt;
  // A picture already taken is re-used whatever size is asked for - the capture is
  // shared, and only the encode is per width.
  if (takenAt && age < Math.max(maxAgeMs, MIN_GAP_MS) && fs.existsSync(out(w))) return cb(null, out(w), age);
  if (inFlight) return inFlight.push({ w, cb });
  if (!ensureDir()) return cb("failed");
  inFlight = [{ w, cb }];
  const done = (err) => {
    const waiting = inFlight || [];
    inFlight = null;
    if (!err) takenAt = Date.now();
    for (const one of waiting) one.cb(err, err ? null : out(one.w), 0);
  };
  // The compositor writes the PNG itself - there is no other way to read the
  // screen without a capture protocol, and it already answers this request.
  compositor.request({ request: "screenshot", path: RAW }, (err, ok) => {
    if (err || !ok) return done("unavailable");
    // Every width someone is waiting for, off the one capture.
    const wanted = [...new Set((inFlight || []).map((one) => one.w))];
    let left = wanted.length;
    let failure = null;
    for (const each of wanted) {
      convert(each, (e) => {
        failure = failure || e;
        if (--left === 0) done(failure);
      });
    }
  });
}

// Nothing here should outlive the sharing that asked for it - the files are the
// sensitive part, not the state.
function forget() {
  takenAt = 0;
  for (const f of [RAW, ...WIDTHS.map(out)]) {
    try {
      fs.unlinkSync(f);
    } catch (e) {}
  }
}

module.exports = { WIDTH, WIDTHS, snapWidth, frame, forget };
