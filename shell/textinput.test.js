// The typing session's rules, pinned. Every case here is a bug that was actually
// found in review: the screen coming back up over the app you were trying to reach,
// text landing in the wrong field, a pairing session someone else owned being torn
// down. The module is deps-injected, so no Electron and no window are needed.
const test = require("node:test");
const assert = require("node:assert");
const textinput = require("./textinput");

function harness(opts = {}) {
  const log = { shown: [], done: [], pairingStarts: 0, pairingStops: 0 };
  const wc = { isDestroyed: () => false, sent: [] };
  textinput.init({
    onShow: (st) => log.shown.push(st),
    onDone: (id) => log.done.push(id),
    pairingStart: () => {
      log.pairingStarts++;
      return { url: "http://192.168.1.5:8099/?c=4821", code: "4821" };
    },
    pairingStop: () => log.pairingStops++,
    isForeground: opts.isForeground || (() => true),
    typeText: (text) => wc.sent.push(text),
    // A box whose compositor replaces the field, which is what makes offering its
    // contents back safe. `canReplace: false` is its own case, further down.
    canReplace: opts.canReplace || (() => true),
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
  assert.deepStrictEqual(wc.sent, ["a@b.hu"]);
});

test("control characters never reach the app as keystrokes", async () => {
  const label = reset();
  const { wc } = harness();
  textinput.focused("xcloud", wc, { kind: "text", label });
  textinput.submit("hi\nthere\t!");
  await new Promise((res) => setTimeout(res, 500));
  // A newline would have been a real Enter (submitting a form the user didn't choose).
  assert.deepStrictEqual(wc.sent, ["hithere!"]);
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

test("the same field re-focusing after a submit does not reopen the screen", async () => {
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
  // Wait out the delivery beat before leaving: the string is dropped here (a newer
  // field took over), and a test that returns early would leak it into the next one.
  await new Promise((res) => setTimeout(res, 500));
  assert.deepStrictEqual(wc.sent, []);
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
  assert.strictEqual(wc.sent[0].length, textinput.MAX_TEXT);
});

// ---- what the keyboard opens ON -----------------------------------------------
// Delivery REPLACES the field, so a keyboard that opens empty means a field with
// anything in it can only be retyped from scratch - and its contents were never on
// screen to read in the first place. What may be offered is decided here rather than
// in the preload, because this is the module that knows how much it will type back.

test("the field's current text is what the keyboard opens on", () => {
  const label = reset();
  const { log, wc } = harness();
  textinput.focused("xcloud", wc, { kind: "email", label, value: "daniel@example.com" });
  assert.strictEqual(log.shown[0].value, "daniel@example.com");
  assert.strictEqual(textinput.status().value, "daniel@example.com");
});

test("a password's value is never offered, however it arrives", () => {
  const label = reset();
  const { log, wc } = harness();
  // The preload withholds it too; this is the second refusal, and it is the one that
  // matters - the value would go on to a phone page served over the LAN in clear.
  textinput.focused("xcloud", wc, { kind: "password", password: true, label, value: "hunter2" });
  assert.strictEqual(log.shown[0].value, "");
});

test("a field that turns into a password takes its value back out of the session", () => {
  const label = reset();
  const { wc } = harness();
  textinput.focused("xcloud", wc, { kind: "text", label, value: "visible" });
  // The same window, the same session: a sign-in step that swaps the input's type
  // under the user updates the live session rather than opening a new screen.
  textinput.focused("xcloud", wc, { kind: "password", password: true, label, value: "secret" });
  assert.strictEqual(textinput.status().value, "");
});

test("a value too long to type back is dropped whole, never truncated", () => {
  const label = reset();
  const { log, wc } = harness();
  // Truncating would be worse than not offering: the prefill would LOOK complete, and
  // submitting it replaces the field with the part that fit - destroying text that
  // was never on screen. An empty keyboard is the old behaviour, and it is honest.
  textinput.focused("xcloud", wc, { kind: "text", label, value: "x".repeat(textinput.MAX_TEXT + 1) });
  assert.strictEqual(log.shown[0].value, "");

  const label2 = reset();
  textinput.focused("xcloud", wc, { kind: "text", label: label2, value: "x".repeat(textinput.MAX_TEXT) });
  assert.strictEqual(textinput.status().value.length, textinput.MAX_TEXT);
});

test("control characters are stripped from the offered value", () => {
  const label = reset();
  const { log, wc } = harness();
  // They cannot survive delivery either (submit strips the same set), so offering one
  // would show the user a character the box will silently drop on the way back.
  const withControl = "a" + String.fromCharCode(1) + "bc" + String.fromCharCode(127) + "d";
  textinput.focused("xcloud", wc, { kind: "text", label, value: withControl });
  assert.strictEqual(log.shown[0].value, "abcd");
});

test("a field reporting no value at all still opens the keyboard", () => {
  const label = reset();
  const { log, wc } = harness();
  // An older app window - or any page whose field is simply empty - reports nothing
  // here, and an empty keyboard is exactly what should happen.
  textinput.focused("xcloud", wc, { kind: "text", label });
  assert.strictEqual(log.shown[0].active, true);
  assert.strictEqual(log.shown[0].value, "");
});

test("nothing is offered when delivery would only append", () => {
  const label = reset();
  // A compositor older than the one whose select-all chord carries its modifier.
  // Typing there appends, so handing the field's own text back would submit it
  // twice - the keyboard opens empty instead, exactly as it did before any of this.
  const { log, wc } = harness({ canReplace: () => false });
  textinput.focused("xcloud", wc, { kind: "email", label, value: "daniel@example.com" });
  assert.strictEqual(log.shown[0].value, "");
  assert.strictEqual(log.shown[0].active, true); // the keyboard still opens
});

test("bidi and zero-width characters never reach the screen", () => {
  const label = reset();
  const { log, wc } = harness();
  // The preload strips these too, but it runs in the RENDERER on text the page
  // wrote - so this side cannot lean on it. A right-to-left override makes the
  // prefill read as something other than what would be submitted.
  const sneaky = "abc" + String.fromCharCode(0x202e) + "def" + String.fromCharCode(0x200b);
  textinput.focused("xcloud", wc, { kind: "text", label, value: sneaky });
  assert.strictEqual(log.shown[0].value, "abcdef");
});

test("the invisible ones with no obvious range go too", () => {
  const label = reset();
  const { log, wc } = harness();
  // U+061C is a bidi control like the marks above it, and every one of its siblings
  // was already stripped - it is only unusual in sitting outside their block. The
  // C1 controls are the other half: they show nothing on a TV two metres away, so a
  // prefill carrying them reads as a shorter string than the one being submitted.
  const invisible =
    "a" +
    String.fromCharCode(0x061c) +
    "b" +
    String.fromCharCode(0x0085) + // NEL, in the middle of C1
    "c" +
    String.fromCharCode(0x009f); // the last of them
  textinput.focused("xcloud", wc, { kind: "text", label, value: invisible });
  assert.strictEqual(log.shown[0].value, "abc");
});
