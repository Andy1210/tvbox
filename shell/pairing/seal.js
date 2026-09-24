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

// A MAC for the requests that are not sealed: data GETs and bulk uploads (a
// photo, a ROM chunk), where sealing megabytes twice over on a phone buys little.
// HMAC-SHA512 under the session key, over the method, the path with its query
// (the `m` parameter itself excluded, which the page appends last) and a hash of
// the exact body bytes, so someone reading one request off the air can neither
// alter it nor make a different one. A write also carries a fresh `n`, and the
// server refuses a write whose `n` it has seen, so it cannot be replayed either.
const MAC_BYTES = 16;
function sha512hex(buf) {
  return crypto.createHash("sha512").update(buf).digest("hex");
}
function mac(key, method, pathAndQuery, body) {
  if (!key) return null;
  const h = crypto.createHmac("sha512", Buffer.from(key));
  h.update(String(method).toUpperCase() + "\n" + String(pathAndQuery) + "\n" + sha512hex(body || Buffer.alloc(0)));
  return h.digest().subarray(0, MAC_BYTES).toString("base64url");
}

/**
 * Split a request URL into the part the MAC covers and the MAC. The page puts
 * `m` last, so the covered part is everything before the final "&m=". Answers
 * null when there is none, or it is not the shape the page makes.
 */
function splitMac(url) {
  const s = String(url || "");
  const at = s.lastIndexOf("&m=");
  if (at < 0) return null;
  const m = s.slice(at + 3);
  if (!/^[A-Za-z0-9_-]{22}$/.test(m)) return null;
  return { signed: s.slice(0, at), mac: m };
}

function macOk(key, method, url, body) {
  const parts = splitMac(url);
  if (!parts || !key) return false;
  const want = Buffer.from(mac(key, method, parts.signed, body));
  const got = Buffer.from(parts.mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
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
//
// The contract a pairing page follows (a v2 provider, see pairing/index.js):
//   <script src="/tvbox-seal.js" data-v="2"></script>
//   tvboxSeal.code            the code, from the URL fragment (#c=), or "" for a
//                             phone that typed the short URL (it asks the person)
//   tvboxSeal.sealed          true when the page has the session key (#k=)
//   tvboxSeal.body(obj)       drop-in for JSON.stringify(obj): a sealed body with
//                             the key, the plain JSON without it. Put the code in obj.
//   tvboxSeal.url(method, url, body)
//                             for a request that is NOT sealed (a data GET, a bulk
//                             upload): `url` is a path starting with "/", `body` the
//                             exact string that will be sent (omit for a GET). With
//                             the key it answers url + "n=<nonce>&m=<mac>"; without
//                             it url + "c=<code>". Send the body unchanged.
//   tvboxSeal.query()         older helper: "c=<code>" without a key; with a key it
//                             throws, because a bare query cannot be authenticated.
//
// A page that predates this reads the code from `?c=` and loads the script
// without data-v="2"; for it the code is copied into the query in place (no
// request is made), so it keeps working exactly as before - and keeps sending
// the code in clear, which is that page's limit, not this one's.
const PAGE_HELPER = `
;(function () {
  var hash = location.hash || "";
  function param(name) {
    var m = new RegExp("[#&]" + name + "=([A-Za-z0-9_-]+)").exec(hash);
    return m ? m[1] : "";
  }
  var key = null;
  var k = param("k");
  if (k && self.nacl) {
    var s = k.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    key = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) key[i] = bin.charCodeAt(i);
    if (key.length !== nacl.secretbox.keyLength) key = null;
  }
  var code = param("c") || new URLSearchParams(location.search).get("c") || "";
  var me = document.currentScript;
  var v2 = !!(me && me.getAttribute("data-v") === "2");
  if (!v2 && code && !new URLSearchParams(location.search).get("c")) {
    history.replaceState(null, "", location.pathname + "?c=" + encodeURIComponent(code) + hash);
  }
  var enc = new TextEncoder();
  function b64(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function b64url(u8) {
    return b64(u8).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  function hex(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
    return s;
  }
  function cat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }
  // HMAC-SHA512 (RFC 2104) over nacl.hash, which is SHA-512; block size 128.
  function hmac(msg) {
    var k = new Uint8Array(128);
    k.set(key);
    var ipad = new Uint8Array(128), opad = new Uint8Array(128);
    for (var i = 0; i < 128; i++) {
      ipad[i] = k[i] ^ 0x36;
      opad[i] = k[i] ^ 0x5c;
    }
    return nacl.hash(cat(opad, nacl.hash(cat(ipad, msg))));
  }
  function bytes(body) {
    if (body == null) return new Uint8Array(0);
    if (typeof body === "string") return enc.encode(body);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    throw new Error("tvboxSeal.url: body must be the string or bytes that will be sent");
  }
  self.tvboxSeal = {
    sealed: !!key,
    code: code,
    url: function (method, url, body) {
      url = String(url);
      var sep = url.indexOf("?") < 0 ? "?" : "&";
      if (!key) return url + sep + "c=" + encodeURIComponent(code);
      var signed = url + sep + "n=" + b64url(nacl.randomBytes(12));
      var msg = String(method).toUpperCase() + "\\n" + signed + "\\n" + hex(nacl.hash(bytes(body)));
      return signed + "&m=" + b64url(hmac(enc.encode(msg)).subarray(0, ${MAC_BYTES}));
    },
    query: function () {
      if (key) throw new Error("tvboxSeal.query cannot authenticate a request that has the key; use tvboxSeal.url");
      return "c=" + encodeURIComponent(code);
    },
    body: function (obj) {
      var json = JSON.stringify(obj);
      if (!key) return json;
      var nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      var box = nacl.secretbox(enc.encode(json), nonce, key);
      return JSON.stringify({ sealed: b64(cat(nonce, box)) });
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

module.exports = { newKey, keyParam, seal, open, script, mac, macOk, splitMac, KEY_BYTES };
