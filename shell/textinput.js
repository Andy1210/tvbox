// Typing into an app that has no keyboard.
//
// A TV has no keyboard, and a remote app (xbox.com's sign-in, a YouTube search
// box) is just a web page: focusing its <input> does nothing on its own. The
// remote preload reports "a field took focus", and this module runs the session
// that follows - the launcher shows a typing screen (its own on-screen keyboard
// for short things, plus a QR + code so a phone can type the long/secret ones),
// and whatever comes back is delivered to the page as REAL key events.
//
// Why key events and not DOM writes: they go through the browser's input pipeline,
// so a React-controlled field sees exactly what a USB keyboard would, and they
// reach the focused element wherever it is - including inside a cross-origin iframe
// the preload can't touch. (DELIVERY reaches an iframe; the TRIGGER does not - the
// preload runs in the main frame only, so a field inside an iframe never reports
// focus and the screen has to be opened from a top-level one.) The compositor sends
// them, which is also what lets a native program be typed into.
//
// One session at a time, owned by the app window that asked for it. If that
// window stops being the foreground app (Home, a switch, a crash), the session is
// dropped rather than delivered somewhere else.
const MAX_TEXT = 400; // a login/search field, not a document

// What the field already holds, offered to the keyboard so it opens ON the text
// rather than empty. Delivery REPLACES the field (see submit), so without this a
// field with anything in it could only be retyped from scratch.
//
// Everything that can go wrong with that is decided here, and each rule is a way it
// could do harm:
//
//   - Never a password. The preload withholds that value and this refuses it a
//     second time, because the session's own flag is what the phone page - served
//     over the LAN in clear - keys off.
//   - Never unless delivery actually REPLACES. `canReplace` asks the RUNNING
//     compositor, not the installed one: on a build whose select-all chord loses its
//     modifier, typing appends, so offering the field's own text back would submit
//     it twice. It fails closed, and a box that answers no simply gets the empty
//     keyboard it had before.
//   - Never TRUNCATED. A value longer than we will type back is dropped whole: a
//     prefill silently cut short looks complete, and submitting it would replace the
//     field with the part that fit and destroy text the user never saw.
//
// The strip is the preload's, repeated. That one runs in the RENDERER, on text the
// page wrote, so it is not a guarantee this side may lean on - and a bidi override
// or a zero-width character reaching the TV and the phone page makes the text read
// as something other than what it is.
function offerableValue(text, password) {
  if (password || !deps.canReplace()) return "";
  const value = String(text == null ? "" : text).replace(
    /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
  return value.length > MAX_TEXT ? "" : value;
}

let session = null; // { appId, wc, kind, password, label, value, url, code }
let lastEnded = null; // { appId, sig, at } - see the cooldown in focused()
let ourPairing = false; // did WE start the pairing session? (photos/backup share it)
const RETRIGGER_MS = 2500;
let deps = {
  // supplied by main.js
  onShow: () => {}, // bring the launcher's typing screen up
  onDone: () => {}, // put the app back in front
  pairingStart: () => null, // start the phone-typing pairing session -> { url, code }
  pairingStop: () => {},
  isForeground: () => true, // is this app still the one on screen?
  typeText: () => {}, // deliver the string to whatever holds the keyboard
  // Does delivery REPLACE the field, or only append to it? Fails closed: with no
  // answer the keyboard opens empty, which is what it always did.
  canReplace: () => false,
};

function init(d) {
  deps = { ...deps, ...d };
}

// The preload reports every focusin; a field re-focusing itself (or a page that
// moves focus between two inputs) must not restart the flow under the user.
function focused(appId, wc, field) {
  if (!appId || !wc || wc.isDestroyed()) return;
  if (session && session.appId === appId && session.wc === wc) {
    session.kind = field.kind;
    session.password = !!field.password;
    session.label = field.label || session.label;
    // Re-read through the flag we just set, so a field that turns into a password
    // one under us takes its value back out of the session with it.
    session.value = offerableValue(field.value, session.password);
    return;
  }
  // Putting the app window back in front can re-fire focusin on the field we just
  // typed into, which would open the typing screen again forever. Ignore only THAT
  // field for a moment - a different one (email -> password) still opens right away.
  const sig = (field.kind || "") + "|" + (field.label || "");
  if (lastEnded && lastEnded.appId === appId && lastEnded.sig === sig && Date.now() - lastEnded.at < RETRIGGER_MS) {
    return;
  }
  session = {
    appId,
    wc,
    kind: String(field.kind || "text"),
    password: !!field.password,
    label: String(field.label || ""),
    value: offerableValue(field.value, !!field.password),
    // No pairing session yet: starting one opens a LAN server, mints a code and
    // resets its lockout counter, so it waits for the user to ask for the phone
    // (startPhone) instead of happening because a page focused a field.
    url: "",
    code: "",
    sig,
  };
  console.log("[textinput] field focused in", appId, session.password ? "(password)" : "", session.label);
  deps.onShow(status());
}

// "I want to type on my phone": NOW the pairing session starts. Explicit user
// action, so it can also legitimately replace another pairing session.
function startPhone() {
  if (!session) return { ok: false, error: "no typing session" };
  if (!session.url) {
    const p = deps.pairingStart() || {};
    session.url = p.url || "";
    session.code = p.code || "";
    ourPairing = !!session.url;
    console.log("[textinput] phone typing armed");
  }
  return { ok: true, url: session.url, code: session.code };
}

// Only ever stop a pairing session WE started: photos/backup share the one server, and
// tearing theirs down from here would kill a transfer the user is in the middle of.
function stopPairing() {
  if (!ourPairing) return;
  ourPairing = false;
  deps.pairingStop();
}

function status() {
  if (!session) return { active: false };
  return {
    active: true,
    app: session.appId,
    kind: session.kind,
    password: session.password,
    label: session.label,
    value: session.value,
    url: session.url,
    code: session.code,
  };
}

// Deliver the text as keystrokes, then hand the screen back to the app. `submit`
// is what both input paths (the on-screen keyboard and the phone page) call.
function submit(text) {
  if (!session) return { ok: false, error: "no typing session" };
  const s = session;
  session = null;
  lastEnded = { appId: s.appId, sig: s.sig, at: Date.now() };
  deps.pairingStop();
  // C0 controls out: a submitted "\n" would arrive as a real Enter (submitting a
  // form the user never chose to submit) and "\t" would move focus mid-typing.
  const chars = String(text == null ? "" : text)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_TEXT);
  deps.onDone(s.appId);
  if (!s.wc || s.wc.isDestroyed()) return { ok: false, error: "app window is gone" };
  // Give the compositor a beat to put the app window back in front before typing
  // into it - a field that isn't focused yet would swallow the first characters.
  setTimeout(() => {
    if (!s.wc || s.wc.isDestroyed()) return;
    // A NEW session for the same window can start inside this beat - a sign-in page
    // that auto-advances email -> password does exactly that. Delivering now would
    // type the previous field's text into the new one (the email into the password).
    if (session && session.wc === s.wc) {
      console.log("[textinput] dropped", chars.length, "chars - a newer field took over");
      return;
    }
    // The user may have pressed Home during the beat we waited: typing into a window
    // that is no longer in front is at best invisible and at worst a surprise later.
    if (!deps.isForeground(s.appId)) {
      console.log("[textinput] dropped", chars.length, "chars - the app left the foreground");
      return;
    }
    // Replacing, not appending: the field usually already holds something (a
    // prefilled email, the last search, or the typo being corrected), and appending
    // produced concatenated garbage the user couldn't even see in a password field.
    // The compositor outlives the shell, so its socket can be gone while this
    // process runs. A failure here is one feature not working, and it must not be
    // more than that: a throw inside a timer has nothing above it to catch it.
    try {
      deps.typeText(chars);
    } catch (e) {
      console.warn("[textinput] typing failed:", e.message);
    }
  }, 400);
  console.log("[textinput] typed", chars.length, "chars into", s.appId);
  return { ok: true, length: chars.length };
}

function cancel() {
  if (!session) return { ok: true };
  const s = session;
  session = null;
  lastEnded = { appId: s.appId, sig: s.sig, at: Date.now() };
  stopPairing();
  deps.onDone(s.appId);
  console.log("[textinput] cancelled");
  return { ok: true };
}

// The foreground app changed / a window died: a pending session can no longer be
// delivered to the window that asked for it.
function dropFor(appId) {
  if (session && (appId == null || session.appId === appId)) {
    // Record it like a submit/cancel would: showing the app again re-fires focusin on
    // the field that is still focused, and without this the screen came straight back
    // up - the user could never get INTO the app.
    lastEnded = { appId: session.appId, sig: session.sig, at: Date.now() };
    session = null;
    stopPairing();
    console.log("[textinput] session dropped (app left the foreground)");
  }
}

module.exports = { init, focused, status, submit, cancel, dropFor, startPhone, MAX_TEXT };
