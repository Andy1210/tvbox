import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DevToolsPage } from "./devtools";
import { useConfigStore } from "../../stores/config";
import { setupRemote, remote, setFocus } from "../../test/remote";

// Two of the three things behind this door hand out something real - arbitrary
// code in the launcher window, and a picture of whatever is on screen - so what
// is tested is the door and the clock, not the layout.
setupRemote();

function stubShell(initial: { screenUntil: number }) {
  const state = { ...initial };
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const path = String(url);
    const json = (o: unknown) =>
      Promise.resolve(new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } }));
    if (!init || init.method !== "POST") {
      return json({ enabled: true, phones: [], port: 8100, screenUntil: state.screenUntil });
    }
    const body = JSON.parse(String(init.body || "{}"));
    posted.push({ path, body });
    if (path.endsWith("/screen")) {
      const mins = Math.max(0, Math.min(120, Number(body.minutes) || 0));
      state.screenUntil = mins ? Date.now() + mins * 60000 : 0;
      return json({ ok: true, until: state.screenUntil, on: !!mins });
    }
    return json({ ok: true, port: body.port, restarting: true });
  });
  return { state, posted };
}

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));
const setPin = (pinSet: boolean) =>
  act(() => {
    useConfigStore.setState({ config: { parental: { pinSet } } as never });
  });

describe("developer tools", () => {
  beforeEach(() => setupRemote());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks for the PIN when the box has one", async () => {
    stubShell({ screenUntil: 0 });
    setPin(true);
    const { queryByText, getByText } = render(<DevToolsPage onBack={() => {}} />);
    await settle();
    expect(getByText("Enter the PIN")).toBeTruthy();
    expect(queryByText("Chromium debugger")).toBeNull();
  });

  it("does not invent a lock on a box that has none", async () => {
    // verifyPin refuses every code when no PIN is stored, so gating
    // unconditionally would put this screen out of reach for good.
    stubShell({ screenUntil: 0 });
    setPin(false);
    const { getByText, queryByText } = render(<DevToolsPage onBack={() => {}} />);
    await settle();
    expect(queryByText("Enter the PIN")).toBeNull();
    expect(getByText("Chromium debugger")).toBeTruthy();
  });

  it("sharing the screen is a switch with a clock on it", async () => {
    const shell = stubShell({ screenUntil: 0 });
    setPin(false);
    const { getByText } = render(<DevToolsPage onBack={() => {}} />);
    await settle();
    expect(getByText("Off")).toBeTruthy();

    await setFocus("dev:screenshare");
    await remote.ok();
    await settle();
    expect(shell.posted.at(-1)?.path).toBe("/tvbox/api/phoneremote/screen");
    expect(shell.state.screenUntil).toBeGreaterThan(Date.now());
    expect(getByText("Stop sharing")).toBeTruthy();

    // And it can be closed by hand, not only by running out.
    await setFocus("dev:screenshare");
    await remote.ok();
    await settle();
    expect(shell.posted.at(-1)?.body).toEqual({ minutes: 0 });
    expect(shell.state.screenUntil).toBe(0);
  });

  it("a share already running is shown as running, not as off", async () => {
    // The page can be opened while a window is open; it has to say so, or someone
    // would turn it on again rather than off.
    stubShell({ screenUntil: Date.now() + 10 * 60000 });
    setPin(false);
    const { getByText } = render(<DevToolsPage onBack={() => {}} />);
    await settle();
    expect(getByText("Stop sharing")).toBeTruthy();
    expect(getByText("Your screen is shared")).toBeTruthy();
  });

  it("an expired window reads as off", async () => {
    stubShell({ screenUntil: Date.now() - 1000 });
    setPin(false);
    const { getByText } = render(<DevToolsPage onBack={() => {}} />);
    await settle();
    expect(getByText("Off")).toBeTruthy();
  });

  it("the debugger asks for a port and the box restarts itself", async () => {
    const shell = stubShell({ screenUntil: 0 });
    setPin(false);
    render(<DevToolsPage onBack={() => {}} />);
    await settle();
    await setFocus("dev:debugport");
    await remote.ok();
    await settle();
    expect(shell.posted.at(-1)).toEqual({ path: "/tvbox/api/devtools/debugport", body: { port: 9222 } });
  });
});
