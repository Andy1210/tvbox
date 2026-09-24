import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useArmedConfirm } from "./armedConfirm";
import { HEALED_KEY_EVENT } from "@sdk/focusGuard";

// A destructive press-twice action must take two separate presses.

function key(k: string, repeat = false) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, repeat }));
}

afterEach(() => vi.useRealTimers());

describe("useArmedConfirm", () => {
  it("arms on one press and confirms on a second, separate one", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useArmedConfirm());
    key("Enter");
    let done = false;
    act(() => void (done = result.current.press("x")));
    expect(done).toBe(false);
    expect(result.current.armed).toBe("x");
    act(() => void vi.advanceTimersByTime(600));
    key("Enter");
    act(() => void (done = result.current.press("x")));
    expect(done).toBe(true);
  });

  it("a held OK neither arms nor confirms", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useArmedConfirm());
    key("Enter", true);
    act(() => void result.current.press("x"));
    expect(result.current.armed).toBe(null);
    key("Enter");
    act(() => void result.current.press("x"));
    act(() => void vi.advanceTimersByTime(600));
    key("Enter", true);
    let done = true;
    act(() => void (done = result.current.press("x")));
    expect(done).toBe(false);
  });

  it("a second press too soon after the arm does not confirm", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useArmedConfirm());
    key("Enter");
    act(() => void result.current.press("x"));
    act(() => void vi.advanceTimersByTime(100));
    key("Enter");
    let done = true;
    act(() => void (done = result.current.press("x")));
    expect(done).toBe(false);
  });

  it("lets go after the timeout, and as soon as the cursor moves", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useArmedConfirm({ timeoutMs: 5000 }));
    key("Enter");
    act(() => void result.current.press("x"));
    act(() => void vi.advanceTimersByTime(5001));
    expect(result.current.armed).toBe(null);
    key("Enter");
    act(() => void result.current.press("x"));
    act(() => key("ArrowDown"));
    expect(result.current.armed).toBe(null);
  });

  it("lets go when the cursor was moved to heal a lost focus", () => {
    const { result } = renderHook(() => useArmedConfirm());
    key("Enter");
    act(() => void result.current.press("x"));
    expect(result.current.armed).toBe("x");
    act(() => void window.dispatchEvent(new CustomEvent(HEALED_KEY_EVENT, { detail: { key: "ArrowDown" } })));
    expect(result.current.armed).toBe(null);
  });
});
