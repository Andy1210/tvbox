import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { PhoneRemoteSubPage } from "./phoneremote";
import { setupRemote, remote, setFocus } from "../../test/remote";

// The one page in Settings that opens a door, so what is tested here is what it
// promises: that it is off until pressed, that turning it off takes the paired
// phones with it, and that a phone can be removed one at a time. A permission
// you cannot see is one you cannot withdraw.
setupRemote();

type Phone = { id: string; name: string; addedAt: number; lastSeenAt: number | null };

// A stand-in shell: it answers GET with its current state and applies the POSTs
// the way the real routes do, so the page is driven rather than mocked per call.
function stubShell(initial: { enabled: boolean; phones: Phone[] }) {
  const state = { ...initial };
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const path = String(url);
    const json = (o: unknown) =>
      Promise.resolve(new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } }));
    if (!init || init.method !== "POST") {
      return json({ enabled: state.enabled, phones: state.phones, port: 8100 });
    }
    const body = JSON.parse(String(init.body || "{}"));
    posted.push({ path, body });
    if (path.endsWith("/enable")) {
      state.enabled = !!body.enabled;
      if (!state.enabled) state.phones = []; // off takes the pairings with it
      return json({ ok: true, enabled: state.enabled, phones: state.phones });
    }
    if (path.endsWith("/forget")) {
      state.phones = state.phones.filter((p) => p.id !== body.id);
      return json({ ok: true, phones: state.phones });
    }
    if (path.endsWith("/arm"))
      return json({
        ok: true,
        url: "http://192.168.1.9:8100/?c=4321",
        shortUrl: "http://192.168.1.9:8100",
        code: "4321",
      });
    return json({ ok: true });
  });
  return { state, posted };
}

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("the phone-remote settings page", () => {
  beforeEach(() => setupRemote());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers nothing to pair until it is switched on", async () => {
    const shell = stubShell({ enabled: false, phones: [] });
    const { queryByText, getByText } = render(<PhoneRemoteSubPage onBack={() => {}} />);
    await settle();
    expect(getByText("Off")).toBeTruthy();
    // No pairing row while it is off: there is nothing listening to pair with.
    expect(queryByText("Pair a phone")).toBeNull();
    expect(shell.posted).toEqual([]);
  });

  it("turning it on is what opens the box, and only then can a phone be paired", async () => {
    const shell = stubShell({ enabled: false, phones: [] });
    const { getByText } = render(<PhoneRemoteSubPage onBack={() => {}} />);
    await settle();
    await setFocus("phoneremote:enable");
    await remote.ok();
    await settle();
    expect(shell.posted[0]).toEqual({ path: "/tvbox/api/phoneremote/enable", body: { enabled: true } });
    expect(shell.state.enabled).toBe(true);
    expect(getByText("Pair a phone")).toBeTruthy();
  });

  it("turning it off takes the paired phones with it", async () => {
    // Leaving them would mean a list that silently comes back to life the next
    // time the switch is flipped, which is not what "off" reads as.
    const shell = stubShell({
      enabled: true,
      phones: [{ id: "a1", name: "Andy's phone", addedAt: 1, lastSeenAt: null }],
    });
    const { getByText, queryByText } = render(<PhoneRemoteSubPage onBack={() => {}} />);
    await settle();
    expect(getByText("Andy's phone")).toBeTruthy();
    await setFocus("phoneremote:enable");
    await remote.ok();
    await settle();
    expect(shell.state.enabled).toBe(false);
    expect(shell.state.phones).toEqual([]);
    expect(queryByText("Andy's phone")).toBeNull();
  });

  it("one phone can be removed without touching the others", async () => {
    const shell = stubShell({
      enabled: true,
      phones: [
        { id: "a1", name: "Andy's phone", addedAt: 1, lastSeenAt: null },
        { id: "b2", name: "kitchen", addedAt: 2, lastSeenAt: null },
      ],
    });
    const { getByText, queryByText } = render(<PhoneRemoteSubPage onBack={() => {}} />);
    await settle();
    await setFocus("phoneremote:phone-a1");
    await remote.ok();
    await settle();
    expect(shell.posted.at(-1)).toEqual({ path: "/tvbox/api/phoneremote/forget", body: { id: "a1" } });
    expect(queryByText("Andy's phone")).toBeNull();
    expect(getByText("kitchen")).toBeTruthy();
  });

  it("a phone that paired and was never used says so", async () => {
    // That is exactly the row worth removing, so it must not read as "just now".
    stubShell({ enabled: true, phones: [{ id: "a1", name: "old", addedAt: 1, lastSeenAt: null }] });
    const { getByText } = render(<PhoneRemoteSubPage onBack={() => {}} />);
    await settle();
    expect(getByText("Never used")).toBeTruthy();
  });

  it("a blip offers a retry rather than claiming the box is too old", async () => {
    // The two answers are not the same, and telling them apart is the difference
    // between "your box needs updating" and "try again" - which is what every
    // other screen here does with a failed read.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network")));
    const { getByText, queryByText } = render(<PhoneRemoteSubPage onBack={() => {}} />);
    await settle();
    expect(queryByText("This box's software is too old for it.")).toBeNull();
    expect(getByText("Try again")).toBeTruthy();
    expect(getByText("The box did not answer. Try again.")).toBeTruthy();
    // The press itself is not driven here: this row is the same `autoFocus`
    // retry row the mirroring page uses for its own unreachable state, and it
    // mounts after the first paint, which this harness's focus does not follow.
  });

  it("a box whose shell is too old says so instead of offering a switch", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("not found", { status: 404 })));
    const { getByText, queryByText } = render(<PhoneRemoteSubPage onBack={() => {}} />);
    await settle();
    expect(getByText("This box's software is too old for it.")).toBeTruthy();
    expect(queryByText("Phone remote")).toBeNull();
  });
});
