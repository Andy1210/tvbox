// Photos, small enough to put on a TV.
//
// Decoding one phone photo (4000x2252) costs 166 ms on a Pi 5 and holds a 36 MB
// RGBA frame while it does, so a folder of two hundred of them cannot be handed
// to a grid as <img> tiles on a 4 GB box - something already small has to exist
// first. There are two ways to get one, and the order matters:
//
//   1. The thumbnail the CAMERA already wrote. A phone JPEG carries one in its
//      EXIF - measured across a real holiday folder: 22 files of 22, 512x288,
//      ~48 KB each - and slicing it out decodes nothing and reads only the head
//      of the file, so it costs about a millisecond against ffmpeg's 185.
//   2. ffmpeg, for everything else: PNGs, screenshots, anything a messenger
//      stripped the EXIF from, and any photo whose embedded copy cannot be
//      trusted.
//
// The slice is bare frame data with no header of its own, and two things follow
// from that:
//
//   * ORIENTATION lives in the PARENT's EXIF, which the slice leaves behind, so a
//     portrait photo's thumbnail arrives on its side. That is the common case and
//     not an edge one - 6 of 8 photos in a real holiday folder are portrait - so
//     the tag is written back onto the slice as a 36-byte EXIF block of its own
//     rather than sending those photos to ffmpeg, which would put three quarters
//     of a folder on the slow path.
//   * ASPECT is not guaranteed to match: some cameras pad or crop the embedded
//     copy to their sensor's native ratio. That one cannot be repaired from
//     outside the pixels, so a tile that would crop differently from the photo it
//     stands for goes to route 2 - better than a tile that lies.
//
// The full-size renders the viewer asks for take route 2 in every case, and get
// their rotation from ffmpeg, which reads the same tag itself (autorotate is on by
// default; checked against the 7.1.5 on the box).
//
// What leaves this module is never a copy of the source file. Route 2 re-encodes,
// and route 1 can only produce bytes that were already a self-contained JPEG
// thumbnail inside a valid EXIF block - so a caller that gets a path wrong
// receives an error rather than the contents of whatever it named. The callers
// are HTTP routes reachable by every app on the box, so that property is the
// point and not a side effect.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE_DIR = path.join(os.homedir(), ".tvbox", "cache", "thumbs");

// Enough of a file to hold its EXIF block and reach the first frame header. EXIF
// is capped at 64 KB by the format (it lives in one APP1 segment), so this covers
// it twice over and still reads a fixed, small amount off a USB stick.
const HEAD_BYTES = 128 * 1024;

const THUMB_WIDTH = 480; // a grid tile on a 1080p-class UI, with room to be sharp

// A caller may only ask for one of these. An arbitrary `w` would let a page fill
// the cache with four thousand near-identical renders of the same photo.
const VIEW_WIDTHS = [1280, 1920, 2560];

// Below this an embedded thumbnail is too soft to enlarge into a tile - some
// cameras still write the 160x120 the format originally specified.
const MIN_THUMB_EDGE = 256;
const ASPECT_TOLERANCE = 0.02;

// Two at a time on a four-core box, because a film may be playing behind this and
// the decode is the expensive half. The rest queue.
const MAX_CONCURRENT = 2;
const FFMPEG_TIMEOUT_MS = 20000; // a truncated or malicious file must not wedge a slot

// Pruned to HIGH_WATER_BYTES down to LOW_WATER_BYTES, oldest first, so the sweep
// runs rarely rather than on every write.
const HIGH_WATER_BYTES = 150e6;
const LOW_WATER_BYTES = 100e6;

const EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic", "heif"]);

// What the box can actually turn into a tile. HEIC and AVIF are listed as images
// so a folder full of them reads as photos rather than as unknown files, but
// Debian's ffmpeg has no decoder for either and Chromium shows neither, so they
// are not offered: `viewable` is the set the viewer may open.
const VIEWABLE = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp"]);

function extOf(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot < 0
    ? ""
    : String(name)
        .slice(dot + 1)
        .toLowerCase();
}

const isImage = (name) => EXTS.has(extOf(name));
const isViewable = (name) => VIEWABLE.has(extOf(name));

// The nearest width a caller is allowed to have. Anything bigger than the largest
// clamps to it: the panel is 4K at most and a photo wider than that is scenery for
// the decoder, not detail anyone sees.
function snapWidth(w) {
  const want = Number(w) || 0;
  for (const v of VIEW_WIDTHS) if (want <= v) return v;
  return VIEW_WIDTHS[VIEW_WIDTHS.length - 1];
}

