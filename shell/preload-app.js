// tvbox preload for the hardened REMOTE window (contextIsolation + sandbox ON).
//
// Two jobs, with very different trust levels:
//
//  1. Capability brokers for an app that DECLARED caps beyond "nav" - exposed
//     through contextBridge, so the app never touches Node, ipcRenderer, or any
//     surface it didn't ask for. Enforcement lives in the main process
//     (app:fetch / app:storage keyed to the active app's manifest); this file is
//     just the thin, capability-gated surface.
//  2. The text-input bridge, which runs for EVERY remote app - a plain site
//     (YouTube, xbox.com) included. It watches for focus landing in a text field
//     and tells the shell, which is how the on-screen keyboard / phone typing
//     comes up on a TV with no keyboard.
//
// Job 2 is why this file is now attached to every remote window, where before a
// nav-only site got no preload at all. It exposes NOTHING to the page: with no
// contextBridge call the page cannot see or reach any of it, so an untrusted site
// gains no API it didn't have - only the shell learns "a field is focused".
const { contextBridge, ipcRenderer } = require("electron");

const info = (function () {
  try {
    return ipcRenderer.sendSync("tvbox:app") || {};
  } catch (e) {
    return {};
  }
})();
const caps = info.capabilities || [];

// Navigation (launch/home) is universal. The remote Home key is handled
// main-side (before-input-event in openRemoteApp), so it's not re-bound here.
// NOTE: onNotify/onCommand are deliberately NOT exposed here - the shell only
// pushes tv-notify / tv-command to the launcher window, never to this isolated
// window, so exposing them would be a dead API. If a capability app ever needs
// them, forward those events to remoteWin in main.js first.
const api = {
  launch: function (appId) {
    ipcRenderer.send("nav", String(appId));
  },
  home: function () {
    ipcRenderer.send("nav", "home");
  },
};

// ---- fetch capability: scoped server-side data proxy ----
if (caps.indexOf("fetch") >= 0) {
  api.fetch = function (url, opts) {
    opts = opts || {};
    return ipcRenderer.invoke("app:fetch", {
      url: String(url),
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
    });
  };
}

// ---- storage capability: per-app key/value ----
if (caps.indexOf("storage") >= 0) {
  api.storage = {
    get: function (key) {
      return ipcRenderer.invoke("app:storage", "get", String(key)).then(function (r) {
        return r && r.ok ? r.value : null;
      });
    },
    set: function (key, value) {
      return ipcRenderer.invoke("app:storage", "set", String(key), String(value));
    },
    remove: function (key) {
      return ipcRenderer.invoke("app:storage", "remove", String(key));
    },
  };
}

// ---- shares capability: this app's folders on the box in the other room ----
// The app owns the screen for this, because it is the one that knows what its
// files mean - "continue in the other room" is a sentence only an emulator can
// write. What it does NOT own is the permission: which folders may be offered
// comes from its manifest, switching them on is a person's job in Settings, and
// the boxes are paired there too. So this is a small surface: what am I allowed
// to see, and bring one of mine here.
if (caps.indexOf("shares") >= 0) {
  api.shares = {
    // { peers: [{id, name}], shares: [{id, name, present, on}] } - this app's own.
    list: function () {
      return ipcRenderer.invoke("app:shares", "list");
    },
    // Bring one of this app's shares from a paired box. There is no push, and no
    // destination argument: the box resolves where it goes from the manifest.
    // What a pull would bring, and what it would replace with an older copy.
    // Read-only, and the answer is a verdict rather than a listing.
    compare: function (peerId, shareId) {
      return ipcRenderer.invoke("app:shares", "compare", { peerId: String(peerId), shareId: String(shareId) });
    },
    // `group` (optional) names ONE folder inside the share - an emulator's own,
    // as `compare` reports them - so a room can bring the console it played
    // without touching the rest.
    pull: function (peerId, shareId, group) {
      return ipcRenderer.invoke("app:shares", "pull", {
        peerId: String(peerId),
        shareId: String(shareId),
        group: group ? String(group) : "",
      });
    },
  };
}

// ---- display capability: adaptive output mode for the app's OWN video ----
// For an app that plays video itself (a <video> element) instead of handing a URL
// to the shell's mpv: the output switches to a mode that matches the content and
// goes back on release. Foreground-only, enforced main-side.
if (caps.indexOf("display") >= 0) {
  api.display = {
    claimForVideo: function (v) {
      v = v || {};
      return ipcRenderer.invoke("display", "claim", { width: v.width, height: v.height, fps: v.fps });
    },
    release: function () {
      return ipcRenderer.invoke("display", "release");
    },
  };
}

