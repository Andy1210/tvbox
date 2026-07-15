import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { useBackspace } from "./useBackspace";

// Remote Back (Backspace) routing. Several screens mount a handler at once
// (Settings + whatever modal is open on top of it); only the top one must fire,
// and when it unmounts the one below must take over. This is the contract that
// keeps "Back closes the modal, not the whole screen".

function Layer({ cb, enabled }: { cb: () => void; enabled?: boolean }) {
  useBackspace(cb, enabled);
  return null;
}

function back() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  });
}

afterEach(cleanup);

describe("useBackspace", () => {
  it("fires only the most recently mounted handler", () => {
    const parent = vi.fn();
    const modal = vi.fn();
    render(createElement("div", null, createElement(Layer, { cb: parent }), createElement(Layer, { cb: modal })));
    back();
    expect(modal).toHaveBeenCalledTimes(1);
    expect(parent).not.toHaveBeenCalled();
  });

  it("falls back to the lower handler once the top unmounts", () => {
    const parent = vi.fn();
    const modal = vi.fn();
    const { rerender } = render(
      createElement("div", null, createElement(Layer, { cb: parent }), createElement(Layer, { cb: modal })),
    );
    rerender(createElement("div", null, createElement(Layer, { cb: parent })));
    back();
    expect(parent).toHaveBeenCalledTimes(1);
    expect(modal).not.toHaveBeenCalled();
  });

  it("ignores a handler registered with enabled=false", () => {
    const parent = vi.fn();
    const modal = vi.fn();
    render(
      createElement(
        "div",
        null,
        createElement(Layer, { cb: parent }),
        createElement(Layer, { cb: modal, enabled: false }),
      ),
    );
    back();
    expect(parent).toHaveBeenCalledTimes(1);
    expect(modal).not.toHaveBeenCalled();
  });

  it("calls the latest closure after a re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(createElement(Layer, { cb: first }));
    rerender(createElement(Layer, { cb: second }));
    back();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("does nothing when no handler is mounted", () => {
    expect(() => back()).not.toThrow();
  });

  it("only reacts to Back keys, not other keys", () => {
    const cb = vi.fn();
    render(createElement(Layer, { cb }));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(cb).not.toHaveBeenCalled();
  });

  // The box is driven by several remote transports; each reports Back with its
  // own DOM key. All must trigger the handler so no remote needs a manual remap.
  it.each(["Backspace", "BrowserBack", "GoBack", "Escape"])("treats %s as Back", (key) => {
    const cb = vi.fn();
    render(createElement(Layer, { cb }));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
