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
  const o = req && req.headers && req.headers.origin;
  return !!o && !origins.has(String(o).toLowerCase());
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
function matchPluginRoute(routes, method, pathname) {
  for (const { prefix, table } of routes) {
    if (!pathname.startsWith(prefix)) continue;
    const sub = pathname.slice(prefix.length);
    if (sub && sub[0] !== "/") continue; // don't let "/spotify" match "/spotifyX"
    const fn = table[method + " " + sub];
    if (fn) return fn;
  }
  return null;
}

module.exports = { MIME, jsonRes, serveStatic, ownOrigins, foreignOrigin, originOf, matchPluginRoute };
