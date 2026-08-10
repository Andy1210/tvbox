// Pairing provider: hand another tvbox a credential for this one's app shares.
//
// Unlike every other provider here, the client is not a phone - it is the box in
// the other room (peers.js), which sweeps the LAN for a box holding the pairing
// port open and then asks for the credential with the four digits on this box's
// screen. The page exists anyway, for two reasons: the sweep reads its MARKER to
// tell a box waiting to pair from anything else on that port, and a person who
// opens the address in a browser deserves to be told what is going on rather
// than a blank 404.
//
// What is handed over is the app-shares token, never the file server's password:
// it reaches an app's declared folders read-only and can be revoked on its own.
const peers = require("../peers");

let credentialsHook = () => null;

// main.js owns the config and the shares server; this only asks for them.
function init({ credentials }) {
  if (credentials) credentialsHook = credentials;
}

const STR = {
  hu: {
    title: "tvbox - Box összekötése",
    body: "Ez a box éppen egy másik tvbox csatlakozására vár, hogy az elérhesse a megosztott mentéseket. A másik boxon add meg a képernyőn látható négyjegyű kódot.",
  },
  en: {
    title: "tvbox - Connect a box",
    body: "This box is waiting for another tvbox to connect so it can read the shared save files. Enter the four-digit code shown on this screen on the other box.",
  },
};

function page(ctx) {
  const t = STR[ctx.locale] || STR.en;
  // The marker is what the other box matches on, so it must survive translation.
  return (
    "<!doctype html><html><head><meta charset=utf-8>" +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<title>" +
    t.title +
    "</title><body style='font:16px system-ui;margin:2rem;max-width:34rem'>" +
    "<h1>" +
    t.title +
    "</h1><p>" +
    t.body +
    "</p><!-- " +
    peers.MARKER +
    " -->"
  );
}

const routes = {
  // Gated by the pairing core: a data GET needs ?c=<code>, wrong codes count
  // towards its lockout and never extend the window.
  "GET /peer/credentials": (req, res, ctx) => {
    const c = credentialsHook();
    if (!c || !c.token) return ctx.json(res, { error: "not_sharing" });
    // Handing the credential over is the end of this pairing session: leaving the
    // window open would let a second box take the same token off the same code.
    ctx.stopSoon(1000);
    ctx.json(res, { id: c.id, name: c.name, port: c.port, token: c.token });
  },
};

module.exports = { init, page, routes, STR };
