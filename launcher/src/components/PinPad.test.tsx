import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { PinPad } from "./PinPad";
import { setupRemote, placeGrid, remote, setFocus, getCurrentFocusKey, flushFocus } from "../test/remote";

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

  it("auto-focuses the first digit on open", async () => {
    const { getByText } = render(<PinPad title="PIN" onSubmit={() => {}} onCancel={() => {}} />);
    layout(getByText);
    act(() => vi.runOnlyPendingTimers()); // the modal's deferred setFocus
    await flushFocus(); // setFocus resolves on the async scheduler
    expect(getCurrentFocusKey()).toBe("pin-1");
  });

  it("enters a 4-digit PIN with the arrows and auto-submits", async () => {
    const onSubmit = vi.fn();
    const { getByText } = render(<PinPad title="PIN" onSubmit={onSubmit} onCancel={() => {}} />);
    layout(getByText);
    await setFocus("pin-1");
    await remote.ok(); // 1
    await remote.right();
    await remote.ok(); // 2
    await remote.right();
    await remote.ok(); // 3
    await remote.down();
    await remote.ok(); // 6  -> "1236", 4 digits
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("1236");
  });

  it("delete removes the last digit before submit", async () => {
    const onSubmit = vi.fn();
    const { getByText } = render(<PinPad title="PIN" onSubmit={onSubmit} onCancel={() => {}} />);
    layout(getByText);
    await setFocus("pin-1");
    await remote.ok(); // "1"
    await setFocus("pin-2");
    await remote.ok(); // "12"
    await setFocus("pin-del");
    await remote.ok(); // "1"  (2 deleted)
    await setFocus("pin-3");
    await remote.ok(); // "13"
    await setFocus("pin-4");
    await remote.ok(); // "134"
    await setFocus("pin-5");
    await remote.ok(); // "1345" -> submit
    expect(onSubmit).toHaveBeenCalledWith("1345");
  });

  it("does not submit before the 4th digit", async () => {
    const onSubmit = vi.fn();
    const { getByText } = render(<PinPad title="PIN" onSubmit={onSubmit} onCancel={() => {}} />);
    layout(getByText);
    await setFocus("pin-1");
    await remote.ok();
    await remote.ok(); // OK on the same key twice -> "11" (2 digits)
    await remote.right();
    await remote.ok(); // "112"
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("remote Back cancels", async () => {
    const onCancel = vi.fn();
    const { getByText } = render(<PinPad title="PIN" onSubmit={() => {}} onCancel={onCancel} />);
    layout(getByText);
    await remote.back();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows an error message when given one", async () => {
    const { getByText } = render(<PinPad title="PIN" onSubmit={() => {}} onCancel={() => {}} error="Wrong PIN" />);
    expect(getByText("Wrong PIN")).toBeInTheDocument();
  });
});
