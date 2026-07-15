// tvbox ambient/screensaver data: current weather (open-meteo - free, no key) for
// a configured city, and an optional local photo slideshow. Weather is cached so
// the idle screen can poll cheaply. Photos live in ~/.tvbox/ambient/ (drop jpg/
// png/webp there); none -> the ambient screen falls back to its gradient.
// Opt-in (config ambient.bing): Bing's daily wallpapers are cached under
// PHOTO_DIR/bing/ and mixed into the photo listing as "bing/<file>" names.
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const config = require("./config"); // rawAmbient().bing gates the Bing wallpaper source

const PHOTO_DIR = path.join(os.homedir(), ".tvbox", "ambient");
const WX_TTL = 15 * 60 * 1000;
let wxCache = { city: null, at: 0, data: null };

// ---- Bing daily wallpapers (opt-in ambient photo source) ----
// Cached inside PHOTO_DIR so the existing /tvbox/api/ambient/photo route serves
// them unchanged: serveStatic path-joins "bing/<file>" under PHOTO_DIR and its
// root-boundary check already blocks traversal. The subdir also keeps the cache
// out of the flat upload listing (readdir's "bing" entry fails the extension
// filter), so uploads and cache never mix.
const BING_DIR = path.join(PHOTO_DIR, "bing");
const BING_STAMP = path.join(BING_DIR, ".last-refresh"); // mtime = last successful refresh
const BING_ARCHIVE = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=en-US";
const BING_KEEP = 10; // newest cached wallpapers to keep
const BING_MAX_BYTES = 5 * 1024 * 1024; // per-image size cap
const BING_TTL = 24 * 60 * 60 * 1000; // refresh at most once per day
const BING_RETRY = 10 * 60 * 1000; // in-memory backoff after a failed attempt
let bingBusy = false;
let bingLastAttempt = 0;

function bingEnabled() {
  try {
    return !!(config.rawAmbient() || {}).bing;
  } catch (e) {
    return false;
  }
}

// Download an https URL to `file`: follows up to 3 redirects, 20s timeout,
// size-capped, writes to a .part temp and renames on success so a torn
// download never appears in the slideshow. cb(ok) - never throws.
function download(url, file, cb, redirects) {
  redirects = redirects === undefined ? 3 : redirects;
  let settled = false;
  const settle = (ok) => {
    if (!settled) {
      settled = true;
      cb(ok);
    }
  };
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return settle(false);
  }
  if (u.protocol !== "https:") return settle(false);
  const req = https.get(u, { timeout: 20000, headers: { "User-Agent": "tvbox" } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
      res.resume();
      let next;
      try {
        next = new URL(res.headers.location, u).toString();
      } catch (e) {
        return settle(false);
      }
      return download(next, file, settle, redirects - 1);
    }
    if (res.statusCode !== 200 || Number(res.headers["content-length"] || 0) > BING_MAX_BYTES) {
      res.resume();
      return settle(false);
    }
    const tmp = file + ".part";
    const out = fs.createWriteStream(tmp);
    let size = 0;
    const fail = () => {
      out.destroy();
      try {
        fs.unlinkSync(tmp);
      } catch (e) {}
      settle(false);
    };
    res.on("data", (c) => {
      size += c.length;
      if (size > BING_MAX_BYTES) {
        req.destroy();
        fail();
      }
    });
    res.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (settled) return;
      try {
        fs.renameSync(tmp, file);
        settle(true);
      } catch (e) {
        fail();
      }
    });
    res.pipe(out);
  });
  req.on("error", () => settle(false));
  req.on("timeout", () => req.destroy());
}

function pruneBing() {
  try {
    const files = fs
      .readdirSync(BING_DIR)
      .filter((f) => /^\d+\.jpg$/.test(f))
      .sort()
      .reverse(); // YYYYMMDD names -> newest first
    for (const f of files.slice(BING_KEEP)) {
      try {
        fs.unlinkSync(path.join(BING_DIR, f));
      } catch (e) {}
    }
  } catch (e) {}
}

// Fetch the daily-image archive and cache new wallpapers (named by their
// startdate). Fire-and-forget: photos() calls this lazily and never waits for
// it, at most one run at a time, at most one refresh per day (stamp file mtime)
// with a short in-memory backoff between failed attempts. Every error path is
// silent - ambient must degrade to whatever is already cached, never break.
function refreshBing() {
  if (!bingEnabled() || bingBusy) return;
  const now = Date.now();
  if (now - bingLastAttempt < BING_RETRY) return;
  let stamp = 0;
  try {
    stamp = fs.statSync(BING_STAMP).mtimeMs;
  } catch (e) {}
  if (now - stamp < BING_TTL) return;
  bingBusy = true;
  bingLastAttempt = now;
  try {
    fs.mkdirSync(BING_DIR, { recursive: true });
  } catch (e) {}
  getJson(BING_ARCHIVE, (j) => {
    const images = (j && j.images) || [];
    if (!images.length) {
      bingBusy = false; // no stamp write -> retried after the backoff window
      return;
    }
    let pending = 0;
    const done = () => {
      // stamp the attempt as complete even if single images failed - the
      // archive itself answered, and tomorrow's refresh fills any gap
      try {
        fs.writeFileSync(BING_STAMP, "");
      } catch (e) {}
      pruneBing();
      bingBusy = false;
    };
    for (const img of images) {
      const id = String(img.startdate || "").replace(/[^0-9]/g, "");
      // images[i].url is the 1920x1080 jpg variant; urlbase is the fallback
      const rel = img.url || (img.urlbase ? img.urlbase + "_1920x1080.jpg" : "");
      if (!id || !rel) continue;
      const file = path.join(BING_DIR, id + ".jpg");
      if (fs.existsSync(file)) continue;
      pending++;
      download("https://www.bing.com" + rel, file, () => {
        if (--pending === 0) done();
      });
    }
    if (!pending) done();
  });
}