// ---------------------------------------------------------------- JPEG parsing
//
// Everything below walks bytes that came off a USB stick, so every read is bounds
// checked and a malformed structure ends the walk instead of throwing. A parser
// that throws here would take the shell's HTTP server with it.

// Frame geometry, from the first SOFn marker. The three markers inside the SOF
// range that are not frame headers (DHT 0xC4, JPG 0xC8, DAC 0xCC) are skipped.
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2; // standalone marker, no length field
      continue;
    }
    if (marker === 0xda) return null; // scan data begins; no frame header found
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 9 > buf.length) return null;
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

// Orientation (IFD0) and the embedded thumbnail (IFD1), read from one APP1 block.
//
// Returned as `{ orientation, thumb }` with orientation 0 when the file does not
// say - which is treated as upright, the same as 1, because a file with no tag is
// stored the way it looks.
function exifInfo(buf) {
  const none = { orientation: 0, thumb: null };
  if (!buf || buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return none;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return none;
    const marker = buf[off + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    if (marker === 0xda) return none;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) return none;
    if (marker === 0xe1 && buf.subarray(off + 4, off + 10).equals(Buffer.from("Exif\0\0", "latin1"))) {
      return readTiff(buf.subarray(off + 10, off + 2 + len));
    }
    off += 2 + len;
  }
  return none;
}

// The TIFF structure inside an APP1 block: a header saying which way round its
// integers are, then IFD0 (the image's own tags), then IFD1 (the thumbnail's).
// All offsets are relative to the start of this buffer.
function readTiff(t) {
  const none = { orientation: 0, thumb: null };
  if (t.length < 8) return none;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return none;
  const u16 = (o) => (o + 2 <= t.length ? (le ? t.readUInt16LE(o) : t.readUInt16BE(o)) : null);
  const u32 = (o) => (o + 4 <= t.length ? (le ? t.readUInt32LE(o) : t.readUInt32BE(o)) : null);
  if (u16(2) !== 42) return none;

  // Walk one IFD, calling back per tag, and return where the next one starts.
  function walk(start, onTag) {
    const n = u16(start);
    if (n === null || n > 4096) return null; // a real IFD holds tens of tags
    let p = start + 2;
    for (let i = 0; i < n; i++, p += 12) {
      if (p + 12 > t.length) return null;
      onTag(u16(p), u16(p + 2), u32(p + 4), p + 8);
    }
    return u32(p);
  }

  let orientation = 0;
  const ifd1 = walk(u32(4), (tag, type, count, valueAt) => {
    // SHORT, one of them, stored inline - anything else is not a real orientation.
    if (tag === 0x0112 && type === 3 && count === 1) {
      const v = u16(valueAt);
      if (v >= 1 && v <= 8) orientation = v;
    }
  });
  if (!ifd1 || ifd1 <= 0 || ifd1 >= t.length) return { orientation, thumb: null };

  let at = 0;
  let size = 0;
  walk(ifd1, (tag, type, count, valueAt) => {
    if (count !== 1) return;
    const v = u32(valueAt);
    if (v === null) return;
    if (tag === 0x0201) at = v; // JPEGInterchangeFormat
    if (tag === 0x0202) size = v; // JPEGInterchangeFormatLength
  });
  if (!at || !size || at + size > t.length) return { orientation, thumb: null };
  const thumb = t.subarray(at, at + size);
  // It has to actually be a JPEG. The tag pair is a pointer into a buffer a
  // stranger's camera wrote, and everything downstream treats this as image/jpeg.
  if (thumb.length < 4 || thumb.readUInt16BE(0) !== 0xffd8) return { orientation, thumb: null };
  return { orientation, thumb };
}

// Does this JPEG already carry an EXIF block of its own? An embedded thumbnail
// normally does not - it is raw frame data - and one that does must not be given a
// second, because a reader takes the FIRST APP1 as the truth.
function hasExif(buf) {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return false;
    const marker = buf[off + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    if (marker === 0xda) return false;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return false;
    if (marker === 0xe1 && buf.subarray(off + 4, off + 10).equals(Buffer.from("Exif\0\0", "latin1"))) return true;
    off += 2 + len;
  }
  return false;
}

