import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { TypingOverlay } from "./TypingOverlay";
import { setupRemote, setFocus } from "../test/remote";

// The overlay reports whether a session is on screen, and App suppresses the
// ambient screensaver while one is. That report cannot be derived from the shell's
// nav pushes: a "typing" push can end in no session at all when the status read
// fails, and the overlay cancels in that case. A caller watching the pushes would
// suppress the screensaver forever after one failed open.

setupRemote(); // registers its own cleanup; the overlay drives spatial-nav focus

type NavCb = (n: { dest: string }) => void;
let navCbs: NavCb[] = [];

function stubShell(status: unknown, cancel = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("tvbox", {
    onNav: (cb: NavCb) => {
      navCbs.push(cb);
      return () => {
        navCbs = navCbs.filter((c) => c !== cb);
      };
    },
    typing: { status: () => Promise.resolve(status), cancel, submit: vi.fn(), phone: vi.fn() },
  });
  return cancel;
}

// The status read is a promise, so a push has to settle before we assert.
async function pushNav(dest: string) {
  await act(async () => {
    navCbs.forEach((cb) => cb({ dest }));
    await Promise.resolve();
  });
}

const SESSION = { active: true, appName: "Plex", label: "Search", kind: "text" };

// The launcher normally has a focused tile behind the overlay, and the overlay
// saves it to restore later. `withAnchor: false` is the case where it does not -
// between a launcher reload and Home's first app-list load, or on the retry
// screen - which is where the close path used to be skipped entirely.
function Anchor() {
  const { ref } = useFocusable({ focusKey: "anchor" });
  return createElement("div", { ref });
}

async function mount(onActiveChange?: (a: boolean) => void, withAnchor = true) {
  const tree = withAnchor
    ? createElement("div", null, createElement(Anchor), createElement(TypingOverlay, { onActiveChange }))
    : createElement(TypingOverlay, { onActiveChange });
  const r = render(tree);
  if (withAnchor) await setFocus("anchor");
  return r;
}

beforeEach(() => {
  navCbs = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TypingOverlay session reporting", () => {
  it("reports active while a session is on screen, and inactive once it closes", async () => {
    stubShell(SESSION);
    const onActiveChange = vi.fn();
    await mount(onActiveChange);
    expect(onActiveChange).toHaveBeenLastCalledWith(false); // nothing open at mount

    await pushNav("typing");
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText("Plex")).not.toBeNull(); // the flag matches the screen

    await pushNav("home");
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText("Plex")).toBeNull();
  });

  // The close branch keys off the saved focus, so with nothing focused the shell's
  // closing push used to be dropped: the screen stayed up and the report stayed
  // true, which suppresses the screensaver for the life of the launcher.
  it("closes on the shell's push even when there was no focus to save", async () => {
    stubShell(SESSION);
    const onActiveChange = vi.fn();
    await mount(onActiveChange, false);

    await pushNav("typing");
    expect(onActiveChange).toHaveBeenLastCalledWith(true);

    await pushNav("home");
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText("Plex")).toBeNull();
  });

  it("never reports active when the session could not be read", async () => {
    const cancel = stubShell(null);
    const onActiveChange = vi.fn();
    await mount(onActiveChange);

    await pushNav("typing");
    expect(onActiveChange).not.toHaveBeenCalledWith(true);
    expect(cancel).toHaveBeenCalled(); // and it puts the app back in front
  });

  // A status read that lands after the session already closed must not re-open it;
  // `generation` guards that, and the report has to follow the same rule.
  it("ignores a status read that lands after the session closed", async () => {
    let settle: (v: unknown) => void = () => {};
    vi.stubGlobal("tvbox", {
      onNav: (cb: NavCb) => {
        navCbs.push(cb);
        return () => {};
      },
      typing: {
        status: () => new Promise((res) => (settle = res)),
        cancel: vi.fn().mockResolvedValue(undefined),
        submit: vi.fn(),
        phone: vi.fn(),
      },
    });
    const onActiveChange = vi.fn();
    await mount(onActiveChange);

    await pushNav("typing"); // opens, status still pending
    await pushNav("home"); // closes before the read lands
    await act(async () => {
      settle(SESSION);
      await Promise.resolve();
    });
    expect(onActiveChange).not.toHaveBeenCalledWith(true);
    expect(screen.queryByText("Plex")).toBeNull();
  });

  it("is optional, so a caller that does not care still works", async () => {
    stubShell(SESSION);
    await mount();
    await pushNav("typing"); // must not throw
  });
});
