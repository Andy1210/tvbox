import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PeripheralsPane } from "./peripherals";
import { useConfigStore } from "../../stores/config";
import { setupRemote } from "../../test/remote";
import { SettingsNavProvider, type StackEntry } from "../nav";
import { invalidateSummary } from "../summary";

// The value on the "Remote buttons" row is a summary of the page behind it, so it
// has to count what that page lists: the remotes the bridge can see. It used to
// count `config.remote.devices`, which is the saved KEYMAPS - and those two answer
// differently in both directions.
setupRemote();

const KEPT = "7c:ed:c6:12:e6:3c"; // still paired, and remapped
const GONE = "a8:42:a7:c2:3e:ab"; // removed from Bluetooth, keymap left behind

const CONFIG = {
  remote: {
    power: "tv",
    devices: {
      [GONE]: { name: "AR", keymap: { settings: [1075] } },
      [KEPT]: { name: "AR", keymap: { settings: [1075] } },
    },
  },
};

function stubShell(connected: { id: string; name: string }[]) {
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", (url: string) => {
    if (String(url).includes("/remote/devices")) return json({ devices: connected });
    if (String(url).includes("/bt/devices")) return json({ devices: [] });
    if (String(url).includes("/firetvir/status")) return json(null);
    return json({});
  });
}

const Pane = () => (
  <SettingsNavProvider>{(stack: StackEntry[]) => (stack.length ? null : <PeripheralsPane />)}</SettingsNavProvider>
);
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("the remotes row", () => {
  beforeEach(() => {
    useConfigStore.setState({ config: CONFIG as never, error: false });
    invalidateSummary("remotes"); // the summary cache outlives a test
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("counts the remotes that are here, not the keymaps that were left behind", async () => {
    // Two saved keymaps, one remote: removing a remote from Bluetooth does not take
    // its keymap with it, and the row went on counting it.
    stubShell([{ id: KEPT, name: "AR" }]);
    render(<Pane />);
    await settle();
    expect(screen.getByText("remotes: 1")).toBeTruthy();
    expect(screen.queryByText("remotes: 2")).toBeNull();
  });

  it("counts a remote nobody has remapped", async () => {
    // The other direction: a remote with no custom buttons has no config entry at
    // all, so it used to be missing from the count while the page listed it.
    useConfigStore.setState({ config: { remote: { power: "tv", devices: {} } } as never, error: false });
    stubShell([
      { id: KEPT, name: "AR" },
      { id: "aa:bb:cc:dd:ee:ff", name: "Xbox" },
    ]);
    render(<Pane />);
    await settle();
    expect(screen.getByText("remotes: 2")).toBeTruthy();
  });
});
