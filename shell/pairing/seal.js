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
const TAG_CHARS = 16; // 64 bits of the key's hash: enough to tell two sessions apart
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

/** Seal raw bytes as nonce || box, for an answer the page opens (a screen frame). */
function sealBytes(buf, key) {
  const nonce = new Uint8Array(crypto.randomBytes(NONCE_BYTES));
  const box = nacl.secretbox(new Uint8Array(buf), nonce, key);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(box)]);
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
//   tvboxSeal.code            the code, from the URL fragment (#c=) or the query
//                             (?c=), or "" for a phone that typed the short URL.
//                             With data-ask-code on the script tag the helper then
//                             asks for it and reloads the page with ?c=.
//   tvboxSeal.sealed          true when the page has the session key (#k=)
//   tvboxSeal.param(name)     a value from the opening fragment (#name=...)
//   tvboxSeal.body(obj, path) drop-in for JSON.stringify(obj): a sealed body with
//                             the key, the plain JSON without it. Put the code in
//                             obj. `path` is the route it is POSTed to ("/save");
//                             it is sealed with the body, so a captured body cannot
//                             be sent to another route. A v2 provider requires it.
//   tvboxSeal.url(method, url, body)
//                             for a request that is NOT sealed (a data GET, a bulk
//                             upload): `url` is a path starting with "/", `body` the
//                             exact string that will be sent (omit for a GET). With
//                             the key it answers url + "n=<nonce>&m=<mac>"; without
//                             it url + "c=<code>". Send the body unchanged. The url
//                             is signed as the browser will send it (its URL
//                             parser escapes characters such as ' in a query).
//   tvboxSeal.query()         older helper: "c=<code>" without a key; with a key it
//                             throws, because a bare query cannot be authenticated.
//
//   tvboxSeal.forget()        drop what this tab kept (see below), for a page whose
//                             session is over (the phone remote after its adoption)
//
// A v2 page takes the code and key out of the address bar once it has read them
// (a screenshot or a shared link would carry them otherwise) and keeps them in
// sessionStorage, so a reload in the same tab still has them. What it kept is
// used again only while the session it came from is the one the server is
// running: the script is served per request with a tag of the live session's key
// (a hash, never the key), so a later session opened in the same tab from the
// short URL does not sign with a key nobody holds (it asks for the code instead,
// see data-ask-code).
//
// A pairing session ends 5 minutes after its last write. A v2 page with the key
// keeps it open while it is on screen with a signed keepalive every 2 minutes,
// so browsing a photo grid does not run into the timeout. A phone that typed the
// short URL has no key and gets no keepalive.
//
// A page that predates this reads the code from `?c=` and loads the script
// without data-v="2"; for it the code is copied into the query in place (no
// request is made), so it keeps working exactly as before - and keeps sending
// the code in clear, which is that page's limit, not this one's.
const PAGE_HELPER = `
;(function () {
  var hash = location.hash || "";
  var me = document.currentScript;
  var v2 = !!(me && me.getAttribute("data-v") === "2");
  var store = null;
  try {
    store = self.sessionStorage;
  } catch (e) {}
  // Kept no longer than a pairing session lasts, so a later short-URL visit in
  // the same tab does not pick up a key the box has already thrown away.
  var live = typeof self.__tvboxSealSession === "string" ? self.__tvboxSealSession : "";
  function tagOf(h) {
    var m = /[#&]k=([A-Za-z0-9_-]+)/.exec(h || "");
    var kk = m && self.nacl ? keyFrom(m[1]) : null;
    return kk ? hex(nacl.hash(kk)).slice(0, ${TAG_CHARS}) : "";
  }
  if (v2 && store) {
    try {
      if (/[#&]k=/.test(hash)) store.setItem("tvboxSeal", JSON.stringify({ hash: hash }));
      else {
        var kept = JSON.parse(store.getItem("tvboxSeal") || "null");
        if (kept && typeof kept.hash === "string" && live && tagOf(kept.hash) === live) hash = kept.hash;
        else store.removeItem("tvboxSeal");
      }
    } catch (e) {}
  }
  function param(name) {
    var m = new RegExp("[#&]" + name + "=([A-Za-z0-9_-]+)").exec(hash);
    return m ? m[1] : "";
  }
  var key = null;
  var k = param("k");
  if (k && self.nacl) key = keyFrom(k);
  var code = param("c") || new URLSearchParams(location.search).get("c") || "";
  if (v2 && location.hash) history.replaceState(null, "", location.pathname + location.search);
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
  function hmac(key, msg) {
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
  function sign(key, method, url, body) {
    var u = new URL(url, location.href);
    url = u.pathname + u.search;
    var signed = url + (url.indexOf("?") < 0 ? "?" : "&") + "n=" + b64url(nacl.randomBytes(12));
    var msg = String(method).toUpperCase() + "\\n" + signed + "\\n" + hex(nacl.hash(bytes(body)));
    return signed + "&m=" + b64url(hmac(key, enc.encode(msg)).subarray(0, ${MAC_BYTES}));
  }
  function keyFrom(text) {
    var s = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin;
    try {
      bin = atob(s);
    } catch (e) {
      return null;
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length === nacl.secretbox.keyLength ? out : null;
  }
  function sealWith(key, obj) {
    var nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    return b64(cat(nonce, nacl.secretbox(enc.encode(JSON.stringify(obj)), nonce, key)));
  }
  function openBytes(key, u8) {
    var n = nacl.secretbox.nonceLength;
    if (u8.length <= n) return null;
    return nacl.secretbox.open(u8.subarray(n), u8.subarray(0, n), key);
  }
  function openWith(key, text) {
    try {
      var plain = openBytes(key, fromB64(text));
      return plain ? JSON.parse(new TextDecoder().decode(plain)) : null;
    } catch (e) {
      return null;
    }
  }
  function fromB64(text) {
    var bin = atob(String(text || ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  self.tvboxSeal = {
    sealed: !!key,
    code: code,
    // A value from the fragment the page was opened with (it is no longer in
    // the address bar by the time the page's own script runs).
    param: param,
    url: function (method, url, body) {
      url = String(url);
      if (!key) return url + (url.indexOf("?") < 0 ? "?" : "&") + "c=" + encodeURIComponent(code);
      return sign(key, method, url, body);
    },
    query: function () {
      if (key) throw new Error("tvboxSeal.query cannot authenticate a request that has the key; use tvboxSeal.url");
      return "c=" + encodeURIComponent(code);
    },
    body: function (obj, path) {
      if (!key) return JSON.stringify(obj);
      var bound = Object.assign({}, obj);
      if (path) bound._r = "POST " + new URL(String(path), location.href).pathname;
      return JSON.stringify({ sealed: sealWith(key, bound) });
    },
    forget: function () {
      try {
        if (store) store.removeItem("tvboxSeal");
      } catch (e) {}
    },
    // The same primitives under a key of the page's own (the phone remote keeps
    // one per phone): sign(key, method, url, body), seal(key, obj) -> base64,
    // open(key, base64) -> obj, openBytes(key, Uint8Array) -> Uint8Array.
    lib: { key: keyFrom, sign: sign, seal: sealWith, open: openWith, openBytes: openBytes },
  };
  // A phone that typed the short URL has neither the key nor the code. A page
  // that opts in (data-ask-code) gets a small form for the code; sending it
  // reloads the page with ?c=, which every request of the page then carries.
  if (v2 && !key && !code && me && me.getAttribute("data-ask-code") !== null) {
    var ask = function () {
      var hu = /^hu/i.test(document.documentElement.lang || navigator.language || "");
      var box = document.createElement("form");
      box.setAttribute("style", "position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.92);color:#fff;font:18px system-ui,sans-serif;padding:24px;text-align:center");
      var label = document.createElement("label");
      label.textContent = hu ? "Írd be a tévén látható kódot" : "Enter the code shown on the TV";
      var input = document.createElement("input");
      input.setAttribute("inputmode", "numeric");
      input.setAttribute("pattern", "[0-9]*");
      input.setAttribute("maxlength", "4");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("style", "font-size:32px;width:5em;text-align:center;letter-spacing:.3em;padding:8px;border-radius:8px;border:0");
      var go = document.createElement("button");
      go.type = "submit";
      go.textContent = hu ? "Tovább" : "Continue";
      go.setAttribute("style", "font-size:18px;padding:10px 24px;border-radius:8px;border:0");
      box.appendChild(label);
      box.appendChild(input);
      box.appendChild(go);
      box.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var v = input.value.replace(/\\D/g, "");
        if (v.length !== 4) return;
        location.replace(location.pathname + "?c=" + v);
      });
      document.body.appendChild(box);
      input.focus();
    };
    if (document.body) ask();
    else document.addEventListener("DOMContentLoaded", ask);
  }
  if (v2 && key && self.__tvboxSealKeepalive) {
    setInterval(function () {
      if (document.visibilityState !== "visible") return;
      fetch(sign(key, "POST", "/tvbox-keepalive", ""), { method: "POST", body: "" }).catch(function () {});
    }, 2 * 60 * 1000);
  }
})();
`;
let naclSource = null;

// What the page compares a kept fragment against: a prefix of the SHA-512 of the
// live session's key. It says which session is running without saying anything
// about the key.
function sessionTag(key) {
  if (!key) return "";
  return crypto.createHash("sha512").update(Buffer.from(key)).digest("hex").slice(0, TAG_CHARS);
}

/**
 * The page script. `opts.key` is the live session's key (its tag goes out, never
 * the key); `opts.keepalive` turns on the page's keepalive, for a server that
 * answers POST /tvbox-keepalive. Served no-store, since the tag changes with the
 * session.
 */
function script(opts) {
  if (naclSource === null) naclSource = fs.readFileSync(path.join(__dirname, "vendor", "nacl-fast.min.js"), "utf8");
  const o = opts || {};
  const head =
    ";self.__tvboxSealSession=" +
    JSON.stringify(sessionTag(o.key)) +
    ";self.__tvboxSealKeepalive=" +
    (o.keepalive ? "true" : "false") +
    ";";
  return naclSource + head + PAGE_HELPER;
}

module.exports = { newKey, keyParam, seal, sealBytes, open, script, sessionTag, mac, macOk, splitMac, KEY_BYTES };
