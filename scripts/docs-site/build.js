#!/usr/bin/env node
// Render docs/ into a static site for GitHub Pages.
//
//   node scripts/docs-site/build.js --docs docs --out docs-site [--repo <url>] [--ref <branch>]
//
// Published by .github/workflows/demo.yml under https://andy1210.github.io/tvbox/docs/,
// beside the launcher demo, the tvbox.conf generator and the TV-code index. The
// docs are also perfectly readable in the repo - what this adds is a place to
// send an app author that is not a git checkout, with the pages cross-linked and
// searchable by the browser.
//
// Three link classes, because a doc links to all three and only one of them
// exists on the site: another doc (rewritten .md -> .html), an asset the site
// copies (left relative), and anything else in the repo - a source file, the
// root README, a patch - which becomes a GitHub blob URL. A relative link that
// silently 404s is the failure mode this exists to avoid, so an unknown target
// is resolved to the repository rather than left to break.
const fs = require("fs");
const path = require("path");
const { Marked } = require("marked");

const DEFAULT_REPO = "https://github.com/Andy1210/tvbox";
const DEFAULT_REF = "main";

// The sidebar, in the order the docs' own index reads. A page not listed here
// still ships - it lands under "More" and the build says so - because a missing
// nav entry must not be the reason a doc is unpublished. The unit test asserts
// the shipped tree leaves that group empty, so drift is caught in CI instead.
const NAV = [
  { title: "Start here", files: ["README.md"] },
  {
    title: "Writing an app",
    files: ["app-api.md", "app-manifest.md", "capabilities.md", "native-apps.md", "background-apps.md"],
  },
  {
    title: "Setting a box up",
    files: ["sd-image.md", "updates-and-backup.md", "diagnostics.md", "fleet-view.md"],
  },
  {
    title: "Living with it",
    files: [
      "local-media.md",
      "file-server.md",
      "app-sharing.md",
      "app-store-sources.md",
      "spotify-setup.md",
      "gamepad.md",
      "voice-satellite.md",
      "screen-mirroring.md",
      "ir-blaster.md",
      "firetv-remote-ir.md",
      "mqtt-integration.md",
      "homeassistant-integration.md",
    ],
  },
  { title: "History", files: ["upstream-wlroots.md"] },
];

// A sidebar label that is not the page's own `# heading`. Only where the heading
// is a sentence rather than a name: app-manifest.md opens "Writing an app", which
// beside "The app API" reads as the page an author should start with, and it is
// the field reference.
const LABELS = { "README.md": "Overview", "app-manifest.md": "The manifest" };

// Copied verbatim, so a doc that points at one keeps a relative link that works.
// Everything else under docs/ (config/, upstream/patches/) is published elsewhere
// or belongs in the repo, and is linked there.
const ASSET_PATHS = ["screenshots", "app-manifest.schema.json"];

function usage(msg) {
  console.error(`${msg}\nusage: build.js --docs <dir> --out <dir> [--repo <url>] [--ref <branch>]`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { docs: "docs", out: "docs-site", repo: DEFAULT_REPO, ref: DEFAULT_REF };
  for (let i = 2; i < argv.length; i++) {
    const [flag, inline] = splitFlag(argv[i]);
    const key = flag.replace(/^--/, "");
    if (!Object.prototype.hasOwnProperty.call(out, key)) usage(`unknown arg: ${argv[i]}`);
    const v = inline !== null ? inline : argv[++i];
    if (!v || v.startsWith("--")) usage(`${flag} needs a value`);
    out[key] = v;
  }
  return out;
}

function splitFlag(a) {
  const eq = a.indexOf("=");
  return eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, null];
}

// GitHub's heading anchors, because the docs' own tables of contents are written
// for them: lowercase, drop everything that is not a letter, digit, underscore,
// hyphen or space, then spaces to hyphens. Unicode-aware on purpose - \w is
// ASCII, and it would strip the accents out of a Hungarian heading.
function slug(text, seen) {
  const base = String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .replace(/ /g, "-");
  const n = seen.get(base) || 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** The docs page a .md file becomes, or null for anything that is not one of ours. */
function pageFor(mdName) {
  if (mdName === "README.md") return "index.html";
  return mdName.replace(/\.md$/, ".html");
}

/**
 * Where a link in `fromFile` should point on the site.
 *
 * `fromFile` is relative to the docs root, so a link is resolved against its own
 * directory - the docs are flat today, but a nested page's `../` must not silently
 * resolve against the root and land somewhere plausible and wrong.
 */
function rewriteHref(href, fromFile, opts) {
  const raw = String(href || "");
  // Absolute, protocol-relative, in-page, or a mail/other scheme: not ours.
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(raw)) return raw;
  const hash = raw.indexOf("#");
  const target = hash >= 0 ? raw.slice(0, hash) : raw;
  const frag = hash >= 0 ? raw.slice(hash) : "";
  if (!target) return raw; // a bare "#anchor" was caught above; "" is nothing to do
  // Resolved relative to the linking file, then judged against the docs root.
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  if (rel.startsWith("../")) return blobUrl(path.posix.normalize(path.posix.join(opts.docsDir, rel)), frag, opts);
  if (rel.endsWith(".md")) {
    const page = opts.pages.has(rel) ? pageFor(rel) : null;
    // A .md we do not publish is still a real file in the repo - send the reader
    // there rather than to a page that does not exist.
    return page ? page + frag : blobUrl(path.posix.join(opts.docsDir, rel), frag, opts);
  }
  if (isAsset(rel)) return rel + frag;
  return blobUrl(path.posix.join(opts.docsDir, rel), frag, opts);
}

