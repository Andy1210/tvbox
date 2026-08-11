// The one outbound path the TV-code index is fetched over (shell/irindex.js), and where
// its answers are cached.
//
// The request goes through netguard's `guardedFetch`, like every other non-broker fetch
// on this box: it re-validates EVERY redirect hop rather than only the first, and an
// https chain can never be redirected down onto http (the box's own control API and the
// metadata service both live there). On top of that this one is ORIGIN-PINNED - the
// index and every brand file sit under one base URL, so a hop to another host is never
// legitimate, whoever configured that base.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { guardedFetch } = require("./netguard");

const CACHE_DIR = path.join(os.homedir(), ".tvbox", "cache");
const TIMEOUT_MS = 30000;

// The cap is the point, so the body is counted as it arrives: a "brand file" that turns
// out to be a gigabyte must not be buffered to find that out. `content-length` is only a
// first refusal - the server chooses both it and what it then sends.
async function readCapped(res, maxBytes) {
  const claimed = Number(res.headers.get("content-length"));
  if (Number.isFinite(claimed) && claimed > maxBytes) throw new Error("response too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// cb(err, text), exactly once.
function fetchText(url, maxBytes, cb) {
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch (e) {
    return process.nextTick(() => cb(new Error("bad url")));
  }
  const sameOrigin = (u) => {
    try {
      return new URL(u).origin === origin;
    } catch (e) {
      return false;
    }
  };
  guardedFetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": "tvbox", Accept: "application/json" },
    allow: sameOrigin,
  }).then(
    async (res) => {
      if (!res.ok) {
        if (res.body) await res.body.cancel().catch(() => {});
        return cb(new Error("HTTP " + res.status));
      }
      try {
        cb(null, await readCapped(res, maxBytes));
      } catch (e) {
        cb(e);
      }
    },
    (e) => cb(e),
  );
}

// Cache writes never fail loudly: a box with a full or read-only ~/.tvbox still has
// to be able to browse codes, it just pays the download again.
function writeCache(file, value) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch (e) {}
}

// A cache file is a copy of an answer off the internet sitting in a writable
// directory, so it is read under the same cap the fetch had and its contents are
// checked by the caller exactly as a fresh answer is. `null` for anything unusable.
function readCache(file, maxBytes) {
  try {
    if (fs.statSync(file).size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

module.exports = { CACHE_DIR, fetchText, writeCache, readCache };
