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
let frames: FrameRequestCallback[] = [];
let keys: string[] = [];
let now = 0;
let stop: (() => void) | null = null;
// Named, so afterEach can remove it: a listener left behind per test would count
// every key once per accumulated listener.
const collect = (e: KeyboardEvent) => keys.push(e.key);

function tick(advanceMs = 16) {
  now += advanceMs;
  const run = frames;
  frames = [];
  for (const f of run) f(now);
}

beforeEach(() => {
  pads = [];
  frames = [];
  keys = [];
  now = 1000;
  (navigator as unknown as { getGamepads: () => (Gamepad | null)[] }).getGamepads = () => pads;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
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
  expect(frames.length).toBe(0); // no polling loop, no idle cost
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
  (p.axes as number[])[7] = 1; // hat down, where raw HID pads report it
  tick();
  expect(keys).toEqual(["ArrowDown"]);
});

it("stops polling when the last pad goes away", () => {
  pads = [pad()];
  begin();
  tick();
  expect(frames.length).toBe(1);
  pads = [];
  tick();
  expect(frames.length).toBe(0);
});
