// The typing session's rules, pinned. Every case here is a bug that was actually
// found in review: the screen coming back up over the app you were trying to reach,
// text landing in the wrong field, a pairing session someone else owned being torn
// down. The module is deps-injected, so no Electron and no window are needed.
const test = require("node:test");
const assert = require("node:assert");
const textinput = require("./textinput");

function harness(opts = {}) {
  const log = { shown: [], done: [], pairingStarts: 0, pairingStops: 0 };
  const wc = {
    isDestroyed: () => false,
    sent: [],
    sendInputEvent(ev) {
      wc.sent.push(ev.type === "char" ? ev.keyCode : ev.type + ":" + ev.keyCode);
    },
  };
  textinput.init({
    onShow: (st) => log.shown.push(st),
    onDone: (id) => log.done.push(id),
    pairingStart: () => {
      log.pairingStarts++;
      return { url: "http://192.168.1.5:8099/?c=4821", code: "4821" };
    },
    pairingStop: () => log.pairingStops++,
    isForeground: opts.isForeground || (() => true),
  });
  return { log, wc };
}

// Each test starts from a clean session. The module is a singleton with a TIME-based
// re-open guard (a field that just ended can't immediately reopen the screen), so tests
// must not share a field signature either - hence the counter.
let n = 0;
function reset() {
  textinput.cancel();
  textinput.dropFor(null);
  return "field-" + ++n;
}

test("a focused field opens the screen once, and re-reporting it does not", () => {
  reset();
  const { log, wc } = harness();
  textinput.focused("xcloud", wc, { kind: "email", label: "E-mail" });
  textinput.focused("xcloud", wc, { kind: "email", label: "E-mail" });
  assert.strictEqual(log.shown.length, 1);
  assert.strictEqual(log.shown[0].app, "xcloud");
  assert.strictEqual(log.shown[0].label, "E-mail");
});

test("the phone/QR is armed only when asked for - never by a page focusing a field", () => {
  const label = reset();
  const { log, wc } = harness();
  textinput.focused("xcloud", wc, { kind: "text", label });
  assert.strictEqual(log.pairingStarts, 0); // no LAN server, no code minted
  assert.strictEqual(textinput.status().url, "");
  const armed = textinput.startPhone();
  assert.strictEqual(log.pairingStarts, 1);
  assert.strictEqual(armed.code, "4821");
  assert.strictEqual(textinput.status().code, "4821");
});

test("a pairing session we did NOT start is never stopped", () => {
  const label = reset();
  const { log, wc } = harness();
  textinput.focused("xcloud", wc, { kind: "text", label });
  textinput.cancel(); // never armed the phone
  assert.strictEqual(log.pairingStops, 0); // a photos/backup transfer stays alive
  textinput.focused("xcloud", wc, { kind: "text", label: label + "-b" });
  textinput.startPhone();
  textinput.cancel();
  assert.strictEqual(log.pairingStops, 1);
});

test("submitted text replaces the field and arrives as characters", async () => {
  reset();
  const { wc } = harness();
  textinput.focused("xcloud", wc, { kind: "email", label: "E-mail" });
  const r = textinput.submit("a@b.hu");
  assert.deepStrictEqual(r, { ok: true, length: 6 });
  await new Promise((res) => setTimeout(res, 500)); // the delivery beat
  assert.strictEqual(wc.sent[0], "keyDown:a"); // select-all first, so nothing is appended
  assert.strictEqual(wc.sent.slice(2).join(""), "a@b.hu");
});

test("control characters never reach the app as keystrokes", async () => {
  const label = reset();
  const { wc } = harness();
  textinput.focused("xcloud", wc, { kind: "text", label });
  textinput.submit("hi\nthere\t!");
  await new Promise((res) => setTimeout(res, 500));
  // A newline would have been a real Enter (submitting a form the user didn't choose).
  assert.strictEqual(wc.sent.slice(2).join(""), "hithere!");
});

test("nothing is typed if the app left the foreground during the handshake", async () => {
  const label = reset();
  let fg = true;
  const { wc } = harness({ isForeground: () => fg });
  textinput.focused("xcloud", wc, { kind: "text", label });
  textinput.submit("hello");
  fg = false; // user pressed Home while we waited for the window to come back
  await new Promise((res) => setTimeout(res, 500));
  assert.deepStrictEqual(wc.sent, []);
});

test("a newer field on the same window cancels a pending delivery", async () => {
  reset();
  const { wc } = harness();
  textinput.focused("xcloud", wc, { kind: "email", label: "E-mail" });
  textinput.submit("user@example.com");
  // The sign-in page auto-advances to the password field inside the delivery beat.
  textinput.focused("xcloud", wc, { kind: "password", password: true, label: "Password" });
  await new Promise((res) => setTimeout(res, 500));
  // Without the guard the e-mail would be typed into the password field.
  assert.deepStrictEqual(wc.sent, []);
});

test("the same field re-focusing after a submit does not reopen the screen", () => {
  reset();
  const { log, wc } = harness();
  textinput.focused("xcloud", wc, { kind: "email", label: "E-mail" });
  textinput.submit("x@y.z");
  // Showing the app again re-fires focusin on the field we just typed into.
  textinput.focused("xcloud", wc, { kind: "email", label: "E-mail" });
  assert.strictEqual(log.shown.length, 1);
  // …but a DIFFERENT field opens it immediately.
  textinput.focused("xcloud", wc, { kind: "password", password: true, label: "Password" });
  assert.strictEqual(log.shown.length, 2);
  assert.strictEqual(log.shown[1].password, true);
});

test("a dropped session also blocks the immediate re-open (resuming the app must work)", () => {
  const label = reset();
  const { log, wc } = harness();
  textinput.focused("xcloud", wc, { kind: "text", label });
  textinput.dropFor("xcloud"); // Home, an app switch, a popup closing
  assert.strictEqual(textinput.status().active, false);
  textinput.focused("xcloud", wc, { kind: "text", label });
  assert.strictEqual(log.shown.length, 1); // not bounced straight back to the keyboard
});

test("cancel and submit answer honestly when there is no session", () => {
  reset();
  harness();
  assert.deepStrictEqual(textinput.cancel(), { ok: true });
  assert.strictEqual(textinput.submit("x").ok, false);
  assert.strictEqual(textinput.startPhone().ok, false);
  assert.deepStrictEqual(textinput.status(), { active: false });
});

test("a destroyed window can't be typed into", async () => {
  const label = reset();
  const { wc } = harness();
  textinput.focused("xcloud", wc, { kind: "text", label });
  wc.isDestroyed = () => true;
  const r = textinput.submit("hello");
  assert.strictEqual(r.ok, false);
  await new Promise((res) => setTimeout(res, 500));
  assert.deepStrictEqual(wc.sent, []);
});

test("MAX_TEXT is enforced", async () => {
  const label = reset();
  const { wc } = harness();
  textinput.focused("xcloud", wc, { kind: "text", label });
  const r = textinput.submit("x".repeat(textinput.MAX_TEXT + 50));
  assert.strictEqual(r.length, textinput.MAX_TEXT);
  await new Promise((res) => setTimeout(res, 500));
  assert.strictEqual(wc.sent.length, 2 + textinput.MAX_TEXT); // + the select-all pair
});
