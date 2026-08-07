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
