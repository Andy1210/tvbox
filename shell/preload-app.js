// tvbox capability preload - for CAPABILITY APPS in the isolated window.
//
// Unlike preload.js (the main, Node-capable window used by the launcher and
// local static bundles), this runs in the hardened remote window
// (contextIsolation + sandbox ON) and exposes the granted capability brokers
// through contextBridge - the app never touches Node, ipcRenderer, or any
// surface it didn't declare. It's attached ONLY to apps that declare caps
// beyond "nav" (see openRemoteApp), so a plain remote site (YouTube) still gets
// no preload at all. The broker enforcement lives in the main process
// (app:fetch / app:storage keyed to the active app's manifest); this file is
// just the thin, capability-gated surface.
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

try {
  contextBridge.exposeInMainWorld("tvbox", api);
} catch (e) {
  // contextBridge throws if contextIsolation is off - but this preload is only
  // ever attached to the isolated window, so that path shouldn't happen.
}
