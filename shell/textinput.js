// Typing into an app that has no keyboard.
//
// A TV has no keyboard, and a remote app (xbox.com's sign-in, a YouTube search
// box) is just a web page: focusing its <input> does nothing on its own. The
// remote preload reports "a field took focus", and this module runs the session
// that follows - the launcher shows a typing screen (its own on-screen keyboard
// for short things, plus a QR + code so a phone can type the long/secret ones),
// and whatever comes back is delivered to the page as REAL key events.
//
// Why key events and not DOM writes: sendInputEvent goes through the browser's
// input pipeline, so a React-controlled field sees exactly what a USB keyboard
// would, and it reaches the focused element wherever it is - including inside a
// cross-origin iframe the preload can't touch.
//
// One session at a time, owned by the app window that asked for it. If that
// window stops being the foreground app (Home, a switch, a crash), the session is
// dropped rather than delivered somewhere else.
const MAX_TEXT = 400; // a login/search field, not a document

let session = null; // { appId, wc, kind, password, label, url, code }
let lastEnded = null; // { appId, sig, at } - see the cooldown in focused()
const RETRIGGER_MS = 2500;
let deps = {
  // supplied by main.js
  onShow: () => {}, // bring the launcher's typing screen up
  onDone: () => {}, // put the app back in front
  pairingStart: () => null, // start the phone-typing pairing session -> { url, code }
  pairingStop: () => {},
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
    return;
  }
  // Putting the app window back in front can re-fire focusin on the field we just
  // typed into, which would open the typing screen again forever. Ignore only THAT
  // field for a moment - a different one (email -> password) still opens right away.
  const sig = (field.kind || "") + "|" + (field.label || "");
  if (lastEnded && lastEnded.appId === appId && lastEnded.sig === sig && Date.now() - lastEnded.at < RETRIGGER_MS) {
    return;
  }
  const pairing = deps.pairingStart() || {};
  session = {
    appId,
    wc,
    kind: String(field.kind || "text"),
    password: !!field.password,
    label: String(field.label || ""),
    url: pairing.url || "",
    code: pairing.code || "",
    sig,
  };
  console.log("[textinput] field focused in", appId, session.password ? "(password)" : "", session.label);
  deps.onShow(status());
}

function status() {
  if (!session) return { active: false };
  return {
    active: true,
    app: session.appId,
    kind: session.kind,
    password: session.password,
    label: session.label,
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
  const chars = String(text == null ? "" : text).slice(0, MAX_TEXT);
  deps.onDone(s.appId);
  if (!s.wc || s.wc.isDestroyed()) return { ok: false, error: "app window is gone" };
  // Give the compositor a beat to put the app window back in front before typing
  // into it - a field that isn't focused yet would swallow the first characters.
  setTimeout(() => {
    if (!s.wc || s.wc.isDestroyed()) return;
    for (const ch of chars) {
      try {
        s.wc.sendInputEvent({ type: "char", keyCode: ch });
      } catch (e) {
        break;
      }
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
  deps.pairingStop();
  deps.onDone(s.appId);
  console.log("[textinput] cancelled");
  return { ok: true };
}

// The foreground app changed / a window died: a pending session can no longer be
// delivered to the window that asked for it.
function dropFor(appId) {
  if (session && (appId == null || session.appId === appId)) {
    session = null;
    deps.pairingStop();
    console.log("[textinput] session dropped (app left the foreground)");
  }
}

module.exports = { init, focused, status, submit, cancel, dropFor, MAX_TEXT };