// ---- language: make the page believe it runs in the box's UI language ---------
// Sites read navigator.language(s) (and get Accept-Language from the session, set
// shell-side). executeInMainWorld runs BEFORE the page's own scripts, which matters:
// an SPA reads its locale once at bootstrap. Without this a remote app followed the
// system locale - or the site's IP guess, which had xbox.com coming up in German on
// a Hungarian box.
// WebAuthn: Chromium advertises it, but this Electron has no authenticator UI, so
// navigator.credentials.get() never settles (measured: no dialog, no rejection, its
// own timeout ignored) - a sign-in page then offers "face / fingerprint / PIN" and
// does nothing, forever. Remove it here, BEFORE the page's scripts feature-detect:
// the main-process dom-ready injection is only a backstop, and a page could defeat
// that one by setting its marker global first.
try {
  contextBridge.executeInMainWorld({
    func: function () {
      try {
        delete window.PublicKeyCredential;
      } catch (e) {}
      try {
        var no = function () {
          var err = new Error("WebAuthn is not available on this device");
          err.name = "NotSupportedError";
          return Promise.reject(err);
        };
        if (navigator.credentials) {
          navigator.credentials.get = no;
          navigator.credentials.create = no;
        }
      } catch (e) {}
    },
  });
} catch (e) {
  // Older Electron without executeInMainWorld: the dom-ready backstop still runs.
}

if (info.language) {
  try {
    contextBridge.executeInMainWorld({
      func: function (tag) {
        try {
          var langs = [tag];
          var base = String(tag).split("-")[0];
          if (base && base !== tag) langs.push(base);
          if (base !== "en") langs.push("en");
          Object.defineProperty(navigator, "language", {
            get: function () {
              return tag;
            },
            configurable: true,
          });
          Object.defineProperty(navigator, "languages", {
            get: function () {
              return langs;
            },
            configurable: true,
          });
        } catch (e) {}
      },
      args: [info.language],
    });
  } catch (e) {
    // Older Electron without executeInMainWorld: the Accept-Language header still
    // applies, so the app is merely less consistent, not broken.
  }
}

