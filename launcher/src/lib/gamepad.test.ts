import { startGamepadNav } from "@sdk/gamepad";

// The pad -> key translation, driven by a fake pad and a manual frame clock.
// happy-dom has no gamepads and no real rAF timing, so both are stubbed: `frames`
// collects the scheduled callbacks and `tick()` runs one, which is exactly the
// granularity the repeat logic works at.
// Mutable stand-in for GamepadButton: the tests flip `pressed` between frames,
// which the real readonly type doesn't allow.
type Btn = { pressed: boolean; touched: boolean; value: number };
function pad(over: Partial<Gamepad> = {}): Gamepad {
  return {
    id: "Test Pad",
    index: 0,
    connected: true,
    mapping: "standard",
    timestamp: 0,
    axes: [0, 0, 0, 0, 0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({
      pressed: false,
      touched: false,
      value: 0,
    })) as Btn[] as Gamepad["buttons"],
    ...over,
  } as Gamepad;
}

let pads: (Gamepad | null)[] = [];
// A real fake clock: cancelAnimationFrame must actually cancel, otherwise "the loop
// stopped" is untestable - a no-op stub leaves the queued callback and the next tick
// reschedules it, which is exactly what hid the missing stop.
let frameId = 0;
const scheduled = new Map<number, FrameRequestCallback>();
let keys: string[] = [];
let now = 0;
let stop: (() => void) | null = null;
// Named, so afterEach can remove it: a listener left behind per test would count
// every key once per accumulated listener.
const collect = (e: KeyboardEvent) => keys.push(e.key);

function tick(advanceMs = 16) {
  now += advanceMs;
  const run = [...scheduled.values()];
  scheduled.clear();
  for (const f of run) f(now);
}
const pending = () => scheduled.size;

beforeEach(() => {
  pads = [];
  scheduled.clear();
  frameId = 0;
  keys = [];
  now = 1000;
  (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => pads;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++frameId;
    scheduled.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => scheduled.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  window.addEventListener("keydown", collect);
});
afterEach(() => {
  window.removeEventListener("keydown", collect);
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A pad already connected when the launcher starts never fires
// gamepadconnected, which is the common case after a shell restart.
function begin() {
  stop = startGamepadNav();
}

it("does nothing at all until a pad exists", () => {
  begin();
  expect(pending()).toBe(0); // no polling loop, no idle cost
});

it("D-pad buttons become arrow keys", () => {
  const p = pad();
  pads = [p];
  begin();
  (p.buttons[13] as Btn).pressed = true; // down
  tick();
  expect(keys).toEqual(["ArrowDown"]);
});

it("A is Enter and B is Back, once per press", () => {
  const p = pad();
  pads = [p];
  begin();
  (p.buttons[0] as Btn).pressed = true;
  tick();
  tick();
  tick(); // still held
  expect(keys).toEqual(["Enter"]); // a button must not auto-repeat
  (p.buttons[0] as Btn).pressed = false;
  (p.buttons[1] as Btn).pressed = true;
  tick();
  expect(keys).toEqual(["Enter", "Backspace"]);
});

it("a held direction repeats, but only after the initial delay", () => {
  const p = pad();
  pads = [p];
  begin();
  (p.buttons[15] as Btn).pressed = true; // right
  tick();
  expect(keys).toEqual(["ArrowRight"]);
  tick(200); // inside the 400ms pause
  expect(keys).toEqual(["ArrowRight"]);
  tick(250); // past it
  expect(keys).toEqual(["ArrowRight", "ArrowRight"]);
  tick(120);
  expect(keys.length).toBe(3);
});

it("the left stick moves focus and holds inside the deadzone band", () => {
  const p = pad({ axes: [0, 0, 0, 0, 0, 0, 0, 0] });
  pads = [p];
  begin();
  (p.axes as number[])[1] = 0.9; // stick down
  tick();
  expect(keys).toEqual(["ArrowDown"]);
  (p.axes as number[])[1] = 0.35; // released into the hysteresis band: still held
  tick(600);
  expect(keys).toEqual(["ArrowDown", "ArrowDown"]); // repeat continues
  (p.axes as number[])[1] = 0.1; // properly centred
  tick();
  const after = keys.length;
  tick(600);
  expect(keys.length).toBe(after); // nothing while centred
});

it("an unrecognised pad still navigates via its hat axes", () => {
  const p = pad({ mapping: "" as Gamepad["mapping"] });
  pads = [p];
  begin();
  (p.buttons[13] as Btn).pressed = true; // standard-layout index means nothing here
  tick(); // first frame samples where the axes REST
  (p.axes as number[])[7] = 1; // hat down, where raw HID pads report it
  tick();
  expect(keys).toEqual(["ArrowDown"]);
});

it("axes that REST off-centre (analog pedals) don't navigate on their own", () => {
  // The trap this guards: on some unrecognised pads axes 6/7 are a hat, on others
  // they are pedals - and a pedal reports -1.0 at rest, which used to read as "left
  // and up held" and auto-repeated forever with nobody touching the pad.
  const p = pad({ mapping: "" as Gamepad["mapping"], axes: [0, 0, 0, 0, 0, 0, -1, -1] });
  pads = [p];
  begin();
  tick();
  tick(600);
  expect(keys).toEqual([]);
  // …and the same axes still work once they actually move.
  (p.axes as number[])[6] = 1;
  tick();
  expect(keys).toEqual(["ArrowRight"]);
});

it("stops polling while the window is hidden, and resumes when it comes back", () => {
  pads = [pad()];
  begin();
  tick();
  expect(pending()).toBe(1);
  // A hidden window is a backgrounded app: no polling at all, not "throttled".
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  tick();
  expect(pending()).toBe(0);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(pending()).toBe(1);
});

it("stops polling when the last pad goes away", () => {
  pads = [pad()];
  begin();
  tick();
  expect(pending()).toBe(1);
  pads = [];
  tick();
  expect(pending()).toBe(0);
});

it("a button still held when navigation STARTS fires nothing until it is released", () => {
  // Stopping and starting this is the sanctioned way to hand a pad to a game, so
  // it happens whenever an app takes the pad back for a screen of its own - and
  // the press that got there is usually still down.
  //
  // Measured on the box: A launches a cloud game, the stream screen asks for the
  // pad back, and A - still held - was replayed as Enter onto the freshly focused
  // Leave button. The game started and quit in the same instant, and the press
  // carried on into the screen behind it.
  const p = pad();
  (p.buttons as unknown as Btn[])[0].pressed = true; // A, already down
  pads = [p];
  begin();
  tick();
  tick(600); // long enough for a repeat, had it been treated as a press
  expect(keys).toEqual([]);

  // Released and pressed again is an ordinary press.
  (p.buttons as unknown as Btn[])[0].pressed = false;
  tick();
  (p.buttons as unknown as Btn[])[0].pressed = true;
  tick();
  expect(keys).toEqual(["Enter"]);
});

it("a direction held across a restart does not start repeating on its own", () => {
  const p = pad();
  (p.buttons as unknown as Btn[])[14].pressed = true; // D-pad left
  pads = [p];
  begin();
  tick();
  tick(600);
  tick(600);
  expect(keys).toEqual([]);
});

it("adopting what is held does not deafen the OTHER buttons", () => {
  const p = pad();
  (p.buttons as unknown as Btn[])[0].pressed = true; // A held from before
  pads = [p];
  begin();
  tick();
  (p.buttons as unknown as Btn[])[1].pressed = true; // B pressed now
  tick();
  expect(keys).toEqual(["Backspace"]);
});
