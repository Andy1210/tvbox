// The overlay window's bridge: two functions, and deliberately not the shell's own
// preload.
//
// This window draws one line of text over whatever is playing. It has no business
// with the player, the config, the store or anything else `preload.js` exposes, and
// it is the one window that renders in front of a running app - so the smaller its
// surface, the better.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tvboxOverlay", {
  /// A note to show. The shell has already capped the fields.
  onNote: (cb) => {
    const handler = (_e, note) => cb(note || {});
    ipcRenderer.on("overlay-note", handler);
    return () => ipcRenderer.removeListener("overlay-note", handler);
  },
  /// The note has finished fading out, so the window can be hidden.
  done: () => ipcRenderer.send("overlay-done"),
});
