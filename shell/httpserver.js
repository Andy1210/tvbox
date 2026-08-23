// The HTTP transport under the box's API: what a response looks like, what a file
// request is allowed to reach, and which requests are refused before a route ever
// sees them.
//
// The routes themselves stay in main.js, because that is where the box's state is.
// What lives here is everything a route should not have to think about, and two of
// those decisions are security decisions: a static path must not escape its root,
// and a state-changing request must come from one of our own pages.
const fs = require("fs");
const path = require("path");

const MIME = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".map": "application/json",
};

function jsonRes(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Serve a file from under `root`, or the SPA's index for a path that is not one.
//
// The boundary is root + separator rather than a startsWith on root alone
// (`/apps/plexi` starts with `/apps/plex` and is a different app's directory), and
// it is checked on the resolved path - see underRoot.
function serveStatic(res, root, p, spaFallback) {
  const fp = path.join(root, p);
  if (underRoot(root, fp) && isFile(fp)) {
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    // A read that fails halfway (the file went away, an I/O error, a permission
    // change) emits `error` on the stream, and an unhandled one takes the whole
    // shell down with it. The headers are already out by then, so the only thing
    // left to do is end the response.
    const stream = fs.createReadStream(fp);
    stream.on("error", (e) => {
      console.warn("[http] read failed:", fp, e.message);
      try {
        res.end();
      } catch (e2) {}
    });
    stream.pipe(res);
  } else if (spaFallback && isFile(spaFallback)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    try {
      res.end(fs.readFileSync(spaFallback));
    } catch (e) {
      res.end();
    }
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

// Is `fp` inside `root`, following symlinks?
//
// The string comparison alone answers for the path the request asked for, not for
// the file it lands on. An app's `web/` comes out of a tarball nobody here wrote
// (install.js extracts a flatpak's files), so a link named `web/logo.png` pointing
// at `~/.tvbox/config.json` would pass the prefix test and be served - with the
// IPTV password and the parental PIN hash in it - to any page on our origin.
// Resolving both sides is what makes the boundary the real file's.
function underRoot(root, fp) {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(fp);
    const base = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    return real === realRoot || real.startsWith(base);
  } catch (e) {
    return false; // a path that does not resolve is not inside anything
  }
}

// One question, one syscall, and never a throw: existsSync followed by statSync
// asks twice and the answer can change in between - a file removed at that moment
// used to take the shell down rather than 404.
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

// Is this request from somewhere that is not one of our own pages? Two signals,
// because neither covers the other: `Origin` (sent on every cross-origin POST, and
// on a cross-origin fetch) and `Sec-Fetch-Site` (sent on everything Chromium asks
// for, including the <img> and <iframe> loads that carry no Origin at all).
//
// Origins allowed to issue state-changing requests: only our own pages (the
// launcher and local app bundles are all served by this same server, loaded via
// BASE=localhost). Browsers attach an Origin header to every cross-origin POST, so
// a foreign Origin here is some LAN page - e.g. a plain-http remote app - blind
// firing at the control API through the TV's own renderer. Requests WITHOUT an
// Origin (curl, the CEC bridge, the tvbox CLI, the shell's own Node code) are local
// tools, not browsers - they stay allowed; the server only listens on 127.0.0.1
// anyway.
function ownOrigins(port) {
  return new Set(["http://127.0.0.1:" + port, "http://localhost:" + port]);
}

function foreignOrigin(req, origins) {
  const h = (req && req.headers) || {};
  const o = h.origin;
  if (o && !origins.has(String(o).toLowerCase())) return true;
  // `Origin` is not sent for a cross-origin GET the browser makes on a page's
  // behalf - measured: an <img>, an <iframe> and a no-cors fetch to another origin
  // all arrive with no Origin at all. So the header cannot see the one case the
  // guarded-GET list exists for: a remote page in an app window firing at a read
  // that COSTS something. Chromium sends `Sec-Fetch-Site` on all three, and this
  // box has one browser.
  //
  // Measured against a real Chromium, because the answer is not what it looks
  // like: a "site" is registrable domain plus scheme and does NOT include the
  // port, so a page on another loopback PORT (our own pairing server) reports
  // `same-site`, while a page on a remote domain reports `cross-site`. That is the
  // split this box wants - everything on loopback is ours - but it means this is
  // not a defence against a hostile local port, and never was.
  //
  // Only an explicit `cross-site` is refused. `none` is a user-initiated
  // navigation - somebody typing the URL - and an ABSENT header is a non-browser
  // (curl, the CEC bridge, the tvbox CLI), which is the same tool class this
  // function has always let through.
  return String(h["sec-fetch-site"] || "").toLowerCase() === "cross-site";
}

// A URL's origin, for logging a refusal without echoing the whole thing back.
function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch (e) {
    return "(unparseable url)";
  }
}

// Match a request against a plugin's registered route table. A plugin declares a
// prefix (e.g. "/tvbox/api/spotify") and a table keyed "METHOD /subpath"; the
// generic server tries these before its own built-in routes.
//
// Returns the whole entry rather than just the handler, because the SAME
// resolution has to answer two questions - which handler runs, and whether this
// route is one the same-origin gate applies to. Asking them separately let the
// gate be decided against one route and the request served by another.
function resolvePluginRoute(routes, method, pathname) {
  for (const { prefix, table, guard } of routes) {
    if (!pathname.startsWith(prefix)) continue;
    const sub = pathname.slice(prefix.length);
    if (sub && sub[0] !== "/") continue; // don't let "/spotify" match "/spotifyX"
    const key = method + " " + sub;
    const fn = table[key];
    if (fn) return { fn, guarded: !!(guard && guard.includes(key)) };
  }
  return null;
}

function matchPluginRoute(routes, method, pathname) {
  const hit = resolvePluginRoute(routes, method, pathname);
  return hit ? hit.fn : null;
}

// Does a plugin want the same-origin gate on this GET? Non-GET is already gated
// for everything, so only GET is ever asked. A plugin declares it because only the
// plugin knows which of its reads are expensive: xcloud's wait-time lookup is one
// authenticated request to Microsoft per distinct id, so any page the box loads
// could otherwise drive the household's account through an <img> tag.
function pluginRouteGuarded(routes, method, pathname) {
  const hit = resolvePluginRoute(routes, method, pathname);
  return !!(hit && hit.guarded);
}

module.exports = {
  MIME,
  jsonRes,
  serveStatic,
  ownOrigins,
  foreignOrigin,
  originOf,
  matchPluginRoute,
  pluginRouteGuarded,
};
