// Gamepad -> 10-foot UI navigation.
//
// The launcher is driven by DOM key events (the CEC/BT bridges emit arrows +
// Enter + Back as a virtual keyboard), but a game controller speaks the Gamepad
// API instead: no keys at all, so the UI never moved for it. This translates a
// pad into the same key events the rest of the UI already understands.
//
// Renderer-side ON PURPOSE, not in the input bridge: a bridge that turned pad
// events into arrow keys would ALSO fire them inside an app that speaks Gamepad
// natively (Xbox Cloud Gaming), double-navigating its menus. Here only windows
// that opt in translate, and a gamepad-native app keeps the pad to itself.
//
// Costs nothing when no pad is present: the polling loop starts on the first
// `gamepadconnected` and stops when the last pad goes away. requestAnimationFrame
// is throttled to a stop while a window is hidden, so a backgrounded app isn't
// polling either.
const REPEAT_FIRST_MS = 400; // hold a direction: pause before it starts repeating
const REPEAT_MS = 110;
const PRESS = 0.45; // stick deflection that counts as a direction
const RELEASE = 0.3; // and where it must fall back to before it can fire again

type KeySpec = { key: string; code: string; keyCode: number };
const KEYS: Record<string, KeySpec> = {
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  back: { key: "Backspace", code: "Backspace", keyCode: 8 },
};
const REPEATS = new Set(["up", "down", "left", "right"]); // A/B fire once per press

// Standard-mapping indices (Chromium normalises pads it recognises to this
// layout): 0=A, 1=B, 12..15 = D-pad up/down/left/right. A pad Chromium does NOT
// recognise reports mapping "" in raw HID order - for those we fall back to the
// two conventions that actually occur: A/B still come first, and the hat shows up
// as axes 6/7. Best effort by design; a recognised pad is exact.
const STANDARD_BUTTONS: Array<[number, string]> = [
  [12, "up"],
  [13, "down"],
  [14, "left"],
  [15, "right"],
  [0, "enter"],
  [1, "back"],
];
const RAW_BUTTONS: Array<[number, string]> = [
  [0, "enter"],
  [1, "back"],
];
const STICKS: Array<[number, number]> = [
  [0, 1], // left stick
  [6, 7], // where an unrecognised pad's hat tends to land
];

