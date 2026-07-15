import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
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

  it("types by arrowing across the keyboard and confirms with done", async () => {
    const onDone = vi.fn();
    const { getByText } = render(<Osk title="URL" onDone={onDone} onCancel={() => {}} />);
    // The home row a-s-d; caret/typing needs geometry only for the arrow moves.
    placeRow([getByText("a"), getByText("s"), getByText("d")]);
    await setFocus("osk-2-0"); // 'a'
    await remote.ok();
    await remote.right();
    await remote.ok(); // 's'
    await remote.right();
    await remote.ok(); // 'd'
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("asd");
  });

  it("Shift toggles the next letter to uppercase", async () => {
    const onDone = vi.fn();
    render(<Osk title="URL" onDone={onDone} onCancel={() => {}} />);
    await setFocus("osk-2-0");
    await remote.ok(); // 'a'
    await setFocus("osk-shift");
    await remote.ok(); // caps on
    await setFocus("osk-2-0");
    await remote.ok(); // 'A'
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("aA");
  });

  it("moves the caret and deletes mid-string", async () => {
    const onDone = vi.fn();
    render(<Osk title="URL" initial="asd" onDone={onDone} onCancel={() => {}} />);
    await setFocus("osk-left");
    await remote.ok();
    await remote.ok(); // caret: end(3) -> 1, i.e. between 'a' and 's'
    await setFocus("osk-del");
    await remote.ok(); // deletes the char before the caret ('a')
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("sd");
  });

  it("caret right then delete removes a later character", async () => {
    const onDone = vi.fn();
    render(<Osk title="URL" initial="ab" onDone={onDone} onCancel={() => {}} />);
    // Caret starts at end (2). Move left twice to the very start, right once to
    // sit between 'a' and 'b', then delete removes 'a'.
    await setFocus("osk-left");
    await remote.ok();
    await remote.ok(); // caret 0
    await setFocus("osk-right");
    await remote.ok(); // caret 1
    await setFocus("osk-del");
    await remote.ok(); // removes 'a' -> "b"
    await setFocus("osk-done");
    await remote.ok();
    expect(onDone).toHaveBeenCalledWith("b");
  });

  it("remote Back cancels", async () => {
    const onCancel = vi.fn();
    render(<Osk title="URL" onDone={() => {}} onCancel={onCancel} />);
    await remote.back();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
