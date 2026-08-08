import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ParentalPage } from "./system";
import { useConfigStore } from "../../stores/config";
import { setupRemote, remote, setFocus } from "../../test/remote";

// The child lock, and the one press that used to walk straight through it.
//
// Changing the PIN and clearing it both asked for the PIN. Turning OFF "require
// PIN for sensitive actions" did not - and that switch is what the other two
// protect, so it was the way past both: flip it off, then install, uninstall or
// open the developer tools freely.
setupRemote();

function stubShell() {
  const saved: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const json = (o: unknown) =>
      Promise.resolve(new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } }));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      if (String(url).includes("/parental")) saved.push(body);
      // Every PIN offered is wrong here: what is under test is whether the box
      // ASKS, not whether it can be answered.
      if (String(url).includes("verify")) return json({ ok: false });
      return json({ ok: true, config: {} });
    }
    return json({});
  });
  return saved;
}

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));
const config = (requirePin: boolean) =>
  act(() => {
    useConfigStore.setState({
      config: { parental: { pinSet: true, requirePin, lockedGroups: [] } } as never,
      setParental: (async (p: Record<string, unknown>) => {
        await fetch("/tvbox/api/config/parental", { method: "POST", body: JSON.stringify(p) });
      }) as never,
    });
  });

describe("parental controls", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Rendered directly: reaching it through the System pane needs the settings
  // nav provider, which is a different thing to test.
  async function openParental() {
    const view = render(<ParentalPage />);
    await settle();
    return view;
  }

  it("turning the requirement OFF asks for the PIN", async () => {
    const saved = stubShell();
    config(true);
    const { getByText } = await openParental();
    await setFocus("parental:require");
    await remote.ok();
    await settle();
    // The PIN pad is up and nothing has been written yet.
    expect(getByText("Enter the PIN")).toBeTruthy();
    expect(saved).toEqual([]);
  });

  it("turning it ON does not", async () => {
    // Raising a guard needs no permission, and asking would only make people
    // leave it down.
    const saved = stubShell();
    config(false);
    const { queryByText } = await openParental();
    await setFocus("parental:require");
    await remote.ok();
    await settle();
    expect(queryByText("Enter the PIN")).toBeNull();
    expect(saved).toEqual([{ requirePin: true }]);
  });
});
