// Unit tests for the docs site generator. Run: node --test scripts/docs-site/*.test.js
//
// The one that matters is the last block: it builds the REAL docs/ tree and
// resolves every internal link and every in-page anchor in the output. A doc's
// table of contents is hand-written against GitHub's heading anchors, so a change
// to the slug rule - or a renamed heading - breaks navigation with no error
// anywhere, on a site nobody diffs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build, rewriteHref, slug, pageFor, NAV, LABELS } = require("./build");

const REPO_ROOT = path.join(__dirname, "..", "..");
const OPTS = {
  repo: "https://github.com/Andy1210/tvbox",
  ref: "main",
  docsDir: "docs",
  pages: new Set(["README.md", "app-api.md", "capabilities.md", "nested/deep.md"]),
};

test("slug matches the GitHub anchors the docs' own tables of contents use", () => {
  const seen = new Map();
  assert.equal(slug("The app API", seen), "the-app-api");
  assert.equal(slug("The SDK: `@tvbox/app-sdk`".replace(/`/g, ""), seen), "the-sdk-tvboxapp-sdk");
  assert.equal(slug("`window.tvbox` reference".replace(/`/g, ""), seen), "windowtvbox-reference");
  assert.equal(slug("fetch - the data proxy", seen), "fetch---the-data-proxy");
  assert.equal(slug("storage - per-app key/value", seen), "storage---per-app-keyvalue");
  assert.equal(
    slug("Feature detection, and why it is not optional", seen),
    "feature-detection-and-why-it-is-not-optional",
  );
});

test("slug keeps accented letters - \\w would strip a Hungarian heading to nothing", () => {
  assert.equal(slug("Élő TV beállítása", new Map()), "élő-tv-beállítása");
});

test("a repeated heading gets a suffix rather than a colliding id", () => {
  const seen = new Map();
  assert.equal(slug("Rules", seen), "rules");
  assert.equal(slug("Rules", seen), "rules-1");
  assert.equal(slug("Rules", seen), "rules-2");
});

test("README is the site's index, every other doc keeps its name", () => {
  assert.equal(pageFor("README.md"), "index.html");
  assert.equal(pageFor("app-api.md"), "app-api.html");
});

test("a link to another doc becomes its page, and keeps the fragment", () => {
  assert.equal(rewriteHref("capabilities.md", "app-api.md", OPTS), "capabilities.html");
  assert.equal(rewriteHref("app-api.md#the-screensaver", "capabilities.md", OPTS), "app-api.html#the-screensaver");
  assert.equal(rewriteHref("README.md", "app-api.md", OPTS), "index.html");
});

test("a .md this site does not publish goes to the repo, not to a 404", () => {
  assert.equal(
    rewriteHref("not-published.md", "app-api.md", OPTS),
    "https://github.com/Andy1210/tvbox/blob/main/docs/not-published.md",
  );
});

test("a link out of docs/ becomes a GitHub blob URL at the resolved path", () => {
  assert.equal(
    rewriteHref("../shell/appfetch.js", "app-api.md", OPTS),
    "https://github.com/Andy1210/tvbox/blob/main/shell/appfetch.js",
  );
  assert.equal(
    rewriteHref("../README.md", "app-api.md", OPTS),
    "https://github.com/Andy1210/tvbox/blob/main/README.md",
  );
  // Inside docs/ but not copied to the site: published elsewhere or repo-only.
  assert.equal(
    rewriteHref("upstream/patches/0001.patch", "upstream-wlroots.md", OPTS),
    "https://github.com/Andy1210/tvbox/blob/main/docs/upstream/patches/0001.patch",
  );
});

test("a copied asset keeps a relative link", () => {
  assert.equal(rewriteHref("screenshots/home.png", "README.md", OPTS), "screenshots/home.png");
  assert.equal(rewriteHref("app-manifest.schema.json", "app-manifest.md", OPTS), "app-manifest.schema.json");
});

test("a link is resolved against the LINKING file's directory, not the docs root", () => {
  // The docs are flat today; a nested page's ../ must not resolve as if it were.
  assert.equal(rewriteHref("../capabilities.md", "nested/deep.md", OPTS), "capabilities.html");
  assert.equal(
    rewriteHref("../../shell/main.js", "nested/deep.md", OPTS),
    "https://github.com/Andy1210/tvbox/blob/main/shell/main.js",
  );
});

test("what is not ours is left exactly as written", () => {
  for (const href of [
    "https://github.com/Andy1210/tvbox-apps",
    "http://192.168.1.10:8790/index.json",
    "//example.com/x",
    "mailto:someone@example.com",
    "#a-section-of-this-page",
    "/absolute",
  ]) {
    assert.equal(rewriteHref(href, "app-api.md", OPTS), href);
  }
});

test("the real docs/ tree builds, and every internal link in it resolves", (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-docs-site-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const r = build({ docs: path.join(REPO_ROOT, "docs"), out, repo: OPTS.repo, ref: OPTS.ref });

  // Every doc got a page, and the index is the docs README.
  const mds = fs
    .readdirSync(path.join(REPO_ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort();
  assert.ok(mds.length >= 20, `expected the docs tree, found ${mds.length} files`);
  for (const f of mds) assert.ok(fs.existsSync(path.join(out, pageFor(f))), `no page for ${f}`);
  assert.ok(fs.existsSync(path.join(out, "index.html")));
  assert.ok(fs.existsSync(path.join(out, "screenshots", "home.png")), "screenshots were not copied");
  assert.ok(fs.existsSync(path.join(out, "app-manifest.schema.json")), "the schema was not copied");

  // A new doc still ships, but it must be placed in the sidebar deliberately.
  assert.deepEqual(r.unlisted, [], "these docs are not in any NAV group");

  // The app API page is the one this site exists for; if it is missing from the
  // sidebar the site is a directory listing.
  assert.ok(
    NAV.some((g) => g.files.includes("app-api.md")),
    "app-api.md is not in the sidebar",
  );

  // A label override that names no page would silently do nothing.
  for (const f of Object.keys(LABELS)) assert.ok(mds.includes(f), `LABELS names ${f}, which is not a doc`);
  const index = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.match(index, />The manifest</, "the app-manifest label override did not reach the sidebar");
  assert.match(index, />The app API</, "the API page is not in the sidebar");

  const pages = new Set(fs.readdirSync(out));
  const idsOf = new Map();
  const html = new Map();
  for (const f of pages) {
    if (!f.endsWith(".html")) continue;
    const h = fs.readFileSync(path.join(out, f), "utf8");
    html.set(f, h);
    idsOf.set(f, new Set([...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1])));
  }

  let checked = 0;
  const broken = [];
  for (const [f, h] of html) {
    for (const m of h.matchAll(/href="([^"]+)"/g)) {
      const href = m[1];
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue; // off-site
      const [target, frag] = splitHash(href);
      const file = target === "" ? f : target;
      if (target && !target.endsWith(".html")) continue; // ../ , ../config/ - not files here
      checked++;
      if (!pages.has(file)) broken.push(`${f} -> ${href} (no such page)`);
      else if (frag && !idsOf.get(file).has(frag)) broken.push(`${f} -> ${href} (no such anchor)`);
    }
  }
  assert.deepEqual(broken, [], `broken internal links:\n${broken.join("\n")}`);
  assert.ok(checked > 200, `expected the docs' cross-links, only checked ${checked}`);
});

function splitHash(href) {
  const i = href.indexOf("#");
  return i < 0 ? [href, ""] : [href.slice(0, i), decodeURIComponent(href.slice(i + 1))];
}
