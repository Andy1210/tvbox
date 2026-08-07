import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { useIdle } from "./useIdle";

// The ambient screen arms itself on an idle timer, and the launcher window is
// hidden whenever another app holds the screen. The launcher's own view stays on
// Home throughout, so the caller's `suppressed` says nothing about it: only the
// document's visibility does. These pin that a hidden window never arms the
// overlay, which is what decides whether Home comes back as Home.

let hidden = false;
// Keep whatever was there. happy-dom serves `hidden` off the prototype today, so
// there is no own property to put back and deleting ours is enough - but a runtime
// that defines it on the document itself would be left without one.
const ownHidden = Object.getOwnPropertyDescriptor(document, "hidden");
Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });

function setHidden(v: boolean) {
  hidden = v;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

// Reads the hook's state out of a render. Mutating during render is fine here:
// nothing else observes `seen`, and it saves threading state through a store.
function Probe({ suppressed, seen }: { suppressed: boolean; seen: boolean[] }) {
  const [idle] = useIdle(10000, suppressed);
  seen[0] = idle;
  return null;
}

function mount(suppressed = false) {
  const seen = [false];
  render(createElement(Probe, { suppressed, seen }));
  return seen;
}

beforeEach(() => {
  hidden = false;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
// vitest isolates each file's document, so this only matters if isolation is ever
// turned off - at which point a stuck `hidden` getter would quietly break every
// file that runs after this one.
afterAll(() => {
  if (ownHidden) Object.defineProperty(document, "hidden", ownHidden);
  else Reflect.deleteProperty(document, "hidden");
});

describe("useIdle", () => {
  it("arms once the idle time passes with the window visible", () => {
    const seen = mount();
    act(() => void vi.advanceTimersByTime(15000));
    expect(seen[0]).toBe(true);
  });

  it("never arms while the window is hidden", () => {
    hidden = true;
    const seen = mount();
    act(() => void vi.advanceTimersByTime(120000));
    expect(seen[0]).toBe(false);
  });

  it("does not arm behind an app and then fire on return", () => {
    const seen = mount();
    setHidden(true);
    act(() => void vi.advanceTimersByTime(120000));
    setHidden(false);
    act(() => void vi.advanceTimersByTime(5000));
    // Coming back from an app has to land on Home, not on the overlay.
    expect(seen[0]).toBe(false);
  });

  // A hidden renderer is throttled to about one wake a minute and frozen outright
  // after a while, so the interval's own hidden branch cannot be trusted to keep
  // the last-activity stamp fresh. Moving the clock without running the timers is
  // what that looks like from inside the hook, and it is the case that decides
  // whether the return edge has to reset the stamp.
  it("does not arm on return when the interval was throttled while hidden", () => {
    const seen = mount();
    setHidden(true);
    act(() => void vi.setSystemTime(Date.now() + 600000));
    setHidden(false);
    act(() => void vi.advanceTimersByTime(5000));
    expect(seen[0]).toBe(false);
  });

  it("clears an overlay that is already up when the window goes hidden", () => {
    const seen = mount();
    act(() => void vi.advanceTimersByTime(15000));
    expect(seen[0]).toBe(true);
    setHidden(true);
    expect(seen[0]).toBe(false);
  });

  it("still honours the caller's own suppression", () => {
    const seen = mount(true);
    act(() => void vi.advanceTimersByTime(120000));
    expect(seen[0]).toBe(false);
  });
});
