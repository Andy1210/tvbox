// tvbox ambient/screensaver data: current weather (open-meteo - free, no key) for
// a configured city, and an optional local photo slideshow. Weather is cached so
// the idle screen can poll cheaply. Photos live in ~/.tvbox/ambient/ (drop jpg/
// png/webp there); none -> the ambient screen falls back to its gradient.
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PHOTO_DIR = path.join(os.homedir(), ".tvbox", "ambient");
const WX_TTL = 15 * 60 * 1000;
let wxCache = { city: null, at: 0, data: null };

function getJson(url, cb) {
  const req = https.get(url, { timeout: 8000, headers: { "User-Agent": "tvbox" } }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return cb(null);
    }
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      try {
        cb(JSON.parse(body));
      } catch (e) {
        cb(null);
      }
    });
  });
  req.on("error", () => cb(null));
  req.on("timeout", () => req.destroy());
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

function photos() {
  try {
    return fs
      .readdirSync(PHOTO_DIR)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort();
  } catch (e) {
    return [];
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
  for (const f of photos()) {
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

module.exports = { weather, photos, savePhoto, clearPhotos, deletePhoto, PHOTO_DIR };
