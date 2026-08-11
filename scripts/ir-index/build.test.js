// The parts of the build that decide what the box can ADDRESS. A slug is not cosmetic:
// it is the filename the index publishes and the path a box fetches, and the box refuses
// one that breaks its own rule - silently, from a user's point of view, because the brand
// simply is not in the list any more.
// Run: node --test scripts/ir-index/build.test.js
const test = require("node:test");
const assert = require("node:assert");
const { brandKey, slugOf, validSlug } = require("./build");

test("two spellings of a brand are one brand", () => {
  assert.equal(brandKey("Sound United"), brandKey("sound-united"));
  assert.equal(brandKey("LG"), brandKey("l.g."));
  assert.notEqual(brandKey("LG"), brandKey("LGE"));
  assert.equal(slugOf("Sound United"), slugOf("sound united"), "so both spellings address one file");
});

test("every slug passes the rule the box applies to it", () => {
  const names = [
    "LG",
    "Samsung",
    "Sound United Home Theatre Company Limited", // longer than the slice
    "A".repeat(39) + " B", // the slice would end on the separator
    "x".repeat(60),
    "!!!", // nothing alphanumeric survives
    "Ω brand", // nor anything ASCII in the first character
    "-leading-and-trailing-",
    " ",
  ];
  for (const n of names) {
    const slug = slugOf(n);
    assert.ok(validSlug(slug), `${JSON.stringify(n)} -> ${slug}`);
    assert.ok(!slug.includes("--"), slug);
    assert.ok(slug.length <= 46, slug + " is " + slug.length + " characters");
  }
});

test("a slug still says which brand it is, and stays unique", () => {
  assert.match(slugOf("Panasonic"), /^panasonic-[0-9a-f]{6}$/);
  // Two brands whose names collapse to the same prefix are still different files.
  const a = slugOf("A".repeat(40) + " one");
  const b = slugOf("A".repeat(40) + " two");
  assert.notEqual(a, b);
  assert.equal(a.slice(0, 32), b.slice(0, 32), "the prefix is the same, the hash is not");
});
