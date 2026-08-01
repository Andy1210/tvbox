// tvbox shell preload - thin, app-agnostic loader.
//
// Always exposes shell NAVIGATION (window.tvbox + the remote Home button). Then
// it asks the shell which app this is and whether its manifest declared a BRIDGE
// ADAPTER, and loads that (from the app's own package) with the granted
// capabilities. The shell core knows nothing about any specific app - what
// bridge an app needs (if any) ships with the app.
const { ipcRenderer } = require("electron");

(function () {
  "use strict";

  const info = (function () {
    try {
      return ipcRenderer.sendSync("tvbox:app") || {};
    } catch (e) {
      return {};
    }
  })();
  const caps = info.capabilities || [];

  // ---- universal: shell navigation (works in every app) ----
  window.tvbox = {
    launch: function (appId) {
      try {
        ipcRenderer.send("nav", appId);
      } catch (e) {}
    },
    home: function () {
      try {
        ipcRenderer.send("nav", "home");
      } catch (e) {}
    },
    // On-screen notifications pushed by the shell (from MQTT - HA alerts, doorbell
    // camera, …). Receive-only, so it's safe to expose everywhere.
    onNotify: function (cb) {
      var h = function (_e, n) {
        try {
          cb(n);
        } catch (e) {}
      };
      ipcRenderer.on("tv-notify", h);
      return function () {
        try {
          ipcRenderer.removeListener("tv-notify", h);
        } catch (e) {}
      };
    },
    // Media commands forwarded from the shell (MQTT tv_control) so the active app
    // can drive its own player (e.g. Spotify transport).
    onCommand: function (cb) {
      var h = function (_e, c) {
        try {
          cb(c);
        } catch (e) {}
      };
      ipcRenderer.on("tv-command", h);
      return function () {
        try {
          ipcRenderer.removeListener("tv-command", h);
        } catch (e) {}
      };
    },
    // Launcher navigation pushed by the shell while the launcher is already up
    // (a remapped Settings button on the remote - /tvbox/api/nav). When an app
    // is fullscreen instead, the shell reloads the launcher with a #hash.
    onNav: function (cb) {
      var h = function (_e, n) {
        try {
          cb(n);
        } catch (e) {}
      };
      ipcRenderer.on("tvbox-nav", h);
      return function () {
        try {
          ipcRenderer.removeListener("tvbox-nav", h);
        } catch (e) {}
      };
    },
  };

  // ---- player control (for built-in apps that hold the "player" capability,
  // e.g. the launcher driving Live TV through the shell's mpv service) ----
  if (caps.indexOf("player") >= 0) {
    // `streams` (optional) is the app's own track decision, in 0-based ordinals
    // within each type: { audio, sub, subFile }. An app that resolved its
    // streams elsewhere (a media server told it which ones to play) passes them
    // here. What it leaves out falls back to the box's language preference
    // (Settings > Picture & sound), per axis - so omitting the argument entirely
    // is the same as having no opinion about either.
    window.tvbox.play = function (url, streams) {
      try {
        ipcRenderer.invoke("player", "queue", { url: url, streams: streams || null });
        ipcRenderer.invoke("player", "play");
      } catch (e) {}
    };
    window.tvbox.stop = function () {
      try {
        ipcRenderer.invoke("player", "stop");
      } catch (e) {}
    };
    // Live TV "browse while watching": shrink the current channel to a PiP at the
    // given device-pixel rect (on=true) or restore it fullscreen (on=false).
    window.tvbox.pip = function (on, rect) {
      try {
        ipcRenderer.invoke("player", "pip", { on: !!on, rect: rect || null });
      } catch (e) {}
    };
    // In-playback track surface: list the stream's audio/subtitle tracks and
    // switch (id, or "no"/"auto") - backs a player-overlay language picker.
    window.tvbox.tracks = function () {
      try {
        return ipcRenderer.invoke("player", "tracks").then(function (r) {
          return r && r.tracks ? r.tracks : [];
        });
      } catch (e) {
        return Promise.resolve([]);
      }
    };
    window.tvbox.setTrack = function (type, id) {
      try {
        ipcRenderer.invoke("player", "track", { type: type, id: id });
      } catch (e) {}
    };
    // Same track terms as play()'s `streams`, for switching mid-playback:
    // { audio, sub, subFile } with sub:-1 meaning off.
    window.tvbox.selectStreams = function (streams) {
      try {
        return ipcRenderer.invoke("player", "select", streams || {});
      } catch (e) {
        return Promise.resolve({ ok: false });
      }
    };
    // One allowlisted mpv playback property (sub-delay, audio-delay, speed,
    // volume, the sub-* look). Rejected main-side if it isn't on the list.
    window.tvbox.setPlayerProp = function (name, value) {
      try {
        return ipcRenderer.invoke("player", "prop", { name: String(name), value: value });
      } catch (e) {
        return Promise.resolve({ ok: false });
      }
    };
    window.tvbox.onPlayer = function (cb) {
      var h = function (_e, ev) {
        try {
          cb(ev);
        } catch (e) {}
      };
      ipcRenderer.on("player-event", h);
      return function () {
        try {
          ipcRenderer.removeListener("player-event", h);
        } catch (e) {}
      };
    };
  }
  // ---- fetch capability: scoped server-side data proxy (origin-locked +
  // SSRF-guarded in main via app:fetch) - lets an app fetch/parse its declared
  // origins (e.g. an IPTV channel list / XMLTV) without a service plugin ----
  if (caps.indexOf("fetch") >= 0) {
    window.tvbox.fetch = function (url, opts) {
      opts = opts || {};
      return ipcRenderer.invoke("app:fetch", {
        url: String(url),
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
      });
    };
  }
  // ---- typing screen (launcher only; main.js rejects any other sender) ----
  // Not an HTTP route on purpose: every local app bundle shares the shell's origin,
  // so a route would let any of them read the pairing code and inject keystrokes
  // into another app's focused field.
  window.tvbox.typing = {
    status: function () {
      return ipcRenderer.invoke("textinput", "status");
    },
    submit: function (text) {
      return ipcRenderer.invoke("textinput", "submit", { text: String(text == null ? "" : text) });
    },
    cancel: function () {
      return ipcRenderer.invoke("textinput", "cancel");
    },
    phone: function () {
      return ipcRenderer.invoke("textinput", "phone");
    },
  };

  // ---- display capability: adaptive output mode for an app's OWN video ----
  // Apps playing through the shell's mpv get this for free (main handles it);
  // this is for an app that plays video itself (a <video> element, its own player)
  // and wants the output to match. Foreground-only, enforced main-side.
  if (caps.indexOf("display") >= 0) {
    window.tvbox.display = {
      claimForVideo: function (v) {
        v = v || {};
        return ipcRenderer.invoke("display", "claim", { width: v.width, height: v.height, fps: v.fps });
      },
      release: function () {
        return ipcRenderer.invoke("display", "release");
      },
    };
  }
  // ---- storage capability: per-app key/value (main-side app:storage) ----
  if (caps.indexOf("storage") >= 0) {
    window.tvbox.storage = {
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
  // HOME-screen widgets (plugin-driven cards, e.g. Spotify now-playing).
  window.tvbox.onWidgets = function (cb) {
    var h = function (_e, list) {
      try {
        cb(list || []);
      } catch (e) {}
    };
    ipcRenderer.on("widgets", h);
    return function () {
      try {
        ipcRenderer.removeListener("widgets", h);
      } catch (e) {}
    };
  };

  // Remote Home button (CEC double-tap Back -> KEY_HOMEPAGE -> DOM "BrowserHome"):
  // always return to the HOME launcher, from any app.
  window.addEventListener(
    "keydown",
    function (ev) {
      if (ev.key === "BrowserHome") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        ipcRenderer.send("nav", "home");
      }
    },
    true,
  );

  // ---- bridge adapter (declared by the app's manifest runtime.bridge) ----
  // A bridge translates some foreign host API (e.g. Qt's QWebChannel, which
  // Plex HTPC expects) into the shell's own IPC, and ships INSIDE the app
  // package - which is the point: a client-specific quirk is then fixed by
  // updating that app from the registry instead of shipping a whole OTA to
  // boxes that don't even have it installed. main resolves and validates the
  // path (it is the side that knows where a package lives); the preload only
  // loads what it is handed.
  if (info.bridgeFile) {
    try {
      const adapter = require(info.bridgeFile);
      adapter.setup({ ipcRenderer, caps });
    } catch (e) {
      console.warn("[bridge] adapter '" + info.bridge + "' failed to load:", e.message);
    }
  } else {
    console.log("[bridge] no adapter (caps:", caps.join(",") || "none", ")");
  }
})();
