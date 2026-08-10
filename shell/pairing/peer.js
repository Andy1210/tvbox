// Pairing provider: two tvboxes letting each other read what their apps offer.
//
// Unlike every other provider here, the client is not a phone - it is the box in
// the other room (peers.js), which sweeps the LAN for a box holding the pairing
// port open and then asks with the four digits on this box's screen. The page
// exists anyway, for two reasons: the sweep reads its MARKER to tell a box waiting
// to pair from anything else on that port, and a person who opens the address in a
// browser deserves to be told what is going on rather than a blank 404.
//
// **One code pairs both ways.** The box that asks sends its own credentials in the
// same request, so this one ends up knowing it too. The alternative - a second
// walk to the other TV, a second code, typed the other way round - is ceremony for
// a relationship that is symmetric anyway. It is also why this is a POST: the
// exchange carries something now.
//
// What is handed over is a key minted for THAT box alone, never the file server's
// password: it reaches an app's declared folders read-only, and forgetting the box
// in Settings is what takes it back.
//
// The limit worth stating: this hands a credential to whoever answered the address
// the sweep found, and a four-digit code cannot be verified in that direction
// without revealing it. So a box that answers the pairing marker gets a key -
// which is why the key is per box, read-only, and revocable from the same screen
// that lists it.
const peers = require("../peers");

let issueHook = () => null;
let rememberHook = () => true;

// main.js owns the config and the shares server; this only asks for them.
function init({ issue, remember }) {
  if (issue) issueHook = issue;
  if (remember) rememberHook = remember;
}

const STR = {
  hu: {
    title: "tvbox - Box összekötése",
    body: "Ez a box éppen egy másik tvbox csatlakozására vár, hogy elérhessék egymás megosztott mappáit. A másik boxon add meg a képernyőn látható négyjegyű kódot.",
  },
  en: {
    title: "tvbox - Connect a box",
    body: "This box is waiting for another tvbox to connect so the two can read each other's shared folders. Enter the four-digit code shown on this screen on the other box.",
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
  // Gated by the pairing core: the four digits travel in the body, a wrong one is
  // refused there and counts towards its lockout.
  "POST /peer/credentials": (req, res, ctx) => {
    // Remembered by the address the request ARRIVED from, never one it sent: a box
    // does not get to say where it lives. A box that is offering nothing has no
    // credentials to send, and pairing with it is simply one-way.
    const from = peers.callerAddress(req);
    const theirs = peers.peerFrom(ctx.body, from);
    const mutual = !!(theirs && rememberHook(theirs));
    // Minted for THIS box, and only once the caller has passed the code: a key per
    // peer is what lets Settings take one back without breaking the others.
    const mine = issueHook({ id: theirs ? theirs.id : "", name: theirs ? theirs.name : "", host: from });
    // Handing the credential over ends this session: leaving the window open would
    // let a second box take a key off the same code.
    ctx.stopSoon(1000);
    if (!mine || !mine.token) return ctx.json(res, { error: "not_sharing", mutual });
    ctx.json(res, { id: mine.id, name: mine.name, port: mine.port, user: mine.user, token: mine.token, mutual });
  },
};

// Mint what this box hands a peer. Called by the pair ROUTE as well, so a key is
// issued the same way (and recorded the same way) whichever end of the exchange
// this box is on.
function issue(box) {
  return issueHook(box || {});
}

module.exports = { init, page, routes, issue, STR };
