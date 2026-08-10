import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { RemoteRemap } from "./RemoteRemap";
import { useConfigStore } from "../stores/config";
import { setupRemote } from "../test/remote";
import { SettingsNavProvider, type StackEntry } from "../settings/nav";

// "Reset this remote's buttons" throws away every button the user taught, and one
// press cannot undo it: the codes came from pressing each physical button in turn,
// and nothing on the box keeps a copy. It also sits one row below the ordinary
// action rows on a screen driven by a D-pad, which is exactly how a press meant for
// the row above lands on it. So it asks first - and the question defaults to Cancel,
// because the press that opened it may still be arriving.
setupRemote();

const MAC = "7c:ed:c6:12:e6:3c";
const CONFIG = {
  remote: {
    power: "tv",
    devices: {
      [MAC]: {
        name: "AR",
        keymap: { settings: [1075], "app:plex": [930], "app:spotify": [932] },
      },
    },
  },
};

function stubShell() {
  const posted: { url: string; body: unknown }[] = [];
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
      return json({ ok: true });
    }
    if (String(url).includes("/remote/devices")) return json({ devices: [{ id: MAC, name: "AR" }] });
    if (String(url).includes("/remote/learned")) return json({ learned: null });
    if (String(url).includes("/finder/capable")) return json({ macs: [], ringing: null });
    if (String(url).includes("/firetvir/programmable")) return json({ macs: [] });
    if (String(url).includes("/api/apps")) return json({ apps: [] });
    // The screen reloads the config store after a reset, and a store that came back
    // empty would take the row with it - answer as the box would.
    if (String(url).includes("/api/config")) return json(CONFIG);
    return json({});
  });
  return posted;
}

// RemoteRemap reads the settings stack now (the TV IR flow is a pushed page), so it
// has to be mounted inside the provider the real screen gives it.
const Screen = () => (
  <SettingsNavProvider>
    {(stack: StackEntry[]) => {
      const top = stack[stack.length - 1];
      return top ? <div key={top.id}>{top.render()}</div> : <RemoteRemap />;
    }}
  </SettingsNavProvider>
);

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));
const press = async (text: string | RegExp) =>
  await act(async () => {
    screen.getByText(text).click();
  });
type Posted = { url: string; body: unknown };
const resets = (posted: Posted[]) => posted.filter((p) => p.url.includes("/remote/reset"));
// Which remote's actions are open survives a remount on purpose (the TV IR flow is
// a pushed page above this screen), and that outlives a test too - so open it only
// when it is not already open, or the press would close it again.
const expand = async () => {
  if (screen.queryByText("Reset this remote's buttons")) return;
  await press("AR");
  await settle();
};

describe("resetting a remote's buttons", () => {
  beforeEach(() => {
    useConfigStore.setState({ config: CONFIG as never, error: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks before it throws the taught buttons away", async () => {
    const posted = stubShell();
    render(<Screen />);
    await settle();

    await expand();
    await press("Reset this remote's buttons");
    await settle();

    // The question is up and NOTHING has been sent yet.
    expect(screen.getByText("Reset this remote's buttons?")).toBeTruthy();
    expect(screen.getByText(/3 buttons you taught it/)).toBeTruthy();
    expect(resets(posted)).toHaveLength(0);
  });

  it("cancelling leaves the buttons alone", async () => {
    const posted = stubShell();
    render(<Screen />);
    await settle();
    await expand();
    await press("Reset this remote's buttons");
    await settle();
    await press("Cancel");
    await settle();

    expect(screen.queryByText("Reset this remote's buttons?")).toBeNull();
    expect(resets(posted)).toHaveLength(0);
    // ...and the row that asked is still there to press again.
    expect(screen.getByText("Reset this remote's buttons")).toBeTruthy();
  });

  it("confirming resets exactly the remote that was asked about", async () => {
    const posted = stubShell();
    render(<Screen />);
    await settle();
    await expand();
    await press("Reset this remote's buttons");
    await settle();
    await press("Reset"); // the confirm button, not the row
    await settle();

    expect(resets(posted)).toHaveLength(1);
    expect((resets(posted)[0].body as { id: string }).id).toBe(MAC);
  });
});
