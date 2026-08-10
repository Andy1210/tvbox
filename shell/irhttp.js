// The one outbound path the TV-code index is fetched over (shell/irindex.js): a
// size-capped https GET, and where an index or brand answer is cached.
//
// A Location header is the one part of a response the server chooses freely, so a
// redirect may only stay on the host that was asked or move inside GitHub - the
// index is published on GitHub Pages, and what it answers decides what gets written
// onto a remote.
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const CACHE_DIR = path.join(os.homedir(), ".tvbox", "cache");
const ALLOWED_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"]);

// The callback fires EXACTLY once. Destroying the request on the size cap raises an
// `error` right after, and a caller that keeps a counter in this callback (a brand
// downloader's concurrency) would then double-count it and either finish early or
// never finish at all.
function httpsGet(url, maxBytes, cb, redirected) {
  let done = false;
  const once = (err, body) => {
    if (done) return;
    done = true;
    cb(err, body);
  };
  const req = https.get(url, { headers: { "User-Agent": "tvbox", Accept: "*/*" }, timeout: 30000 }, (res) => {
    if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && !redirected) {
      res.resume();
      let next;
      try {
        next = new URL(res.headers.location, url);
      } catch (e) {
        return once(new Error("bad redirect"));
      }
      let from = "";
      try {
        from = new URL(url).hostname;
      } catch (e) {}
      if (next.protocol !== "https:" || !(next.hostname === from || ALLOWED_HOSTS.has(next.hostname))) {
        return once(new Error("redirect off the host asked: " + next.hostname));
      }
      done = true; // the retry owns the callback from here
      return httpsGet(next.href, maxBytes, cb, true);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return once(new Error("HTTP " + res.statusCode + (res.statusCode === 403 ? " (rate limited? retry later)" : "")));
    }
    const chunks = [];
    let size = 0;
    res.on("data", (d) => {
      size += d.length;
      if (size > maxBytes) {
        req.destroy();
        return once(new Error("response too large"));
      }
      chunks.push(d);
    });
    res.on("end", () => once(null, Buffer.concat(chunks).toString("utf8")));
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => once(e));
}

// Cache writes never fail loudly: a box with a full or read-only ~/.tvbox still has
// to be able to browse codes, it just pays the download again.
function writeCache(file, value) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch (e) {}
}

module.exports = { CACHE_DIR, ALLOWED_HOSTS, httpsGet, writeCache };
