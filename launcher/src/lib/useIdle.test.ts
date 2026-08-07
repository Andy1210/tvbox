import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { useIdle } from "./useIdle";

// The ambient screen arms itself on an idle timer, and the launcher window is
// hidden whenever another app holds the screen. The launcher's own view stays on
// Home throughout, so the caller's `suppressed` says nothing about it: only the
// document's visibility does. These pin that a hidden window never arms the
// overlay, which is what decides whether Home comes back as Home.

let hidden = false;
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
    // Coming back from an app has to land on Home, not on the overlay.
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