function isAsset(rel) {
  return ASSET_PATHS.some((a) => rel === a || rel.startsWith(a + "/"));
}

function blobUrl(repoPath, frag, opts) {
  const clean = repoPath.replace(/^\.\//, "");
  return `${opts.repo}/blob/${opts.ref}/${clean}${frag}`;
}

/** A marked instance whose links, images and headings are ours. */
function renderer(fromFile, opts) {
  const seen = new Map();
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      link(token) {
        const href = rewriteHref(token.href, fromFile, opts);
        const inner = this.parser.parseInline(token.tokens);
        const title = token.title ? ` title="${esc(token.title)}"` : "";
        // A link that left the site opens where a reader expects it to.
        const ext = /^https?:/i.test(href) ? ' rel="noopener"' : "";
        return `<a href="${esc(href)}"${title}${ext}>${inner}</a>`;
      },
      image(token) {
        const href = rewriteHref(token.href, fromFile, opts);
        const title = token.title ? ` title="${esc(token.title)}"` : "";
        return `<img src="${esc(href)}" alt="${esc(token.text || "")}"${title} loading="lazy">`;
      },
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        const id = slug(token.text, seen);
        // The anchor is the heading itself: a reader copying a link to a section
        // should not have to find a separate ¶ to click.
        return `<h${token.depth} id="${esc(id)}"><a class="anchor" href="#${esc(id)}">${inner}</a></h${token.depth}>\n`;
      },
      table(token) {
        // Wide tables are the norm here (the manifest and API references are all
        // table), and a page that scrolls sideways is unreadable. Scroll the table.
        const html = md.Renderer.prototype.table.call(this, token);
        return `<div class="tablewrap">${html}</div>`;
      },
    },
  });
  return md;
}

const CSS = `
:root{--bg:#0e1116;--card:#161b22;--line:#2a313c;--fg:#e6edf3;--dim:#9aa7b4;--accent:#39c0d6;--accent-fg:#04222a;--warn:#e0b64a}
*{box-sizing:border-box}
html{scroll-padding-top:1rem}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.layout{display:flex;align-items:flex-start;max-width:1400px;margin:0 auto}
nav.side{position:sticky;top:0;flex:0 0 17rem;max-height:100vh;overflow-y:auto;padding:1.5rem 1rem 3rem;border-right:1px solid var(--line)}
nav.side .brand{display:block;font-weight:700;font-size:1.15rem;color:var(--fg);text-decoration:none;letter-spacing:.02em}
nav.side .brand span{color:var(--accent)}
nav.side .tag{color:var(--dim);font-size:.8rem;margin:.15rem 0 1.25rem}
nav.side h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin:1.4rem 0 .4rem}
nav.side ul{list-style:none;margin:0;padding:0}
nav.side li{margin:.1rem 0}
nav.side a.doc{display:block;padding:.3rem .55rem;border-radius:6px;color:var(--fg);text-decoration:none;font-size:.92rem}
nav.side a.doc:hover{background:var(--card)}
nav.side a.doc[aria-current=page]{background:var(--accent);color:var(--accent-fg);font-weight:600}
nav.side .out{margin-top:1.8rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.85rem}
nav.side .out a{display:block;padding:.2rem 0;color:var(--dim);text-decoration:none}
nav.side .out a:hover{color:var(--accent)}
main{flex:1 1 auto;min-width:0;padding:2.5rem 2.5rem 6rem;max-width:56rem}
main h1{font-size:2rem;line-height:1.2;margin:0 0 1.2rem}
main h2{font-size:1.4rem;margin:2.4rem 0 .8rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
main h3{font-size:1.12rem;margin:1.9rem 0 .6rem}
main h4{font-size:1rem;margin:1.5rem 0 .5rem;color:var(--dim)}
main h1 .anchor,main h2 .anchor,main h3 .anchor,main h4 .anchor,main h5 .anchor,main h6 .anchor{color:inherit;text-decoration:none}
main h1 .anchor:hover,main h2 .anchor:hover,main h3 .anchor:hover,main h4 .anchor:hover{color:var(--accent)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:var(--card);border:1px solid var(--line);border-radius:5px;padding:.08em .34em}
pre{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:.9rem 1rem;overflow-x:auto}
pre code{background:none;border:0;padding:0;font-size:.85rem;line-height:1.55}
blockquote{margin:1.2rem 0;padding:.2rem 1rem;border-left:3px solid var(--warn);color:var(--dim)}
blockquote strong{color:var(--fg)}
.tablewrap{overflow-x:auto;margin:1.2rem 0;border:1px solid var(--line);border-radius:9px}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;vertical-align:top;padding:.55rem .7rem;border-bottom:1px solid var(--line)}
th{background:var(--card);white-space:nowrap;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
tr:last-child td{border-bottom:0}
img{max-width:100%;border-radius:8px}
hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}
ul,ol{padding-left:1.4rem}
li{margin:.25rem 0}
li input[type=checkbox]{margin-right:.4rem}
@media (max-width:900px){
  .layout{display:block}
  nav.side{position:static;max-height:none;flex:none;border-right:0;border-bottom:1px solid var(--line)}
  main{padding:1.5rem 1.1rem 4rem}
}
`;

