// The session a phone casts photos into.
//
// Two things are worth a test here and they pull in opposite directions. The
// filename comes off a phone, so it is somebody else's string and the tests below
// are mostly about what it is not allowed to become. And the session has to EMPTY
// completely - a name that `save` accepts but `list` then skips would be a file
// nothing ever deletes, on the box's boot medium.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-photoshare-test-")));
process.env.HOME = path.join(TMP, "home"); // the directory is resolved at import
fs.mkdirSync(process.env.HOME, { recursive: true });

const photoshare = require("./photoshare");

// A one-pixel PNG, so what is stored is at least a real image. Nothing here
// decodes it; what matters is that it is bytes and that they survive base64.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const b64 = (buf) => buf.toString("base64");

test.beforeEach(() => photoshare.clear());

test("a photo arrives, and comes back in the order it was sent", () => {
  photoshare.save("first.jpg", b64(PNG));
  photoshare.save("second.jpg", b64(PNG));
  photoshare.save("third.jpg", b64(PNG));
  // The order the phone's picker offered them is the order someone expects to page
  // through, and the numbering is what makes that a plain sort.
  assert.deepEqual(
    photoshare.list().map((n) => n.slice(5)),
    ["first.jpg", "second.jpg", "third.jpg"],
  );
});

test("a data: URL is accepted as it comes off the phone", () => {
  const name = photoshare.save("x.png", "data:image/png;base64," + b64(PNG));
  assert.deepEqual(fs.readFileSync(path.join(photoshare.DIR, name)), PNG);
});

test("numbering continues from what is on disk", () => {
  // The shell can reload mid-session. A counter held in memory would restart at one
  // and write over the photos already sent.
  photoshare.save("a.jpg", b64(PNG));
  photoshare.save("b.jpg", b64(PNG));
  delete require.cache[require.resolve("./photoshare")];
  const reloaded = require("./photoshare");
  reloaded.save("c.jpg", b64(PNG));
  assert.equal(reloaded.list().length, 3);
  assert.deepEqual(
    reloaded.list().map((n) => n.slice(0, 4)),
    ["0001", "0002", "0003"],
  );
});

test("a name from a phone cannot become a path", () => {
  // Every one of these is stored under a sanitised name in the session directory,
  // and nowhere else.
  for (const nasty of ["../../.tvbox/config.json", "/etc/passwd", "..", ".", "a/b/c.jpg", "....//x.jpg"]) {
    const stored = photoshare.save(nasty, b64(PNG));
    assert.ok(!stored.includes("/"), nasty);
    assert.ok(!stored.includes("\\"), nasty);
    const full = path.join(photoshare.DIR, stored);
    assert.equal(path.dirname(full), photoshare.DIR, nasty);
    assert.ok(fs.existsSync(full), nasty);
  }
  // And every one of them is visible to the sweep, which is what makes the session
  // actually empty rather than nearly empty.
  assert.equal(photoshare.list().length, 6);
  assert.equal(photoshare.clear(), 6);
  assert.deepEqual(fs.readdirSync(photoshare.DIR), []);
});

test("a name without a usable extension becomes a jpeg", () => {
  assert.ok(photoshare.save("IMG_4021", b64(PNG)).endsWith(".jpg"));
  assert.ok(photoshare.save("archive.zip", b64(PNG)).endsWith(".jpg"));
});

test("anything save accepts, the session can also see and delete", () => {
  // The invariant, not a list of extensions: whatever `save` decides to store has
  // to be visible to list(), servable by pathFor() and removed by clear(). A file
  // that only half-matches would be a photo nobody can look at and nothing ever
  // deletes, on a box whose whole promise is that these do not stay - which is
  // exactly what an upper-case extension did, because a camera writes IMG_0001.JPG
  // and only the accepting half of the pair was case-insensitive.
  const names = [
    "IMG_0001.JPG",
    "shot.PNG",
    "x.Jpeg",
    "y.JPEG",
    "z.WebP",
    "holiday.jpg",
    "a.webp",
    "no-extension",
    "weird name (1).jpeg",
    "árvíztűrő.jpg",
  ];
  for (const n of names) {
    const stored = photoshare.save(n, b64(PNG));
    assert.ok(photoshare.list().includes(stored), n + " is not listed");
    assert.equal(photoshare.pathFor(stored), path.join(photoshare.DIR, stored), n + " cannot be served");
  }
  assert.equal(photoshare.clear(), names.length, "every one of them goes");
  assert.deepEqual(fs.readdirSync(photoshare.DIR), [], "and nothing is left behind");
});

test("an empty body is refused", () => {
  assert.throws(() => photoshare.save("empty.jpg", ""), /empty/);
  assert.throws(() => photoshare.save("empty.jpg", "data:image/jpeg;base64,"), /empty/);
});

test("only the session's own files are served, and only by name", () => {
  const name = photoshare.save("holiday.jpg", b64(PNG));
  assert.equal(photoshare.pathFor(name), path.join(photoshare.DIR, name));
  for (const nope of ["", "..", "../config.json", "sub/0001-x.jpg", "0001-x.jpg/../../y", "0001-x.exe", "x.jpg"]) {
    assert.equal(photoshare.pathFor(nope), "", nope);
  }
  // A file dropped into the directory by something else is not one of ours either:
  // the pattern is the whole guard.
  fs.writeFileSync(path.join(photoshare.DIR, "stray.jpg"), PNG);
  assert.equal(photoshare.pathFor("stray.jpg"), "");
});

test("a name the session could not find again is refused rather than written", () => {
  // The numbering is four digits wide, so a prefix that ran past it would build a
  // name list()/clear()/pathFor() all skip - a photo on the box that nothing can
  // show and nothing will ever delete. Unreachable through the item cap today,
  // which is exactly why it is checked rather than reasoned about.
  fs.mkdirSync(photoshare.DIR, { recursive: true });
  fs.writeFileSync(path.join(photoshare.DIR, "9999-last.jpg"), PNG);
  const before = fs.readdirSync(photoshare.DIR).sort();
  assert.throws(() => photoshare.save("one-more.jpg", b64(PNG)), /failed/);
  assert.deepEqual(fs.readdirSync(photoshare.DIR).sort(), before, "and nothing was written");
});

test("the session is capped", () => {
  // Not to ration an ordinary use - it is a thousand photos' worth of headroom -
  // but so that a runaway upload cannot fill the boot medium.
  assert.ok(photoshare.MAX_ITEMS > 0 && photoshare.MAX_BYTES > 0);
  const dir = photoshare.DIR;
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= photoshare.MAX_ITEMS; i++) {
    fs.writeFileSync(path.join(dir, String(i).padStart(4, "0") + "-x.jpg"), PNG);
  }
  assert.throws(() => photoshare.save("one-too-many.jpg", b64(PNG)), /full/);
});

test("boot clears whatever a switched-off TV left behind", () => {
  photoshare.save("last-night.jpg", b64(PNG));
  assert.equal(photoshare.sweep(), 1);
  assert.deepEqual(photoshare.list(), []);
  assert.equal(photoshare.sweep(), 0, "and says nothing when there is nothing");
});

test("nothing throws when the directory is not there", () => {
  fs.rmSync(photoshare.DIR, { recursive: true, force: true });
  assert.deepEqual(photoshare.list(), []);
  assert.equal(photoshare.clear(), 0);
  assert.equal(photoshare.pathFor("0001-x.jpg"), path.join(photoshare.DIR, "0001-x.jpg"));
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