function getJson(url, cb) {
  // The callback MUST settle exactly once on every path: a mid-body stall
  // (timeout after headers) emits neither req 'error' nor res 'end', which
  // would wedge every caller that gates on the callback (bingBusy, weather).
  let done = false;
  const fin = (v) => {
    if (done) return;
    done = true;
    cb(v);
  };
  const req = https.get(url, { timeout: 8000, headers: { "User-Agent": "tvbox" } }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return fin(null);
    }
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      try {
        fin(JSON.parse(body));
      } catch (e) {
        fin(null);
      }
    });
    res.on("error", () => fin(null));
  });
  req.on("error", () => fin(null));
  req.on("timeout", () => req.destroy());
  req.on("close", () => fin(null)); // belt: whatever happened, settle
}

// { city, tempC, code } for the configured city (geocoded via open-meteo), or null.
function weather(city, cb) {
  city = String(city || "").trim();
  if (!city) return cb(null);
  if (wxCache.city === city && wxCache.data && Date.now() - wxCache.at < WX_TTL) return cb(wxCache.data);
  getJson("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(city), (geo) => {
    const r = geo && geo.results && geo.results[0];
    if (!r) return cb(null);
    getJson(
      "https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code&latitude=" +
        r.latitude +
        "&longitude=" +
        r.longitude,
      (fc) => {
        const cur = fc && fc.current;
        if (!cur) return cb(null);
        const data = { city: r.name, tempC: Math.round(cur.temperature_2m), code: cur.weather_code };
        wxCache = { city, at: Date.now(), data };
        cb(data);
      },
    );
  });
}

// Uploaded photos only (flat PHOTO_DIR listing; the bing/ subdir entry fails
// the extension filter). This is what clearPhotos/deletePhoto operate on - the
// Bing cache is not user-managed, it prunes itself.
function localPhotos() {
  try {
    return fs
      .readdirSync(PHOTO_DIR)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort();
  } catch (e) {
    return [];
  }
}

// Slideshow listing: uploads plus, when ambient.bing is on, the cached Bing
// wallpapers as "bing/<file>" names (the photo route serves those paths as-is).
// Listing also lazily kicks a background refresh when the daily stamp is stale;
// the response never waits on the network.
function photos() {
  const local = localPhotos();
  if (!bingEnabled()) return local;
  refreshBing();
  try {
    const bing = fs
      .readdirSync(BING_DIR)
      .filter((f) => /^\d+\.jpg$/.test(f))
      .sort()
      .reverse() // newest wallpaper first
      .map((f) => "bing/" + f);
    return local.concat(bing);
  } catch (e) {
    return local;
  }
}

// Save a phone-uploaded photo (base64, optionally a data: URL) into PHOTO_DIR.
// The name is sanitized to a bare basename; a timestamp prefix avoids clashes.
function savePhoto(name, base64) {
  try {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
  } catch (e) {}
  let safe = String(name || "photo")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-60);
  if (!/\.(jpe?g|png|webp)$/i.test(safe)) safe += ".jpg";
  const b = String(base64 || "").replace(/^data:[^,]*,/, "");
  const buf = Buffer.from(b, "base64");
  if (!buf.length) throw new Error("empty photo");
  const file = path.join(PHOTO_DIR, Date.now() + "-" + safe);
  fs.writeFileSync(file, buf);
  return path.basename(file);
}
function clearPhotos() {
  let n = 0;
  for (const f of localPhotos()) {
    try {
      fs.unlinkSync(path.join(PHOTO_DIR, f));
      n++;
    } catch (e) {}
  }
  return n;
}
// Delete one photo by bare filename (path-guarded - no traversal).
function deletePhoto(name) {
  name = String(name || "");
  if (!name || /[/\\]/.test(name) || name.includes("..")) return false;
  const p = path.join(PHOTO_DIR, name);
  if (!p.startsWith(PHOTO_DIR + path.sep)) return false;
  try {
    fs.unlinkSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { weather, photos, localPhotos, savePhoto, clearPhotos, deletePhoto, PHOTO_DIR };