function navHtml(groups, current) {
  const parts = [
    `<a class="brand" href="index.html">tvbox <span>docs</span></a>`,
    `<div class="tag">A Raspberry&nbsp;Pi&nbsp;5 as the box under the television.</div>`,
  ];
  for (const g of groups) {
    if (!g.entries.length) continue;
    parts.push(`<h2>${esc(g.title)}</h2><ul>`);
    for (const e of g.entries) {
      const cur = e.page === current ? ' aria-current="page"' : "";
      parts.push(`<li><a class="doc" href="${esc(e.page)}"${cur}>${esc(e.title)}</a></li>`);
    }
    parts.push(`</ul>`);
  }
  parts.push(
    `<div class="out">`,
    `<a href="../" rel="noopener">Launcher demo</a>`,
    `<a href="../config/" rel="noopener">tvbox.conf generator</a>`,
    `<a href="https://github.com/Andy1210/tvbox-apps/blob/main/AUTHORING.md" rel="noopener">App authoring guide</a>`,
    `<a href="https://github.com/Andy1210/tvbox" rel="noopener">Source on GitHub</a>`,
    `</div>`,
  );
  return parts.join("\n");
}

function page({ title, body, nav, editUrl }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)} - tvbox docs</title>
    <style>${CSS}</style>
  </head>
  <body>
    <div class="layout">
      <nav class="side">${nav}</nav>
      <main>
${body}
        <hr />
        <p style="font-size: 0.85rem; color: var(--dim)">
          <a href="${esc(editUrl)}" rel="noopener">Edit this page on GitHub</a>
        </p>
      </main>
    </div>
  </body>
</html>
`;
}

/** First `# heading` of a markdown file, for the sidebar label. */
function titleOf(md, fallback) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].replace(/[`*_]/g, "") : fallback;
}

function copyTree(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from)) copyTree(path.join(from, e), path.join(to, e));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

/** Build the site. Returns what it wrote, which is what the tests assert on. */
function build(args) {
  const docsRoot = path.resolve(args.docs);
  const outRoot = path.resolve(args.out);
  const mdFiles = fs
    .readdirSync(docsRoot)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (!mdFiles.length) usage(`no markdown found in ${docsRoot}`);

  // Group the files as NAV says, then append whatever is left. Order inside a
  // group is NAV's, so the sidebar reads like a table of contents rather than
  // like a directory listing.
  const listed = new Set(NAV.flatMap((g) => g.files));
  const groups = NAV.map((g) => ({ title: g.title, files: g.files.filter((f) => mdFiles.includes(f)) }));
  const extra = mdFiles.filter((f) => !listed.has(f));
  groups.push({ title: "More", files: extra });

  const opts = {
    repo: args.repo.replace(/\/+$/, ""),
    ref: args.ref,
    docsDir: path.basename(docsRoot),
    pages: new Set(mdFiles),
  };

  const sources = new Map(mdFiles.map((f) => [f, fs.readFileSync(path.join(docsRoot, f), "utf8")]));
  const navGroups = groups.map((g) => ({
    title: g.title,
    entries: g.files.map((f) => ({ page: pageFor(f), title: LABELS[f] || titleOf(sources.get(f), f) })),
  }));

  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });

  const written = [];
  for (const f of mdFiles) {
    const out = pageFor(f);
    const body = renderer(f, opts).parse(sources.get(f));
    fs.writeFileSync(
      path.join(outRoot, out),
      page({
        title: titleOf(sources.get(f), f),
        body,
        nav: navHtml(navGroups, out),
        editUrl: `${opts.repo}/blob/${opts.ref}/${opts.docsDir}/${f}`,
      }),
    );
    written.push(out);
  }
  for (const a of ASSET_PATHS) {
    const from = path.join(docsRoot, a);
    if (fs.existsSync(from)) {
      copyTree(from, path.join(outRoot, a));
      written.push(a);
    }
  }
  return { written, unlisted: extra, out: outRoot };
}

module.exports = { build, rewriteHref, slug, pageFor, NAV, LABELS, ASSET_PATHS };

if (require.main === module) {
  const args = parseArgs(process.argv);
  const r = build(args);
  if (r.unlisted.length) {
    console.log(`[docs-site] not in the sidebar's groups, filed under "More": ${r.unlisted.join(", ")}`);
  }
  console.log(`[docs-site] wrote ${r.written.length} entries to ${r.out}`);
}
