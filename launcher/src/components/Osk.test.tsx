import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { Osk } from "./Osk";
import { setupRemote, placeRow, remote, setFocus } from "../test/remote";

// The on-screen keyboard modal (IPTV URLs, credentials). Driven by the D-pad:
// arrow to a key, OK to type it. Covers arrow typing, Shift case-toggle, the
// movable caret with mid-string delete, ✓ done, and remote-Back cancel.

setupRemote();

describe("Osk", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("types by arrowing across the keyboard and confirms with done", () => {
    const onDone = vi.fn();
    const { getByText } = render(<Osk title="URL" onDone={onDone} onCancel={() => {}} />);
    // The home row a-s-d; caret/typing needs geometry only for the arrow moves.
    placeRow([getByText("a"), getByText("s"), getByText("d")]);
    act(() => setFocus("osk-2-0")); // 'a'
    remote.ok();
    remote.right();
    remote.ok(); // 's'
    remote.right();
    remote.ok(); // 'd'
    act(() => setFocus("osk-done"));
    remote.ok();
    expect(onDone).toHaveBeenCalledWith("asd");
  });

  it("Shift toggles the next letter to uppercase", () => {
    const onDone = vi.fn();
    render(<Osk title="URL" onDone={onDone} onCancel={() => {}} />);
    act(() => setFocus("osk-2-0"));
    remote.ok(); // 'a'
    act(() => setFocus("osk-shift"));
    remote.ok(); // caps on
    act(() => setFocus("osk-2-0"));
    remote.ok(); // 'A'
    act(() => setFocus("osk-done"));
    remote.ok();
    expect(onDone).toHaveBeenCalledWith("aA");
  });

  it("moves the caret and deletes mid-string", () => {
    const onDone = vi.fn();
    render(<Osk title="URL" initial="asd" onDone={onDone} onCancel={() => {}} />);
    act(() => setFocus("osk-left"));
    remote.ok();
    remote.ok(); // caret: end(3) -> 1, i.e. between 'a' and 's'
    act(() => setFocus("osk-del"));
    remote.ok(); // deletes the char before the caret ('a')
    act(() => setFocus("osk-done"));
    remote.ok();
    expect(onDone).toHaveBeenCalledWith("sd");
  });

  it("caret right then delete removes a later character", () => {
    const onDone = vi.fn();
    render(<Osk title="URL" initial="ab" onDone={onDone} onCancel={() => {}} />);
    // Caret starts at end (2). Move left twice to the very start, right once to
    // sit between 'a' and 'b', then delete removes 'a'.
    act(() => setFocus("osk-left"));
    remote.ok();
    remote.ok(); // caret 0
    act(() => setFocus("osk-right"));
    remote.ok(); // caret 1
    act(() => setFocus("osk-del"));
    remote.ok(); // removes 'a' -> "b"
    act(() => setFocus("osk-done"));
    remote.ok();
    expect(onDone).toHaveBeenCalledWith("b");
  });

  it("remote Back cancels", () => {
    const onCancel = vi.fn();
    render(<Osk title="URL" onDone={() => {}} onCancel={onCancel} />);
    remote.back();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
