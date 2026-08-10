// The answering half of a pairing: the box showing the code.
//
// The client half lives in peers.test.js. This one matters for a different reason:
// it is where a stranger's claim about itself is turned into a stored peer, and
// where this box's key leaves it.
const test = require("node:test");
const assert = require("node:assert");

const peer = require("./peer");

function ask(body, opts) {
  const o = opts || {};
  let answered = null;
  let stopped = 0;
  peer.init({
    issue: o.issue || (() => ({ id: "tvbox-livingroom", name: "livingroom", port: 8096, user: "box-a1", token: "k" })),
    remember: o.remember || (() => true),
  });
  const req = { socket: { remoteAddress: o.from || "::ffff:192.168.1.7" } };
  const ctx = {
    body,
    json: (_res, obj) => (answered = obj),
    stopSoon: () => stopped++,
  };
  peer.routes["POST /peer/credentials"](req, {}, ctx);
  return { answered, stopped };
}

const theirs = { id: "tvbox-gaming", name: "gaming", port: 8096, user: "box-b2", token: "theirs" };

test("one code pairs both ways: the caller is remembered and gets a key back", () => {
  let remembered = null;
  const r = ask(theirs, { remember: (p) => ((remembered = p), true) });
  assert.equal(remembered.id, "tvbox-gaming");
  assert.equal(remembered.host, "192.168.1.7", "the address it called from, never one it sent");
  assert.equal(r.answered.token, "k");
  assert.equal(r.answered.user, "box-a1", "the name that key was minted under");
  assert.equal(r.answered.mutual, true);
});

test("a box that says it lives somewhere else is still remembered where it called from", () => {
  let remembered = null;
  ask({ ...theirs, host: "10.0.0.9" }, { remember: (p) => ((remembered = p), true) });
  assert.equal(remembered.host, "192.168.1.7");
});

test("a caller this box refuses to remember gets no key either", () => {
  // Refusing happens for a reason the caller cannot fix by asking again - a name
  // that already belongs to another box, an address off this subnet. A key is
  // recorded under the id the caller CLAIMED, so handing one over anyway would let
  // a refused caller replace the key belonging to the box it was imitating.
  let issued = 0;
  const r = ask(theirs, { remember: () => false, issue: () => (issued++, { token: "k" }) });
  assert.deepStrictEqual(r.answered, { error: "refused", mutual: false });
  assert.equal(issued, 0, "nothing may be minted for a caller that was turned down");
  assert.equal(r.stopped, 1, "and the code is spent either way");
});

test("a caller with nothing of its own to offer is still given a key", () => {
  // That is a one-way pairing, not a refused one: this box can be read from there,
  // and the screen says which of the two happened.
  const r = ask({ name: "gaming" }, { remember: () => false });
  assert.equal(r.answered.token, "k");
  assert.equal(r.answered.mutual, false);
});

test("a box that offers nothing hands out no key", () => {
  const r = ask(theirs, { issue: () => null });
  assert.deepStrictEqual(r.answered, { error: "not_sharing", mutual: true });
  assert.equal(r.stopped, 1, "and the window still closes: the code has been used");
});

test("the code buys exactly one exchange", () => {
  const r = ask(theirs);
  assert.equal(r.stopped, 1, "leaving it open would let a second box take a key off the same code");
});

test("the page carries the marker the other box sweeps for", () => {
  const html = peer.page({ locale: "hu" });
  assert.ok(html.includes("tvbox-peer-pairing"));
  assert.ok(html.includes("tvbox"), "and says what it is to a person who opens it");
});
