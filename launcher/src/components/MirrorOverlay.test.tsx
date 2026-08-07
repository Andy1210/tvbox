import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { MirrorOverlay } from "./MirrorOverlay";

// What is on screen while a phone mirrors, and what is not.
//
// mpv plays BEHIND the launcher window, so anything this draws sits on top of
// someone's phone screen. The bug that made it necessary: the Settings page that
// armed mirroring stayed up and covered the picture. So the two things worth
// pinning are that it shows almost nothing, and that it goes away when the shell
// says the session is over - not when the overlay guesses.

const stop = vi.fn().mockResolvedValue({ ok: true });
vi.mock("../lib/api", () => ({ stopMirroring: () => stop() }));

type NavCb = (n: { dest: string }) => void;
let navCbs: NavCb[] = [];

function stubShell() {
  vi.stubGlobal("tvbox", {
    onNav: (cb: NavCb) => {
      navCbs.push(cb);
      return () => {
        navCbs = navCbs.filter((c) => c !== cb);
      };
    },
  });
}

async function pushNav(dest: string) {
  await act(async () => {
    navCbs.forEach((cb) => cb({ dest }));
    await Promise.resolve();
  });
}

describe("MirrorOverlay", () => {
  beforeEach(() => {
    navCbs = [];
    stop.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubShell();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("draws nothing until the shell says frames are arriving", async () => {
    render(<MirrorOverlay />);
    expect(screen.queryByTestId("mirror-overlay")).toBeNull();
    await pushNav("mirroring");
    expect(screen.getByTestId("mirror-overlay")).toBeTruthy();
  });

  it("keeps its hint brief - it is drawn over someone's phone screen", async () => {
    render(<MirrorOverlay />);
    await pushNav("mirroring");
    expect(screen.getByText(/Back/i)).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText(/Back/i)).toBeNull();
    expect(screen.getByTestId("mirror-overlay")).toBeTruthy(); // still up, just silent
  });

  it("leaves when the shell says the session is over, not before", async () => {
    render(<MirrorOverlay />);
    await pushNav("mirroring");
    await pushNav("mirroring"); // a repeat is not an end
    expect(screen.getByTestId("mirror-overlay")).toBeTruthy();
    await pushNav("home");
    expect(screen.queryByTestId("mirror-overlay")).toBeNull();
  });

  it("stops mirroring on Back, which is the only way out of a full-screen phone", async () => {
    render(<MirrorOverlay />);
    await pushNav("mirroring");
    await act(async () => {
      fireEvent.keyDown(window, { key: "Backspace" });
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ignores keys once the session has ended", async () => {
    render(<MirrorOverlay />);
    await pushNav("mirroring");
    await pushNav("home");
    await act(async () => {
      fireEvent.keyDown(window, { key: "Backspace" });
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("reports whether it is up, so the screensaver stays away", async () => {
    const seen: boolean[] = [];
    render(<MirrorOverlay onActiveChange={(on) => seen.push(on)} />);
    await pushNav("mirroring");
    await pushNav("home");
    expect(seen).toContain(true);
    expect(seen[seen.length - 1]).toBe(false);
  });
});
