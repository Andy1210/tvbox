// Turning a photo into something a TV can hold.
//
// What is under test is mostly a PARSER, and its input is a file off a USB stick
// somebody else prepared - so the assertions that matter are about structures that
// are wrong: a thumbnail pointer past the end of the block, a tag count no camera
// would write, a length field of zero that would make an offset walk stand still.
// None of these may throw, because the caller is the shell's HTTP server and an
// exception there takes the whole box down.
//
// The fixtures are built byte by byte rather than shipped as files. Nothing here
// decodes an image, so a real JPEG would only make the expected values harder to
// see - and CI has no ffmpeg to make one with.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-images-test-")));
process.env.HOME = path.join(TMP, "home"); // the cache directory is resolved at import
fs.mkdirSync(process.env.HOME, { recursive: true });

const images = require("./images");

// ------------------------------------------------------------------- fixtures

// A frame header, which is where a JPEG says how big it is.
function sof(w, h) {
  const b = Buffer.alloc(19);
  b.writeUInt16BE(0xffc0, 0); // SOF0
  b.writeUInt16BE(17, 2); // length: itself, plus the 15 bytes below
  b[4] = 8; // sample precision
  b.writeUInt16BE(h, 5);
  b.writeUInt16BE(w, 7);
  b[9] = 3; // three components, nine bytes of them
  return b;
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

// A whole small JPEG - enough of one for a parser to measure.
const jpeg = (w, h) => Buffer.concat([SOI, sof(w, h), EOI]);

// One 12-byte IFD entry. Values that fit in four bytes live inline, which is where
// an orientation is; the thumbnail's pointer and length are the same shape.
function entry(tag, type, count, value) {
  const b = Buffer.alloc(12);
  b.writeUInt16LE(tag, 0);
  b.writeUInt16LE(type, 2);
  b.writeUInt32LE(count, 4);
  if (type === 3) b.writeUInt16LE(value, 8);
  else b.writeUInt32LE(value, 8);
  return b;
}

// A TIFF block holding IFD0 (the photo's own tags) and, optionally, IFD1 with a
// thumbnail hanging off it. Little-endian, which is what phones write.
function tiff({ orientation, thumb }) {
  const header = Buffer.alloc(8);
  header.write("II", 0, "latin1");
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4); // IFD0 starts right after this header

  const ifd0Tags = orientation ? [entry(0x0112, 3, 1, orientation)] : [];
  const ifd0Len = 2 + ifd0Tags.length * 12 + 4;
  const ifd0At = 8;
  const ifd1At = thumb ? ifd0At + ifd0Len : 0;

  const ifd0 = Buffer.alloc(ifd0Len);
  ifd0.writeUInt16LE(ifd0Tags.length, 0);
  Buffer.concat(ifd0Tags).copy(ifd0, 2);
  ifd0.writeUInt32LE(ifd1At, 2 + ifd0Tags.length * 12);
  if (!thumb) return Buffer.concat([header, ifd0]);

  const ifd1Tags = [];
  const ifd1Len = 2 + 2 * 12 + 4;
  const thumbAt = ifd1At + ifd1Len;
  ifd1Tags.push(entry(0x0201, 4, 1, thumbAt), entry(0x0202, 4, 1, thumb.length));
  const ifd1 = Buffer.alloc(ifd1Len);
  ifd1.writeUInt16LE(2, 0);
  Buffer.concat(ifd1Tags).copy(ifd1, 2);
  ifd1.writeUInt32LE(0, 2 + 2 * 12); // no IFD2
  return Buffer.concat([header, ifd0, ifd1, thumb]);
}

// A photo as a camera writes one: an EXIF block, then the image's own frame.
function photo({ w = 4000, h = 2252, orientation = 0, thumb = null } = {}) {
  const t = tiff({ orientation, thumb });
  const app1 = Buffer.alloc(4 + 6);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(2 + 6 + t.length, 2);
  app1.write("Exif\0\0", 4, "latin1");
  return Buffer.concat([SOI, app1, t, sof(w, h), EOI]);
}

// ------------------------------------------------------------------ what it is