// The smallest legal EXIF block that says which way up an image goes: a TIFF
// header, one IFD holding one tag, and no thumbnail of its own.
function orientationApp1(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 follows the header
  tiff.writeUInt16LE(1, 8); // one tag
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14); // one of them
  tiff.writeUInt16LE(orientation, 18); // stored inline, in the low half of the field
  tiff.writeUInt32LE(0, 22); // no IFD1
  const app1 = Buffer.alloc(10);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(2 + 6 + tiff.length, 2);
  app1.write("Exif\0\0", 4, "latin1");
  return Buffer.concat([app1, tiff]);
}

// The camera's own thumbnail, ready to be served. Null means the caller has to
// render one instead.
//
// The slice is bare frame data, so the tag saying which way up it goes stays
// behind in the parent - and that is not an edge case: 6 of 8 photos in a real
// holiday folder are portrait, taken by holding the phone upright, and every one
// of them would lie on its side. So an orientation the parent declares is written
// back onto the slice as a 36-byte EXIF block of its own, which is what browsers
// read to rotate an <img>. Falling back to ffmpeg for those instead would put
// three quarters of a typical folder on the 200 ms path.
function usableExifThumb(head) {
  const { orientation, thumb } = exifInfo(head);
  if (!thumb) return null;
  const ts = jpegSize(thumb);
  if (!ts || !ts.w || !ts.h) return null;
  if (Math.max(ts.w, ts.h) < MIN_THUMB_EDGE) return null;
  const full = jpegSize(head);
  if (!full || !full.w || !full.h) return null;
  // Both sides are measured BEFORE any rotation, so this compares like with like.
  const a1 = ts.w / ts.h;
  const a2 = full.w / full.h;
  if (Math.abs(a1 - a2) / a2 > ASPECT_TOLERANCE) return null; // padded or cropped
  if (orientation <= 1) return thumb;
  if (hasExif(thumb)) return null; // its own block would be read instead of ours
  return Buffer.concat([thumb.subarray(0, 2), orientationApp1(orientation), thumb.subarray(2)]);
}

// ------------------------------------------------------------------ ffmpeg
//
// One queue for the whole box. `-map_metadata -1` is not tidiness: a photo's EXIF
// carries where it was taken, and these renders are served to every app on the
// box, so the coordinates should not travel with the tile.

let ffmpegMissing = false;
let running = 0;
const queue = [];

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    job(() => {
      running--;
      pump();
    });
  }
}

function render(file, width, out, cb) {
  if (ffmpegMissing) return cb("no_ffmpeg");
  queue.push((done) => {
    const args = [
      "-v",
      "error",
      "-y",
      "-i",
      file,
      "-map_metadata",
      "-1",
      "-frames:v",
      "1",
      // Never enlarge: a small source rendered at 2560 costs bandwidth and memory
      // for pixels it does not have. -2 keeps the height even, which mjpeg needs.
      "-vf",
      "scale='min(" + width + ",iw)':-2",
      "-q:v",
      "3",
      out,
    ];
    let child;
    try {
      child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      ffmpegMissing = true;
      done();
      return cb("no_ffmpeg");
    }
    let err = "";
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
      cb(reason);
    };
    // Drained rather than ignored: a stderr nobody reads fills its pipe and stops
    // the process that is writing it, which on a bad file is a wedged slot.
    child.stderr.on("data", (c) => {
      if (err.length < 2000) err += c;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (e) {}
      finish("timeout");
    }, FFMPEG_TIMEOUT_MS);
    child.on("error", (e) => {
      if (e && e.code === "ENOENT") ffmpegMissing = true;
      finish(e && e.code === "ENOENT" ? "no_ffmpeg" : "failed");
    });
    child.on("close", (code) => {
      if (code === 0) return finish(null);
      console.warn("[images] ffmpeg failed:", path.basename(file), err.trim().split("\n")[0] || "code " + code);
      finish("failed");
    });
  });
  pump();
}

// ------------------------------------------------------------------- the cache
//
// Keyed on the file's identity AND its size and mtime, so a photo replaced under
// the same name renders again instead of serving the old one.

function keyFor(file, stat, kind) {
  return (
    crypto
      .createHash("sha1")
      .update(file + "\0" + stat.size + "\0" + Math.round(stat.mtimeMs) + "\0" + kind)
      .digest("hex") + ".jpg"
  );
}

