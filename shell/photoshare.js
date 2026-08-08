// Photos a phone pushed at the TV to be looked at now.
//
// The screensaver has an upload of its own (ambient.js) and this is deliberately
// not it. The difference is lifetime, and it decides the whole design: a cast is
// over when you stop looking, nobody tidies a folder from a remote control, and
// the box's SD card is not where someone's holiday should come to rest. So the
// session is emptied when the viewer closes - and, because a power cut is not a
// viewer closing, on every shell start as well. A cleanup that needs the user to
// remember it is a cleanup that does not happen.
//
// The directory lives under ~/.tvbox so it travels with the box's own state, and
// its name is in contentdirs' MACHINERY set, so it can never also turn up in the
// Files app as a browsable folder called "photoshare".
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = path.join(os.homedir(), ".tvbox", "photoshare");

// What one session may hold. The phone downscales before it uploads, so these are
// roughly a thousand photos' worth of headroom over what anyone shows on a TV -
// they exist so that a runaway upload cannot fill the boot medium, not to ration
// an ordinary use.
const MAX_ITEMS = 300;
const MAX_BYTES = 200e6;

const NAME_RE = /^\d{4}-[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/;

function ensure() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return true;
  } catch (e) {
    console.warn("[photoshare] cannot create", DIR, e.message);
    return false;
  }
}

// The session's photos, in the order they arrived - which is the order the phone's
// picker offered them, and so the order the person expects to page through. The
// four-digit prefix each file is stored under is what makes that a plain sort.
function list() {
  try {
    return fs
      .readdirSync(DIR)
      .filter((f) => NAME_RE.test(f))
      .sort();
  } catch (e) {
    return [];
  }
}

function totalBytes(names) {
  let n = 0;
  for (const f of names) {
    try {
      n += fs.statSync(path.join(DIR, f)).size;
    } catch (e) {}
  }
  return n;
}

// One uploaded photo (base64, optionally still wrapped in a data: URL). Returns
// the stored name, or throws with a reason the phone page can show.
function save(name, base64) {
  if (!ensure()) throw new Error("failed");
  const names = list();
  if (names.length >= MAX_ITEMS) throw new Error("full");
  const body = String(base64 || "").replace(/^data:[^,]*,/, "");
  const buf = Buffer.from(body, "base64");
  if (!buf.length) throw new Error("empty");
  if (totalBytes(names) + buf.length > MAX_BYTES) throw new Error("full");

  let safe = String(name || "photo")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_") // never a dotfile, and never "..": list() would skip it and clear() would not
    .slice(-60);
  if (!/\.(jpe?g|png|webp)$/i.test(safe)) safe += ".jpg";
  // Numbered from what is already there rather than from a counter in memory, so a
  // shell that reloaded mid-session does not start writing over the first photos.
  const last = names.length ? parseInt(names[names.length - 1].slice(0, 4), 10) : 0;
  const file = String(last + 1).padStart(4, "0") + "-" + safe;
  fs.writeFileSync(path.join(DIR, file), buf);
  return file;
}

// The absolute path of one session photo, or "" for a name that is not one of
// ours. The pattern is the guard: it admits no separator and no leading dot, so
// there is nothing for a traversal to be built out of.
function pathFor(name) {
  const n = String(name || "");
  if (!NAME_RE.test(n)) return "";
  const p = path.join(DIR, n);
  return p.startsWith(DIR + path.sep) ? p : "";
}

// Empty the session. Returns how many went - the caller reports it, and a count of
// zero is a useful answer when someone presses it twice.
function clear() {
  let n = 0;
  for (const f of list()) {
    try {
      fs.unlinkSync(path.join(DIR, f));
      n++;
    } catch (e) {}
  }
  return n;
}

// Called once at boot. Anything still here belongs to a session whose TV was
// turned off at the wall, and there is no one left who wants it.
function sweep() {
  const n = clear();
  if (n) console.log("[photoshare] cleared " + n + " photo(s) left over from a previous session");
  return n;
}

module.exports = { DIR, MAX_ITEMS, MAX_BYTES, list, save, pathFor, clear, sweep };