test("an image is recognised by extension, and HEIC is an image nothing can open", () => {
  assert.equal(images.isImage("holiday.JPG"), true);
  assert.equal(images.isImage("shot.png"), true);
  assert.equal(images.isImage("clip.mkv"), false);
  assert.equal(images.isImage("noextension"), false);
  // Listed as an image so a folder of them reads as photos, but not offered:
  // neither Debian's ffmpeg nor Chromium can decode one.
  assert.equal(images.isImage("IMG_0001.heic"), true);
  assert.equal(images.isViewable("IMG_0001.heic"), false);
  assert.equal(images.isViewable("holiday.jpg"), true);
});

test("a caller may only have one of the offered widths", () => {
  // Otherwise one page could fill the cache with four thousand renders of the
  // same photo, each one pixel wider than the last.
  for (const w of images.VIEW_WIDTHS) assert.ok(images.VIEW_WIDTHS.includes(images.snapWidth(w)));
  assert.equal(images.snapWidth(1), 1280);
  assert.equal(images.snapWidth(1281), 1920);
  assert.equal(images.snapWidth(99999), 2560);
  assert.equal(images.snapWidth("nonsense"), 1280);
});

// --------------------------------------------------------------------- parsing

test("frame geometry comes from the first frame header", () => {
  assert.deepEqual(images.jpegSize(jpeg(4000, 2252)), { w: 4000, h: 2252 });
  assert.deepEqual(images.jpegSize(photo({ w: 1024, h: 768 })), { w: 1024, h: 768 });
});

test("orientation and the camera's own thumbnail are read out of one EXIF block", () => {
  const thumb = jpeg(512, 288);
  const info = images.exifInfo(photo({ orientation: 6, thumb }));
  assert.equal(info.orientation, 6);
  assert.ok(info.thumb);
  assert.deepEqual(Buffer.from(info.thumb), thumb);
});

test("a file that says nothing about orientation is treated as upright", () => {
  // Absent is not the same value as 1, but it means the same thing: a file with no
  // tag is stored the way it looks.
  assert.equal(images.exifInfo(photo({})).orientation, 0);
  assert.equal(images.exifInfo(jpeg(100, 100)).orientation, 0);
});

test("nothing in a malformed file throws", () => {
  const good = photo({ orientation: 1, thumb: jpeg(512, 288) });
  const cases = {
    empty: Buffer.alloc(0),
    "not a jpeg": Buffer.from("this is a text file that someone renamed"),
    "soi only": SOI,
    "truncated mid-segment": good.subarray(0, 12),
    "zero length field": Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x00]), EOI]),
    "segment longer than the file": Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x7f, 0xff])]),
    "no marker where one is due": Buffer.concat([SOI, Buffer.from([0x00, 0x00, 0x00, 0x08])]),
  };
  for (const [what, buf] of Object.entries(cases)) {
    assert.doesNotThrow(() => images.exifInfo(buf), what);
    assert.doesNotThrow(() => images.jpegSize(buf), what);
    assert.doesNotThrow(() => images.usableExifThumb(buf), what);
    assert.equal(images.usableExifThumb(buf), null, what);
  }
});

test("a thumbnail pointer that leaves the block is refused", () => {
  // The pointer and its length are two numbers a stranger's camera wrote. Trusting
  // them would hand out whatever follows the EXIF block in memory.
  const t = tiff({ orientation: 1, thumb: jpeg(512, 288) });
  const far = Buffer.from(t);
  // 0x0201's inline value: IFD0 here is a header (8) + one tag IFD (2+12+4), then
  // IFD1's first entry is the pointer, whose value sits eight bytes into it.
  far.writeUInt32LE(0xffffff, 8 + 18 + 2 + 8);
  const app1 = Buffer.alloc(10);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(2 + 6 + far.length, 2);
  app1.write("Exif\0\0", 4, "latin1");
  const bad = Buffer.concat([SOI, app1, far, sof(4000, 2252), EOI]);
  assert.equal(images.exifInfo(bad).thumb, null);
});

