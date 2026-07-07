import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { PinPad } from "./PinPad";
import { setupRemote, placeGrid, remote, setFocus, getCurrentFocusKey } from "../test/remote";

// The parental PIN pad: a D-pad-driven modal that auto-submits at 4 digits. These
// drive it the way the remote does - arrow to a digit, OK to enter it - and check
// the submitted value, the delete key, auto-focus, and remote-Back cancel.

setupRemote();

// The 3x4 keypad: 1-9, then delete / 0 / (blank).
function layout(getByText: (t: string) => HTMLElement) {
  placeGrid([
    [getByText("1"), getByText("2"), getByText("3")],
    [getByText("4"), getByText("5"), getByText("6")],
    [getByText("7"), getByText("8"), getByText("9")],
    [getByText("⌫"), getByText("0"), null],
  ]);
}

describe("PinPad", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("auto-focuses the first digit on open", () => {
    const { getByText } = render(<PinPad title="PIN" onSubmit={() => {}} onCancel={() => {}} />);
    layout(getByText);
    act(() => vi.runOnlyPendingTimers()); // the modal's deferred setFocus
    expect(getCurrentFocusKey()).toBe("pin-1");
  });

  it("enters a 4-digit PIN with the arrows and auto-submits", () => {
    const onSubmit = vi.fn();
    const { getByText } = render(<PinPad title="PIN" onSubmit={onSubmit} onCancel={() => {}} />);
    layout(getByText);
    act(() => setFocus("pin-1"));
    remote.ok(); // 1
    remote.right();
    remote.ok(); // 2
    remote.right();
    remote.ok(); // 3
    remote.down();
    remote.ok(); // 6  -> "1236", 4 digits
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("1236");
  });

  it("delete removes the last digit before submit", () => {
    const onSubmit = vi.fn();
    const { getByText } = render(<PinPad title="PIN" onSubmit={onSubmit} onCancel={() => {}} />);
    layout(getByText);
    act(() => setFocus("pin-1"));
    remote.ok(); // "1"
    act(() => setFocus("pin-2"));
    remote.ok(); // "12"
    act(() => setFocus("pin-del"));
    remote.ok(); // "1"  (2 deleted)
    act(() => setFocus("pin-3"));
    remote.ok(); // "13"
    act(() => setFocus("pin-4"));
    remote.ok(); // "134"
    act(() => setFocus("pin-5"));
    remote.ok(); // "1345" -> submit
    expect(onSubmit).toHaveBeenCalledWith("1345");
  });

  it("does not submit before the 4th digit", () => {
    const onSubmit = vi.fn();
    const { getByText } = render(<PinPad title="PIN" onSubmit={onSubmit} onCancel={() => {}} />);
    layout(getByText);
    act(() => setFocus("pin-1"));
    remote.ok();
    remote.ok(); // OK on the same key twice -> "11" (2 digits)
    remote.right();
    remote.ok(); // "112"
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("remote Back cancels", () => {
    const onCancel = vi.fn();
    const { getByText } = render(<PinPad title="PIN" onSubmit={() => {}} onCancel={onCancel} />);
    layout(getByText);
    remote.back();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows an error message when given one", () => {
    const { getByText } = render(<PinPad title="PIN" onSubmit={() => {}} onCancel={() => {}} error="Wrong PIN" />);
    expect(getByText("Wrong PIN")).toBeInTheDocument();
  });
});