function pruneCache() {
  let files;
  try {
    files = fs.readdirSync(CACHE_DIR);
  } catch (e) {
    return;
  }
  const stats = [];
  let total = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(CACHE_DIR, f));
      if (!st.isFile()) continue;
      stats.push({ f, size: st.size, at: st.mtimeMs });
      total += st.size;
    } catch (e) {}
  }
  if (total <= HIGH_WATER_BYTES) return;
  stats.sort((a, b) => a.at - b.at);
  for (const s of stats) {
    if (total <= LOW_WATER_BYTES) break;
    try {
      fs.unlinkSync(path.join(CACHE_DIR, s.f));
      total -= s.size;
    } catch (e) {}
  }
}

let writesSincePrune = 0;
function notePrune() {
  if (++writesSincePrune < 100) return;
  writesSincePrune = 0;
  pruneCache();
}

// Requests for the same cache entry that arrive while it is being produced. A grid
// scrolling back over a tile it already asked for must not start a second ffmpeg.
const inflight = new Map();

function coalesce(key, work, cb) {
  const waiting = inflight.get(key);
  if (waiting) return waiting.push(cb);
  inflight.set(key, [cb]);
  work((err, file) => {
    const list = inflight.get(key) || [];
    inflight.delete(key);
    for (const fn of list) fn(err, file);
  });
}

// Written beside the target and renamed, so a reader can never open a half-written
// file: rename within one directory is atomic.
function commit(tmp, dest, cb) {
  fs.rename(tmp, dest, (e) => {
    if (e) {
      try {
        fs.unlinkSync(tmp);
      } catch (e2) {}
      return cb("failed");
    }
    notePrune();
    cb(null, dest);
  });
}

let tmpSeq = 0;
const tmpName = (key) => path.join(CACHE_DIR, "." + process.pid + "-" + ++tmpSeq + "-" + key);

// A tile for `file`, as a path to a cached JPEG. `kind` is "thumb" or a view
// width; the two never share an entry.
function produce(file, kind, cb) {
  if (!isViewable(file)) return cb("unsupported");
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return cb("not_found");
    const key = keyFor(file, st, kind);
    const dest = path.join(CACHE_DIR, key);
    fs.access(dest, (missing) => {
      if (!missing) return cb(null, dest);
      coalesce(
        key,
        (done) => {
          try {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
          } catch (e2) {
            return done("failed");
          }
          const tmp = tmpName(key);
          // ffmpeg opens its output before it decodes, so a file it cannot read -
          // or one it was killed part way through - usually leaves a partial `tmp`
          // behind. Nothing else would ever collect it: `commit` only unlinks when
          // the rename fails, and the prune counter only advances on success, so a
          // folder of undecodable files would drop one orphan per request and
          // never trigger the sweep that would clear them.
          const fail = (err) => fs.unlink(tmp, () => done(err));
          if (kind === "thumb") {
            return embedded(file, (thumb) => {
              if (!thumb) return render(file, THUMB_WIDTH, tmp, (err) => (err ? fail(err) : commit(tmp, dest, done)));
              fs.writeFile(tmp, thumb, (we) => (we ? fail("failed") : commit(tmp, dest, done)));
            });
          }
          render(file, Number(kind), tmp, (err) => (err ? fail(err) : commit(tmp, dest, done)));
        },
        cb,
      );
    });
  });
}

// The camera's thumbnail, or null. Only JPEGs carry one, and only the head of the
// file is read - the whole point is not to touch the rest.
function embedded(file, cb) {
  if (!/\.jpe?g$/i.test(file)) return cb(null);
  fs.open(file, "r", (e, fd) => {
    if (e) return cb(null);
    const buf = Buffer.alloc(HEAD_BYTES);
    fs.read(fd, buf, 0, HEAD_BYTES, 0, (re, read) => {
      fs.close(fd, () => {});
      if (re || !read) return cb(null);
      let out;
      try {
        out = usableExifThumb(buf.subarray(0, read));
      } catch (e2) {
        out = null; // a malformed EXIF is a reason to render, not to fail
      }
      cb(out);
    });
  });
}

const thumb = (file, cb) => produce(file, "thumb", cb);
const view = (file, width, cb) => produce(file, String(snapWidth(width)), cb);

module.exports = {
  CACHE_DIR,
  THUMB_WIDTH,
  VIEW_WIDTHS,
  isImage,
  isViewable,
  snapWidth,
  jpegSize,
  exifInfo,
  usableExifThumb,
  thumb,
  view,
  pruneCache,
};
