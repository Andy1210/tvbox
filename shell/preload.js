// tvbox shell preload - thin, app-agnostic loader.
//
// Always exposes shell NAVIGATION (window.tvbox + the remote Home button). Then
// it asks the shell which app this is and which BRIDGE ADAPTER its manifest
// declared, and loads that generic adapter from bridges/ with the granted
// capabilities. The shell core knows nothing about any specific app - what
// bridge an app needs (if any) is declared in its manifest.
const { ipcRenderer } = require("electron");
const path = require("path");

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
  };

  // ---- player control (for built-in apps that hold the "player" capability,
  // e.g. the launcher driving Live TV through the shell's mpv service) ----
  if (caps.indexOf("player") >= 0) {
    window.tvbox.play = function (url) {
      try {
        ipcRenderer.invoke("player", "queue", { url: url });
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
  // e.g. a Plex-HTPC-style web client declares "qwebchannel". Validated against
  // a safe name and loaded only from the shell's own bridges/ dir.
  if (info.bridge && /^[a-z0-9_-]+$/.test(info.bridge)) {
    try {
      const adapter = require(path.join(__dirname, "bridges", info.bridge + ".js"));
      adapter.setup({ ipcRenderer, caps });
    } catch (e) {
      console.warn("[bridge] adapter '" + info.bridge + "' failed to load:", e.message);
    }
  } else {
    console.log("[bridge] no adapter (caps:", caps.join(",") || "none", ")");
  }
})();
