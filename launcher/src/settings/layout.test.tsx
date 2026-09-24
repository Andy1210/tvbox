import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { Settings } from "./Settings";
import { setupRemote, setFocus, remote, getCurrentFocusKey, flushFocus } from "../test/remote";
import { installFocusGuard } from "@sdk/focusGuard";

setupRemote();

// The page's own container is what scrolls (SettingsPage: h-full overflow-y-auto).
// It only can if every box between it and the fixed-height pane passes the height
// down; one without it grows with the content, and the whole screen scrolls
// instead, taking the title and the rail with it.
describe("settings layout", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("hands the pane's height all the way down to the page's scroll container", async () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    const { container } = render(<Settings onExit={() => {}} />);
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const scroller = container.querySelector(".flex-1.min-w-0 .overflow-y-auto");
    expect(scroller).not.toBeNull();
    // From the scroller up to the flex row that has a real height.
    let el = scroller!.parentElement;
    while (el && !el.classList.contains("min-h-0")) {
      expect(el.classList.contains("h-full"), el.outerHTML.slice(0, 80)).toBe(true);
      el = el.parentElement;
    }
    expect(el).not.toBeNull();
  });

  it("does not light up the rail behind a pushed page that has nothing to focus", async () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    const stop = installFocusGuard(window);
    try {
      const { container } = render(<Settings onExit={() => {}} />);
      await act(() => new Promise((r) => setTimeout(r, 0)));
      await setFocus("rail:about");
      await flushFocus();
      await setFocus("about:credits");
      await remote.ok();
      await act(() => new Promise((r) => setTimeout(r, 0)));
      const scroller = container.querySelector(".flex-1.min-w-0 .overflow-y-auto") as HTMLElement;
      const scrollBy = vi.fn();
      scroller.scrollBy = scrollBy;
      await remote.down();
      expect(getCurrentFocusKey()).not.toBe("rail:about");
      expect(scrollBy).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});
