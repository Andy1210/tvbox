// The now-playing claim an app makes about itself, and how long it is believed.
//
// What arrives on POST /tvbox/api/nowplaying is published retained over MQTT,
// drawn on HOME, read by Home Assistant and used to decide whether the box is
// idle. So it is reduced to the fields those readers use, each bounded, before
// anything keeps it.
const MAX_TEXT = 300;
const MAX_URL = 2048;
const MAX_DATA_URL = 256 * 1024;
const STATES = new Set(["playing", "paused", "idle"]);

// An app-reported "playing" with no window left to correct it is believed this
// long after its last report. A plugin's daemon can outlive the page (librespot
// keeps playing when the window is evicted), so the claim cannot simply die with
// the window - but nothing will ever report the end of that album either, and a
// claim nobody refreshes would keep the box "busy" for good: no sleep timer, no
// nightly update.
const ORPHAN_TRUST_MS = 30 * 60 * 1000;

function text(v) {
  if (typeof v !== "string") return undefined;
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean ? clean.slice(0, MAX_TEXT) : undefined;
}

function number(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Artwork: an http(s) URL or an inline image. Anything else - `file:`,
 * `javascript:`, a URL with credentials in it - is dropped, because this value
 * is fetched by Home Assistant's image proxy and loaded by the launcher.
 */
function image(v) {
  if (typeof v !== "string") return undefined;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(v))
    return v.length <= MAX_DATA_URL ? v : undefined;
  if (v.length > MAX_URL) return undefined;
  let u;
  try {
    u = new URL(v);
  } catch (e) {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username || u.password) return undefined;
  return u.href;
}

/**
 * @param data   the posted body
 * @param caller the app id that sent it, or null for the launcher (which
 *               reports on behalf of the apps it knows about)
 */
function sanitize(data, caller) {
  const d = data && typeof data === "object" ? data : {};
  const app = caller != null ? String(caller) : typeof d.app === "string" ? d.app : "";
  const out = {
    app: /^[a-z0-9_.-]{1,64}$/i.test(app) ? app : "",
    state: STATES.has(d.state) ? d.state : "idle",
  };
  for (const k of ["title", "artist", "album"]) {
    const t = text(d[k]);
    if (t !== undefined) out[k] = t;
  }
  const img = image(d.image);
  if (img !== undefined) out.image = img;
  for (const k of ["position", "duration"]) {
    const n = number(d[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/**
 * Whether a claim still counts as sound coming out of the box.
 *
 * @param np      the claim
 * @param at      when it was last reported (ms)
 * @param now     the time now (ms)
 * @param hasPage whether the app that made it still has a window
 */
function stillPlaying(np, at, now, hasPage) {
  if (!np || np.state !== "playing") return false;
  if (hasPage) return true;
  return now - (at || 0) < ORPHAN_TRUST_MS;
}

module.exports = { sanitize, stillPlaying, ORPHAN_TRUST_MS, MAX_TEXT };
