import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { App } from "../App";
import { useConfigStore } from "../stores/config";
import { setupRemote } from "../test/remote";

// What the screensaver is allowed to cover. The launcher's view is the usual
// answer, but a typing session does not change it: the shell shows this window and
// pushes "typing", which the view ignores on purpose, and the phone's text never
// reaches this window at all. So an idle Home is exactly what the timer sees while
// the user is typing, and the screensaver would land on top of the keyboard.

setupRemote(); // App mounts spatial-nav focusables

const CONFIG = {
  setup: { done: true },
  iptv: { mode: null, xtream: null, m3u: null, configured: false },
  parental: { pinSet: false, lockedGroups: [], requirePin: false },
  spotify: { deviceName: "", hasCredentials: false, enabled: false },
  ambient: { enabled: true, idleMinutes: 1, city: "", sleepMinutes: 0, bing: false },
  ui: { hourFormat: "auto", navSounds: false },
};

type NavCb = (n: { dest: string }) => void;
let navCbs: NavCb[] = [];

const ambientDone = vi.fn();

function stubShell(session: unknown) {
  vi.stubGlobal("fetch", (url: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          url.includes("/tvbox/api/config") ? CONFIG : url.includes("pending-localstorage") ? { data: null } : [],
        ),
        { headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
  vi.stubGlobal("tvbox", {
    onNav: (cb: NavCb) => {
      navCbs.push(cb);
      return () => {};
    },
    typing: {
      status: () => Promise.resolve(session),
      cancel: vi.fn().mockResolvedValue(undefined),
      submit: vi.fn(),
      phone: vi.fn(),
    },
    ambient: { request: vi.fn(), done: ambientDone },
  });
}

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(50)));
const goIdle = () => act(async () => void (await vi.advanceTimersByTimeAsync(70000))); // idleMinutes 1
const pushNav = (dest: string) =>
  act(async () => {
    navCbs.forEach((cb) => cb({ dest }));
    await Promise.resolve();
  });
const ambientUp = () => !!screen.queryByText("Press any key to exit");

beforeEach(() => {
  localStorage.clear();
  useConfigStore.setState({ config: null, error: false });
  navCbs = [];
  ambientDone.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ambient suppression", () => {
  it("arms on an idle Home", async () => {
    stubShell(null);
    render(<App />);
    await settle();
    expect(ambientUp()).toBe(false);
    await goIdle();
    expect(ambientUp()).toBe(true);
  });

  it("does not arm over a typing session", async () => {
    stubShell({ active: true, appName: "Plex", label: "Search", kind: "text" });
    render(<App />);
    await settle();
    await pushNav("typing");
    await goIdle();
    expect(ambientUp()).toBe(false);
  });

  // The other direction: an app can ask for the screensaver over itself, because
  // the launcher's window is hidden while an app is in front and its timer never
  // runs there. The shell brings this window forward and pushes "ambient".
  it("comes up when an app asks, without waiting for the timer", async () => {
    stubShell(null);
    render(<App />);
    await settle();

    await pushNav("ambient");

    expect(ambientUp()).toBe(true);
  });

  it("...and the first key sends the screen back to the app that asked", async () => {
    stubShell(null);
    render(<App />);
    await settle();
    await pushNav("ambient");
    expect(ambientUp()).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(ambientUp()).toBe(false);
    expect(ambientDone).toHaveBeenCalled();
  });

  // The remote's Home key never reaches this page as a key: the preload turns it
  // into a nav event, so the screensaver's own first-key handler cannot see it,
  // and Home used to leave the clock sitting there.
  it("Home takes an ordinary screensaver away as well", async () => {
    stubShell(null);
    render(<App />);
    await settle();
    await goIdle();
    expect(ambientUp()).toBe(true);

    await pushNav("home");

    expect(ambientUp()).toBe(false);
  });

  it("pressing Home during one takes the screensaver away, not the next key", async () => {
    stubShell(null);
    render(<App />);
    await settle();
    await pushNav("ambient");
    expect(ambientUp()).toBe(true);

    await pushNav("home");

    expect(ambientUp()).toBe(false);
    expect(ambientDone).not.toHaveBeenCalled();
  });

  it("a screensaver nobody asked for does not send the screen anywhere", async () => {
    stubShell(null);
    render(<App />);
    await settle();
    await goIdle();
    expect(ambientUp()).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(ambientUp()).toBe(false);
    expect(ambientDone).not.toHaveBeenCalled();
  });

  // Spatial navigation acts on a key's RELEASE, so the screensaver has to eat
  // both halves: on the box, waking it with Enter opened the tile behind it.
  it("the key that wakes it does not also press what is behind it", async () => {
    stubShell(null);
    render(<App />);
    await settle();
    await goIdle();
    expect(ambientUp()).toBe(true);

    const behind: string[] = [];
    const spy = () => behind.push("up");
    window.addEventListener("keyup", spy);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    window.removeEventListener("keyup", spy);

    expect(ambientUp()).toBe(false);
    expect(behind).toEqual([]);

    // A repeat of the same held key is eaten too - that is the one that opened a
    // tile on the box - and so is anything else within the second the wake key
    // is given, because a held key has no reliable last event.
    window.addEventListener("keyup", spy);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(behind).toEqual([]);

    // ...and a second later the screen is the person's again.
    await act(async () => void (await vi.advanceTimersByTimeAsync(1200)));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    window.removeEventListener("keyup", spy);
    expect(behind).toEqual(["up"]);
  });

  it("arms again once the typing session ends", async () => {
    stubShell({ active: true, appName: "Plex", label: "Search", kind: "text" });
    render(<App />);
    await settle();
    await pushNav("typing");
    await goIdle();
    expect(ambientUp()).toBe(false);
    await pushNav("home");
    await goIdle();
    expect(ambientUp()).toBe(true);
  });
});