test("what is pointed at has to be a JPEG", () => {
  // Everything downstream serves this as image/jpeg, so a pointer into arbitrary
  // bytes must not become an image response.
  const notJpeg = Buffer.alloc(64, 0x41);
  assert.equal(images.exifInfo(photo({ orientation: 1, thumb: notJpeg })).thumb, null);
});

// ------------------------------------------- when the camera's thumbnail is used

test("the camera's thumbnail stands in for the photo when it is upright and the right shape", () => {
  const thumb = jpeg(512, 288);
  const out = images.usableExifThumb(photo({ w: 4000, h: 2252, orientation: 1, thumb }));
  assert.ok(out, "a 16:9 thumbnail of a 16:9 photo is exactly what it is for");
  assert.deepEqual(Buffer.from(out), thumb, "upright means the bytes pass through untouched");
  assert.deepEqual(
    Buffer.from(images.usableExifThumb(photo({ w: 4000, h: 2252, orientation: 0, thumb }))),
    thumb,
    "no tag reads as upright",
  );
});

test("a photo that is not upright keeps the camera's thumbnail, with the tag written onto it", () => {
  // The common case, not an edge one: most of a real holiday folder is portrait.
  // The slice leaves the parent's tag behind, so it is put back - otherwise every
  // one of those tiles would arrive on its side.
  const thumb = jpeg(512, 288);
  for (const o of [2, 3, 4, 5, 6, 7, 8]) {
    const out = images.usableExifThumb(photo({ orientation: o, thumb }));
    assert.ok(out, "orientation " + o);
    // Still a JPEG, still the same frame - only a header in front of it.
    assert.equal(out.readUInt16BE(0), 0xffd8, "orientation " + o);
    assert.deepEqual(images.jpegSize(out), { w: 512, h: 288 }, "orientation " + o);
    // And a parser reads back exactly the orientation the parent declared.
    assert.equal(images.exifInfo(out).orientation, o, "orientation " + o);
    assert.equal(out.length, thumb.length + 36, "the block is the smallest legal one");
  }
});

test("a thumbnail that already carries EXIF is not given a second block", () => {
  // A reader takes the FIRST APP1 as the truth, so prepending ours would be a
  // silent argument with the one already there.
  const withOwnExif = photo({ w: 512, h: 288, orientation: 1 });
  assert.equal(images.usableExifThumb(photo({ w: 4000, h: 2252, orientation: 6, thumb: withOwnExif })), null);
});

test("a thumbnail that is padded or cropped is rendered instead", () => {
  // Some cameras write the embedded copy at the sensor's native ratio. A tile that
  // crops differently from the photo it stands for is worse than one that waited.
  assert.equal(images.usableExifThumb(photo({ w: 4000, h: 2252, orientation: 1, thumb: jpeg(512, 384) })), null);
});

test("a thumbnail too small to enlarge is rendered instead", () => {
  // The format originally specified 160x120 and some cameras still write it.
  assert.equal(images.usableExifThumb(photo({ w: 160, h: 120, orientation: 1, thumb: jpeg(160, 120) })), null);
});

// ----------------------------------------------------------------------- cache

test("a thumbnail is produced once and then re-used", (t, done) => {
  const file = path.join(TMP, "holiday.jpg");
  const thumb = jpeg(512, 288);
  fs.writeFileSync(file, photo({ w: 4000, h: 2252, orientation: 1, thumb }));
  images.thumb(file, (err, out) => {
    assert.equal(err, null);
    // The camera's own copy, byte for byte - no encoder ran.
    assert.deepEqual(fs.readFileSync(out), thumb);
    assert.ok(out.startsWith(images.CACHE_DIR + path.sep), "it lands in the cache");
    const first = fs.statSync(out).mtimeMs;
    images.thumb(file, (err2, out2) => {
      assert.equal(err2, null);
      assert.equal(out2, out);
      assert.equal(fs.statSync(out2).mtimeMs, first, "the second call did not rewrite it");
      done();
    });
  });
});

