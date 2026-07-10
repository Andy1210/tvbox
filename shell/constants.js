// Shared shell constants. PORT is the local HTTP server on 127.0.0.1 - the
// launcher, app web/ bundles, and the JSON control API all hang off it. Kept
// out of main.js so it can be required without loading Electron.
const PORT = 8097;
module.exports = { PORT };