// ---- text input: tell the shell when a field takes focus ----------------------
// The 10-foot UI has no keyboard, so a focused <input> is a dead end unless the
// shell offers a way to type. What leaves the page is the signal (kind + label) and
// the field's CURRENT TEXT, so the keyboard can open on it and a typo can be fixed
// rather than retyped - delivery replaces the whole field, so an empty keyboard
// meant nobody could edit anything. The text is typed back as real key events by
// the main process, so this side still never writes to the field.
//
// The one value that does NOT leave: a password field's. It is the one thing on a
// page deliberately not on screen, and this reaches the TV and - once the phone is
// armed - a page served over the LAN in clear. Withheld here, and refused again in
// ../textinput.js, which is where every other rule about the offer lives too.
(function () {
  var TEXTY = /^(|text|search|email|url|tel|number|password)$/i;
  // Ten times what the shell will type back, so the shell always sees enough to judge
  // a value too long rather than a slice that looks short enough.
  var VALUE_TRANSPORT_MAX = 4000;
  // Is this a text field at all? The question fieldInfo answers on the way in, with
  // none of the "can we usefully open a keyboard for it" conditions.
  function isField(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return !!el.isContentEditable;
    try {
      return TEXTY.test(el.getAttribute("type") || "");
    } catch (e) {
      return false;
    }
  }
  function fieldInfo(el) {
    if (!el || el.disabled || el.readOnly) return null;
    // Offscreen/hidden inputs are a common leanback trick for capturing keys; opening
    // the keyboard for one would hijack an app that is perfectly usable already.
    try {
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return null;
      if (!el.offsetParent && el.getClientRects().length === 0) return null;
    } catch (e) {}
    var tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea") return { kind: "textarea", password: false };
    if (tag === "input") {
      // Once, into a local: a page that overrides getAttribute could otherwise pass
      // the test with "text" and hand us something else as the kind.
      var type = String(el.getAttribute("type") || "text").toLowerCase();
      if (!TEXTY.test(type)) return null;
      return { kind: type.slice(0, 16), password: type === "password" };
    }
    if (el.isContentEditable) return { kind: "contenteditable", password: false };
    return null;
  }
  // What the field already holds, so the keyboard can open ON it rather than empty.
  // The text is typed back as a REPLACEMENT, so without this a field with anything in
  // it could only be retyped from scratch - there was no way to fix one character of
  // an address, and no way to even see what was there.
  //
  // A password field is the exception and stays secret: its value is the one thing on
  // a page that is deliberately not on screen, and this reaches both the TV and, once
  // the phone is armed, a page served over the LAN in clear.
  //
  // The cap here is transport only - a page must not be able to push a novel through
  // the IPC on a focus event. Whether a value is short enough to be OFFERED is the
  // shell's call (MAX_TEXT in ../textinput.js), which is the one place that knows how
  // much it will type back.
  function valueOf(el, password) {
    if (password) return "";
    try {
      var raw = el.isContentEditable ? el.innerText : el.value;
      // Cut to the transport cap BEFORE the strip, not after. This runs inside a
      // focusin handler on the renderer's own thread, and a page is free to focus an
      // input holding megabytes - scanning all of it would stall the picture to
      // produce a value the shell discards anyway, since its own limit is far below
      // this one. Anything at or under the cap is untouched by the cut, so the
      // ordinary case is the same string either way.
      var text = String(raw == null ? "" : raw).slice(0, VALUE_TRANSPORT_MAX);
      // The same strip labelFor does, and for the same reason: this text is put on
      // the TV and on the phone page, where a bidi override can make it read as
      // something else entirely - and a C0 control is dropped on the way back out
      // anyway, so showing one would be showing a character that cannot survive.
      return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
    } catch (e) {
      return "";
    }
  }
  // What the app CALLS the field, for the TV screen, so the user knows what they are
  // typing. Authored text - a placeholder, an aria-label - and never the contents,
  // which valueOf above answers for under rules of their own: a label is shown for
  // every field, including the one whose value must not be.
  function labelFor(el) {
    var t =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (el.labels && el.labels[0] && el.labels[0].textContent) ||
      el.getAttribute("name") ||
      "";
    // Strip controls and bidi/format characters here as well as shell-side: this text
    // ends up on the TV and on the phone page, and a right-to-left override can make a
    // label read as something else entirely.
    return String(t)
      .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .trim()
      .slice(0, 80);
  }
  if (info.textInput === "off") return; // the app brings its own keyboard
  document.addEventListener(
    "focusin",
    function (ev) {
      // composedPath()[0], not ev.target: focusin crosses shadow boundaries, but on a
      // document listener ev.target is retargeted to the shadow HOST, so a field inside
      // a web component (common in sign-in widgets) would never be recognised.
      var el = (ev.composedPath && ev.composedPath()[0]) || ev.target;
      var info = fieldInfo(el);
      if (!info) return;
      try {
        ipcRenderer.send("kbd:focus", {
          kind: info.kind,
          password: info.password,
          label: labelFor(el),
          value: valueOf(el, info.password),
        });
      } catch (e) {}
    },
    true,
  );
  // The other half, and it is not for the typing screen: the shell needs to know
  // when a field STOPPED being focused, because the remote's Back key arrives as a
  // Backspace and a page with a text field focused is editing rather than
  // navigating. focusout fires before the next focusin, so a move between two
  // fields reports blur-then-focus and settles on focused.
  document.addEventListener(
    "focusout",
    function (ev) {
      var el = (ev.composedPath && ev.composedPath()[0]) || ev.target;
      // Not fieldInfo: it rejects a field that is disabled, hidden or detached, and
      // those are ordinary states at blur time - a page that removes the focused
      // input on a step change fires focusout with exactly such an element. The
      // main process only drops the page from `editingPages` on this message, so a
      // missed blur leaves Backspace counting as editing and stops closing a popup.
      if (!isField(el)) return;
      try {
        ipcRenderer.send("kbd:blur");
      } catch (e) {}
    },
    true,
  );
})();

try {
  if (
    caps.some(function (c) {
      return c && c !== "nav";
    })
  )
    contextBridge.exposeInMainWorld("tvbox", api);
} catch (e) {
  // contextBridge throws if contextIsolation is off - but this preload is only
  // ever attached to the isolated window, so that path shouldn't happen.
}