test("a photo edited under the same name is not served from the old entry", (t, done) => {
  const file = path.join(TMP, "edited.jpg");
  fs.writeFileSync(file, photo({ w: 4000, h: 2252, orientation: 1, thumb: jpeg(512, 288) }));
  images.thumb(file, (err, first) => {
    assert.equal(err, null);
    const replacement = jpeg(640, 360);
    fs.writeFileSync(file, photo({ w: 1280, h: 720, orientation: 1, thumb: replacement }));
    // These fixtures are a fixed length whatever their dimensions, so mtime is the
    // only part of the key that differs - and two writes one callback apart can
    // land on the same one where the filesystem's clock is coarse.
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);
    images.thumb(file, (err2, second) => {
      assert.equal(err2, null);
      assert.notEqual(second, first, "size and mtime are part of the key");
      assert.deepEqual(fs.readFileSync(second), replacement);
      done();
    });
  });
});

test("two requests for the same tile do not both produce it", (t, done) => {
  const file = path.join(TMP, "shared.jpg");
  fs.writeFileSync(file, photo({ w: 4000, h: 2252, orientation: 1, thumb: jpeg(512, 288) }));
  let seen = 0;
  const settle = (err, out) => {
    assert.equal(err, null);
    assert.ok(out);
    if (++seen === 2) done();
  };
  // A grid scrolling back over a tile it already asked for must not start a second
  // render of it. Issued in the same tick, before either can have finished.
  images.thumb(file, settle);
  images.thumb(file, settle);
});

test("what is not an image, and what is not there, are told apart", (t, done) => {
  const notAnImage = path.join(TMP, "notes.txt");
  fs.writeFileSync(notAnImage, "hello");
  images.thumb(notAnImage, (err) => {
    assert.equal(err, "unsupported");
    images.thumb(path.join(TMP, "gone.jpg"), (err2) => {
      assert.equal(err2, "not_found");
      // A directory named like a photo is not a file to open.
      const dir = path.join(TMP, "album.jpg");
      fs.mkdirSync(dir, { recursive: true });
      images.thumb(dir, (err3) => {
        assert.equal(err3, "not_found");
        done();
      });
    });
  });
});

test("a jpeg with no usable embedded copy needs a renderer", (t, done) => {
  // No EXIF at all, so route 1 has nothing to offer. Without ffmpeg on the machine
  // running the tests that is a reported failure, not a hang and not a crash -
  // which is the same answer a box missing the dependency gives.
  const file = path.join(TMP, "plain.jpg");
  fs.writeFileSync(file, jpeg(4000, 2252));
  images.thumb(file, (err, out) => {
    if (err) assert.ok(["no_ffmpeg", "failed", "timeout"].includes(err), "unexpected reason: " + err);
    else assert.ok(fs.existsSync(out));
    done();
  });
});

test("a render that fails leaves nothing behind", (t, done) => {
  // ffmpeg opens its output before it decodes, so a file it cannot read leaves a
  // partial one. Nothing else would collect it - the prune counter only advances
  // on success - so a folder of undecodable files would drop one orphan per
  // request and never trigger the sweep that would clear them.
  fs.mkdirSync(images.CACHE_DIR, { recursive: true });
  const before = fs.readdirSync(images.CACHE_DIR).length;
  const file = path.join(TMP, "undecodable.jpg");
  fs.writeFileSync(file, jpeg(4000, 2252)); // a frame header and no pixels
  images.thumb(file, (err) => {
    // Without ffmpeg on this machine the render never starts, and there is nothing
    // to clean up either - both answers leave the directory as it was.
    assert.ok(err, "it cannot be rendered");
    assert.equal(fs.readdirSync(images.CACHE_DIR).length, before, "no orphan left in the cache");
    done();
  });
});

test("the cache is pruned rather than left to grow", () => {
  fs.mkdirSync(images.CACHE_DIR, { recursive: true });
  const before = fs.readdirSync(images.CACHE_DIR).length;
  const big = path.join(images.CACHE_DIR, "aaaa-old-entry.jpg");
  fs.writeFileSync(big, Buffer.alloc(1024));
  assert.doesNotThrow(() => images.pruneCache());
  // Well under the high-water mark, so nothing should have gone.
  assert.equal(fs.readdirSync(images.CACHE_DIR).length, before + 1);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