// Both `key` and the legacy `keyCode` are set: spatial-nav libraries read one or
// the other, and an event carrying only `key` silently does nothing in the ones
// that switch on keyCode.
function sendKey(spec: KeySpec) {
  const init = {
    key: spec.key,
    code: spec.code,
    keyCode: spec.keyCode,
    bubbles: true,
    cancelable: true,
  } as KeyboardEventInit;
  // The TARGET matters, not just the event: for an event dispatched AT window,
  // Chromium runs window listeners in registration order and ignores the capture
  // flag, so a screen that swallows keys in the capture phase (the screensaver, the
  // About panel's scroll handler) would run AFTER spatial-nav's bubble listener -
  // waking the ambient screen with A would also launch the focused tile. Dispatching
  // at the focused element gives the same order a real key has: window capture first.
  const target: EventTarget = document.activeElement || document.body || window;
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

let running = false;
let frame = 0;
const nextAt = new Map<string, number>(); // action -> when it may fire again
const stickHeld = new Set<string>(); // axis directions, with hysteresis
// pad index -> its axes at rest. An unrecognised pad's axes 6/7 are a hat on one
// device and analog pedals on another, and a pedal RESTS at -1.0 - indistinguishable
// from a hat held left unless we know where it started.
const rest = new Map<number, number[]>();

// Returns true when the action should fire now. A held direction repeats after
// REPEAT_FIRST_MS; a button (Infinity) fires once and re-arms on release.
function due(action: string, pressed: boolean, now: number) {
  if (!pressed) {
    nextAt.delete(action);
    return false;
  }
  const at = nextAt.get(action);
  if (at === undefined) {
    nextAt.set(action, REPEATS.has(action) ? now + REPEAT_FIRST_MS : Infinity);
    return true;
  }
  if (now < at) return false;
  nextAt.set(action, now + REPEAT_MS);
  return true;
}

function poll() {
  const pads = (navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean) as Gamepad[];
  if (!pads.length) {
    // Last pad unplugged: stop polling entirely rather than spin on an empty list.
    running = false;
    frame = 0;
    nextAt.clear();
    stickHeld.clear();
    rest.clear();
    return;
  }
  const now = performance.now();
  const held = new Set<string>();
  const defl: Record<string, number> = { up: 0, down: 0, left: 0, right: 0 };
  for (const pad of pads) {
    const buttons = pad.mapping === "standard" ? STANDARD_BUTTONS : RAW_BUTTONS;
    for (const [i, action] of buttons) if (pad.buttons[i]?.pressed) held.add(action);
    if (!rest.has(pad.index)) rest.set(pad.index, pad.axes.slice());
    const zero = rest.get(pad.index) as number[];
    for (const [xi, yi] of STICKS) {
      // Relative to rest for the ambiguous pair, absolute for the left stick (whose
      // centre is 0 by definition in the Gamepad API).
      const base = xi === 0 ? 0 : 1;
      const x = (pad.axes[xi] ?? 0) - base * (zero[xi] ?? 0);
      const y = (pad.axes[yi] ?? 0) - base * (zero[yi] ?? 0);
      // Strongest deflection per direction across every pad and axis pair. Taking
      // the max FIRST matters: applying hysteresis per pair let a centred hat
      // cancel a deflected stick (whichever pair happened to be read last won).
      defl.left = Math.max(defl.left, -x);
      defl.right = Math.max(defl.right, x);
      defl.up = Math.max(defl.up, -y);
      defl.down = Math.max(defl.down, y);
    }
  }
  for (const action of Object.keys(defl)) hold(action, defl[action]);
  for (const action of stickHeld) held.add(action);
  for (const action of Object.keys(KEYS)) if (due(action, held.has(action), now)) sendKey(KEYS[action]);
  frame = requestAnimationFrame(poll);
}

// Between RELEASE and PRESS the previous state stands - that band is what keeps a
// stick resting near the threshold from stuttering.
function hold(action: string, deflection: number) {
  if (deflection >= PRESS) stickHeld.add(action);
  else if (deflection < RELEASE) stickHeld.delete(action);
}

function stop() {
  if (frame) cancelAnimationFrame(frame);
  running = false;
  frame = 0;
  nextAt.clear();
  stickHeld.clear();
}

function start() {
  if (running || document.visibilityState === "hidden") return;
  running = true;
  frame = requestAnimationFrame(poll);
}

// rAF is throttled to a stop in a hidden window, but "throttled by the browser" is a
// promise we don't have to rely on - stop for real, and pick up again when the window
// is visible and a pad is still there. Idle heat and power are the point.
function onVisibility() {
  if (document.visibilityState === "hidden") stop();
  else if (navigator.getGamepads && navigator.getGamepads().some(Boolean)) start();
}

// Call once at startup (the launcher does it in main.tsx). Returns a teardown for
// tests / hot reload.
export function startGamepadNav(): () => void {
  const onConnect = (e: Event) => {
    const pad = (e as GamepadEvent).gamepad;
    // One line per pad, in ~/.tvbox/shell.log via the shell's console-message
    // forwarding. `mapping` is the field that matters when an app rejects a pad:
    // "standard" = Chromium recognised it, "" = raw HID order.
    console.log(
      `[gamepad] connected: "${pad.id}" mapping="${pad.mapping}" buttons=${pad.buttons.length} axes=${pad.axes.length}`,
    );
    start();
  };
  window.addEventListener("gamepadconnected", onConnect);
  document.addEventListener("visibilitychange", onVisibility);
  // A pad already active before this ran (page reload) never re-fires
  // gamepadconnected, so check once.
  if (navigator.getGamepads && navigator.getGamepads().some(Boolean)) start();
  return () => {
    window.removeEventListener("gamepadconnected", onConnect);
    document.removeEventListener("visibilitychange", onVisibility);
    stop();
    rest.clear();
  };
}
