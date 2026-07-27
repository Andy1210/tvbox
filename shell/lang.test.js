const test = require("node:test");
const assert = require("node:assert");
const lang = require("./lang");

test("a launcher locale id becomes a market tag", () => {
  assert.strictEqual(lang.resolve("hu", "en-GB").tag, "hu-HU");
  assert.strictEqual(lang.resolve("en", "en-GB").tag, "en-GB");
});

test("the system locale wins the region guess for the same language", () => {
  // A box set to en_US must not be told en-GB just because that's our default.
  assert.strictEqual(lang.resolve("en", "en-US").tag, "en-US");
  // …but a different language ignores it.
  assert.strictEqual(lang.resolve("hu", "en-US").tag, "hu-HU");
});

test("an already-complete tag passes through", () => {
  assert.strictEqual(lang.resolve("pt-BR", "en-GB").tag, "pt-BR");
});

test("an unknown locale keeps its language instead of guessing a region", () => {
  assert.strictEqual(lang.resolve("sv", "en-GB").tag, "sv");
});

test("nothing sensible in, system locale out - and the system locale is validated", () => {
  assert.strictEqual(lang.resolve("", "en-GB").tag, "en-GB");
  assert.strictEqual(lang.resolve(null, "hu-HU").tag, "hu-HU");
  // Chromium can report a locale that is not a BCP-47 tag; passing it through would
  // put junk in Accept-Language, in navigator.language (Intl throws) and in a URL.
  assert.strictEqual(lang.resolve("", "C").tag, "en-GB");
  assert.strictEqual(lang.resolve("", "en_US").tag, "en-US");
  assert.strictEqual(lang.resolve("", "").tag, "en-GB");
});

test("Accept-Language falls back through the bare language to English", () => {
  assert.strictEqual(lang.resolve("hu", "en-GB").accept, "hu-HU,hu;q=0.9,en;q=0.8");
  // An English UI needs no "en" fallback appended twice.
  assert.strictEqual(lang.resolve("en", "en-GB").accept, "en-GB,en;q=0.9");
});

test("a manifest can pin an app's language, and system means follow the box", () => {
  assert.strictEqual(lang.resolve("hu", "en-GB", "en-US").tag, "en-US");
  assert.strictEqual(lang.resolve("hu", "en-GB", "system").tag, "hu-HU");
  assert.strictEqual(lang.resolve("hu", "en-GB", "").tag, "hu-HU");
});

test("placeholders let a manifest follow the language without pinning one", () => {
  assert.strictEqual(lang.expand("https://www.xbox.com/{locale}/play", "hu-HU"), "https://www.xbox.com/hu-HU/play");
  assert.strictEqual(lang.expand("{locale_lower}", "hu-HU"), "hu-hu");
  assert.strictEqual(lang.expand("{lang}", "hu-HU"), "hu");
  // A template with no placeholder, and a tag with no region, both pass through sanely.
  assert.strictEqual(lang.expand("https://x/play", "hu-HU"), "https://x/play");
  assert.strictEqual(lang.expand("{locale}/{lang}", "sv"), "sv/sv");
  assert.strictEqual(lang.expand(null, "hu-HU"), "");
});
