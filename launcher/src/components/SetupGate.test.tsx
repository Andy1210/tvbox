import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { App } from "../App";
import { useConfigStore } from "../stores/config";
import { setupRemote } from "../test/remote";

// What decides whether a box sees onboarding.
//
// This used to be localStorage alone, and localStorage is not always the truth: an
// Electron instance that lost Chromium's storage lock reads it EMPTY, so a fully
// configured box offered setup again - and could not save the answer either, asking
// at every start. The box's own record (config.setup.done) is the answer, which
// means the gate has to wait for the config rather than assume "fresh".
setupRemote();

const CONFIG = (setupDone: boolean) => ({
  setup: { done: setupDone },
  iptv: { mode: null, xtream: null, m3u: null, configured: false },
  parental: { pinSet: false, lockedGroups: [], requirePin: false },
  spotify: { deviceName: "", hasCredentials: false, enabled: false },
  ambient: { enabled: false, idleMinutes: 5, city: "", sleepMinutes: 0, bing: false },
  ui: { hourFormat: "auto", navSounds: false },
});

// Answer the handful of endpoints App touches on mount; anything else is [].
function stubShell(setupDone: boolean, delayMs = 0) {
  vi.stubGlobal(
    "fetch",
    (url: string) =>
      new Promise((resolve) =>
        setTimeout(() => {
          const body = url.includes("/tvbox/api/config")
            ? CONFIG(setupDone)
            : url.includes("pending-localstorage")
              ? { data: null }
              : [];
          resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
        }, delayMs),
      ),
  );
}
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 30)));
// The wizard's own chrome, present on every step ("Setup · 1/5"). The test env has
// no stored locale, so it renders in the default English.
const wizardShowing = () => !!screen.queryByText(/Setup · \d\/\d/);

describe("the onboarding gate", () => {
  // The config store and the mounted tree are module/DOM state: without resetting
  // both, one case's answer decides the next one's gate.
  beforeEach(() => {
    localStorage.clear();
    useConfigStore.setState({ config: null, error: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not offer setup on a box that remembers it, even with an empty browser store", async () => {
    stubShell(true);
    render(<App />);
    await settle();
    expect(wizardShowing()).toBe(false);
    // and it re-learns it locally, so the next start needs no round trip
    expect(localStorage.getItem("tvbox.setup.done")).toBe("1");
  });

  it("offers setup when the box says it was never set up", async () => {
    stubShell(false);
    render(<App />);
    await settle();
    expect(wizardShowing()).toBe(true);
  });

  it("shows nothing at all until the box has answered - never a flash of onboarding", async () => {
    stubShell(true, 50); // config still in flight
    render(<App />);
    await act(async () => await new Promise((r) => setTimeout(r, 10)));
    expect(wizardShowing()).toBe(false);
    await settle();
    expect(wizardShowing()).toBe(false);
  });

  it("trusts its own store first, so a configured box renders without waiting", async () => {
    localStorage.setItem("tvbox.setup.done", "1");
    stubShell(false, 50); // the box would say "not done" - the local flag wins
    render(<App />);
    await act(async () => await new Promise((r) => setTimeout(r, 10)));
    expect(wizardShowing()).toBe(false);
  });
});
