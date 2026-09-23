// End-to-end sealing of what a phone sends to a pairing page.
//
// The pairing server is plain http on the LAN (a phone cannot be asked to trust
// a certificate the box made), and the 4-digit code keeps strangers from WRITING
// but not from reading: on a shared wifi, a Wi-Fi password, an SMB password or a
// backup password typed on the phone crossed the air in clear. So each session
// has a key of its own that travels only in the QR code's URL FRAGMENT, which a
// browser never sends to a server, and the page seals every body with it.
//
// WebCrypto's subtle API is not available to an http page on a LAN address (not
// a secure context), so the primitive is tweetnacl's secretbox
// (XSalsa20-Poly1305), vendored in ./vendor and served to the page from here.
// crypto.getRandomValues, which it needs for nonces, IS available there.
//
// A phone that typed the short URL instead of scanning has no key and sends
// plain bodies, exactly as before: refusing it would break setting the box up
// from a phone that cannot scan.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nacl = require("./vendor/nacl-fast.min.js");

const KEY_BYTES = nacl.secretbox.keyLength; // 32
const NONCE_BYTES = nacl.secretbox.nonceLength; // 24

function newKey() {
  return new Uint8Array(crypto.randomBytes(KEY_BYTES));
}

function keyParam(key) {
  return Buffer.from(key).toString("base64url");
}

/** Seal an object the way the page does. Used by tests and by nothing else here. */
function seal(obj, key) {
  const nonce = new Uint8Array(crypto.randomBytes(NONCE_BYTES));
  const box = nacl.secretbox(new Uint8Array(Buffer.from(JSON.stringify(obj), "utf8")), nonce, key);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(box)]).toString("base64");
}

/**
 * Open a sealed body. Answers the object, or null for anything that does not
 * authenticate - including a replay, when `seen` (a Set of nonces this session
 * already accepted) is given.
 */
function open(sealed, key, seen) {
  if (typeof sealed !== "string" || !key) return null;
  let raw;
  try {
    raw = Buffer.from(sealed, "base64");
  } catch (e) {
    return null;
  }
  if (raw.length <= NONCE_BYTES + nacl.secretbox.overheadLength) return null;
  const nonce = new Uint8Array(raw.subarray(0, NONCE_BYTES));
  const plain = nacl.secretbox.open(new Uint8Array(raw.subarray(NONCE_BYTES)), nonce, key);
  if (!plain) return null;
  const tag = Buffer.from(nonce).toString("hex");
  if (seen) {
    if (seen.has(tag)) return null;
    seen.add(tag);
  }
  try {
    const obj = JSON.parse(Buffer.from(plain).toString("utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch (e) {
    return null;
  }
}

// What GET /tvbox-seal.js answers: the library, then the page-side helper.
// `tvboxSeal.body(obj)` is a drop-in for JSON.stringify(obj) in a fetch body.
const PAGE_HELPER = `
;(function () {
  var m = /[#&]k=([A-Za-z0-9_-]+)/.exec(location.hash || "");
  var key = null;
  if (m && self.nacl) {
    var s = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    key = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) key[i] = bin.charCodeAt(i);
    if (key.length !== nacl.secretbox.keyLength) key = null;
  }
  function b64(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  self.tvboxSeal = {
    sealed: !!key,
    body: function (obj) {
      var json = JSON.stringify(obj);
      if (!key) return json;
      var nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      var box = nacl.secretbox(new TextEncoder().encode(json), nonce, key);
      var all = new Uint8Array(nonce.length + box.length);
      all.set(nonce);
      all.set(box, nonce.length);
      return JSON.stringify({ sealed: b64(all) });
    },
  };
})();
`;
let pageScript = null;
function script() {
  if (pageScript === null) {
    pageScript = fs.readFileSync(path.join(__dirname, "vendor", "nacl-fast.min.js"), "utf8") + PAGE_HELPER;
  }
  return pageScript;
}

module.exports = { newKey, keyParam, seal, open, script, KEY_BYTES };
