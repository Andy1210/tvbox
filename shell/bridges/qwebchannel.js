// Generic QWebChannel bridge adapter (NOT app-specific).
//
// QtWebEngine-based web clients (Plex HTPC, and any similar app) expect a
// window.QWebChannel that exposes host objects (storage, player, input,
// system, settings) over a request/callback protocol. The native shell would
// be Qt; we emulate it in the browser and back it with the tvbox shell:
//   • storage  -> window.localStorage (persists in Electron userData)
//   • player   -> the shell's mpv service over IPC (mpv-overlay/fullscreen)
//   • input    -> remote media keys re-routed as semantic onKeyReceived events
//   • system/settings -> sane attribute get/set defaults
//
// Selected per app via the manifest `runtime.bridge: "qwebchannel"`; the shell
// preload loads this module and calls setup(). No knowledge of any specific
// app lives here - app DOM specifics (e.g. a transparent-video selector) are
// declared in the manifest and handled shell-side.
module.exports.setup = function setup(ctx) {
  "use strict";
  var ipcRenderer = ctx.ipcRenderer;
  var caps = ctx.caps || [];
  function has(c) {
    return caps.indexOf(c) >= 0;
  }
  var Success = 0;

  var signals = {}; // QWebChannel signal path -> connected callback
  var playing = false; // an mpv session is active (used to stop video on Back)
  function fire(path) {
    var cb = signals[path];
    if (!cb) return;
    try {
      cb.apply(null, [].slice.call(arguments, 1));
    } catch (e) {
      console.warn("[bridge] signal " + path + " threw", e);
    }
  }

  // player state events from the shell (mpv) -> QWebChannel player signals
  if (has("player")) {
    ipcRenderer.on("player-event", function (_e, ev) {
      if (ev.type === "playing") {
        playing = true;
        fire("player.onPlaying");
      } else if (ev.type === "duration") fire("player.onDurationUpdate", ev.ms);
      else if (ev.type === "position") fire("player.onPositionUpdate", ev.ms);
      else if (ev.type === "buffering") fire("player.onBuffering", !!ev.on);
      else if (ev.type === "finished") {
        playing = false;
        fire("player.onFinish");
      } else if (ev.type === "error") fire("player.onError");
    });
  }

  // Remote media keys: the client ignores raw DOM MediaXxx keys but accepts
  // SEMANTIC commands via input.onKeyReceived. Re-route so they work and the
  // client stays in sync.
  if (has("input")) {
    var MEDIA_MAP = {
      MediaPlayPause: "play_pause",
      MediaPlay: "play",
      MediaPause: "pause",
      MediaStop: "stop",
      Cancel: "stop", // this remote's Stop button arrives as DOM key "Cancel"
      MediaTrackNext: "seek_forward",
      MediaTrackPrevious: "seek_backward", // this remote's seek buttons send these
      MediaFastForward: "seek_forward",
      MediaRewind: "seek_backward",
    };
    window.addEventListener(
      "keydown",
      function (ev) {
        var name = MEDIA_MAP[ev.key];
        if (name && signals["input.onKeyReceived"]) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          fire("input.onKeyReceived", [name]);
          return;
        }
        // Backing out of the player: PAUSE mpv (freeze the frame) rather than
        // stop (kill) it. The client's first Back shows its OSD + pauses, and it
        // sends its own player.pause/player.stop over QWebChannel (verified in the
        // logs); killing mpv here left the client on the player screen with a
        // LOADER where the (gone) video was. Pause = frozen frame, no loader, and
        // no orphaned *playing* mpv (a later player.stop, the next queue, or
        // returning Home stops it). Don't preventDefault -> the client still gets
        // Back to drive its own pause/navigate.
        if (ev.key === "Backspace" && playing) {
          playing = false;
          ipcRenderer.invoke("player", "pause");
        }
      },
      true,
    );
  }

  function defaultFor(key) {
    if (/List$/.test(key)) return [];
    if (/^can[A-Z]/.test(key)) return false;
    if (key === "visibility") return "visible";
    if (/Port$/.test(key)) return 0;
    if (/Size$/.test(key)) return 0;
    return null;
  }

  function hybrid(path) {
    var fn = function () {
      var args = [].slice.call(arguments);
      var cb = args.length ? args[args.length - 1] : null;
      var hasCb = typeof cb === "function";

      // storage -> raw window.localStorage passthrough
      if (has("storage")) {
        try {
          if (path === "storage.itemKeys") {
            if (hasCb) cb({ errorCode: Success, result: Object.keys(localStorage) });
            return;
          }
          if (path === "storage.setItem") {
            localStorage.setItem(args[0], args[1]);
            if (hasCb) cb({ errorCode: Success, result: {} });
            return;
          }
          if (path === "storage.getItem") {
            if (hasCb) cb({ errorCode: Success, result: localStorage.getItem(args[0]) });
            return;
          }
          if (path === "storage.removeItem") {
            localStorage.removeItem(args[0]);
            if (hasCb) cb({ errorCode: Success, result: {} });
            return;
          }
          if (path === "storage.clear") {
            localStorage.clear();
            if (hasCb) cb({ errorCode: Success, result: {} });
            return;
          }
        } catch (e) {}
      }

      // player -> the shell's mpv service
      if (has("player") && path.indexOf("player.") === 0) {
        try {
          ipcRenderer.send(
            "plog",
            path,
            JSON.stringify(
              args.filter(function (a) {
                return typeof a !== "function";
              }),
            ).slice(0, 280),
          );
        } catch (e) {}
        if (path === "player.queue") {
          var item = Array.isArray(args[0]) ? args[0][0] : args[0];
          if (item && item.url)
            ipcRenderer.invoke("player", "queue", { url: item.url, startPos: item.startPositionSeconds || 0 });
        } else if (path === "player.play") ipcRenderer.invoke("player", "play");
        else if (path === "player.stop" || path === "player.teardown") ipcRenderer.invoke("player", "stop");
        else if (path === "player.pause") ipcRenderer.invoke("player", "pause");
        else if (path === "player.resume" || path === "player.unpause") ipcRenderer.invoke("player", "resume");
        else if (path === "player.seekTo")
          ipcRenderer.invoke("player", "seek", { posSec: typeof args[0] === "number" ? args[0] / 1000 : 0 }); // seekTo is in ms
        else if (path === "player.seek")
          ipcRenderer.invoke("player", "seek", { posSec: typeof args[0] === "number" ? args[0] : 0 });
        if (path !== "player.set" && path !== "player.get") {
          if (hasCb) cb({ errorCode: Success, result: {} });
          return;
        }
      }

      if (!hasCb) return;
      var result = {};
      if (/\.get$/.test(path) && Array.isArray(args[0])) {
        args[0].forEach(function (k) {
          var v = path === "storage.get" ? localStorage.getItem(k) : defaultFor(k);
          result[k] = { errorCode: Success, result: v === undefined ? null : v };
        });
      } else if (/\.set$/.test(path) && args[0] && typeof args[0] === "object") {
        Object.keys(args[0]).forEach(function (k) {
          if (path === "storage.set") {
            try {
              localStorage.setItem(k, typeof args[0][k] === "string" ? args[0][k] : JSON.stringify(args[0][k]));
            } catch (e) {}
          }
          result[k] = { errorCode: Success, result: true };
        });
      }
      cb({ errorCode: Success, result: result });
    };
    fn.connect = function (cb) {
      signals[path] = cb;
    };
    fn.disconnect = function () {
      delete signals[path];
    };
    var children = {};
    return new Proxy(fn, {
      get: function (t, prop) {
        if (
          prop === "connect" ||
          prop === "disconnect" ||
          prop === "apply" ||
          prop === "call" ||
          prop === "bind" ||
          prop === "name" ||
          prop === "length" ||
          prop === "prototype"
        )
          return t[prop];
        if (typeof prop !== "string") return undefined;
        if (prop === "then" || prop === "toJSON") return undefined;
        var cp = path ? path + "." + prop : prop;
        if (!children[prop]) children[prop] = hybrid(cp);
        return children[prop];
      },
      apply: function (t, thisArg, a) {
        return t.apply(thisArg, a);
      },
    });
  }

  function QWebChannel(transport, callback) {
    this.objects = hybrid("");
    if (typeof callback === "function") {
      try {
        callback(this);
      } catch (e) {
        console.error("[bridge] init callback threw", e);
      }
    }
  }

  window.qt = window.qt || { webChannelTransport: { send: function () {}, onmessage: null } };
  window.QWebChannel = QWebChannel;
  console.log("[bridge] qwebchannel adapter ready (caps:", caps.join(",") || "none", ")");
};
