import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { RemoteRemap } from "./RemoteRemap";
import { keyBase } from "./RemoteKeymap";
import { useConfigStore } from "../stores/config";
import { getCurrentFocusKey, place, remote, setFocus as navSetFocus, setupRemote } from "../test/remote";
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
// The path a user takes: open the remote's menu, then its Buttons page. Which
// remote's menu is open survives a remount on purpose (every entry is a pushed page
// now), and that outlives a test too - so only open it when it is not already open,
// or the press would close it again.
const openButtons = async () => {
  if (!screen.queryByText("Buttons")) {
    await press("AR");
    await settle();
  }
  await press("Buttons");
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

    await openButtons();
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
    await openButtons();
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
    await openButtons();
    await press("Reset this remote's buttons");
    await settle();
    await press("Reset"); // the confirm button, not the row
    await settle();

    expect(resets(posted)).toHaveLength(1);
    expect((resets(posted)[0].body as { id: string }).id).toBe(MAC);
  });
});

// The Clear button beside a taught row, and the reassign question's two buttons.
// Both were reported from the sofa, and both are about what spatial navigation
// and the eye are told rather than about what the code does.
describe("a taught row's Clear button", () => {
  beforeEach(() => {
    useConfigStore.setState({ config: CONFIG as never, error: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // The rectangles are the ones a box really measures, which is the whole
  // point: a focused FocusButton is scaled 4%, spatial navigation reads the
  // TRANSFORMED box, and on a row filling the settings width that growth is
  // wider than the 1vw gap beside it. Measured in Chromium with the launcher's
  // own CSS at 1920x1080: the action button ends at 998.07 while Clear starts
  // at 997.69, so `sibling.left >= current.right` is false and Clear was in no
  // candidate list at all. Placed here to the same tenth of a pixel, so a
  // future "simplification" back to geometry fails instead of shipping.
  // Which of the pair is scaled depends on which one the cursor is on, so the
  // two directions are two different sets of numbers - both measured.
  const ACTION_FOCUSED = { x: -19.57, y: 200, w: 1017.64, h: 61 };
  const ACTION_PLAIN = { x: 0, y: 200, w: 978.5, h: 59 };
  const CLEAR_PLAIN = { x: 997.69, y: 202, w: 92.31, h: 55 };
  const CLEAR_FOCUSED = { x: 995.37, y: 201, w: 96, h: 57 };

  it("is reachable with Right, with the row's real overlapping geometry", async () => {
    stubShell();
    const { container } = render(<Screen />);
    await settle();
    await openButtons();

    const rowKey = keyBase(MAC) + "-settings";
    const clearKey = keyBase(MAC) + "-clear-settings";
    const row = container.querySelector(`[data-sfocus="${rowKey}"]`);
    const clear = container.querySelector(`[data-sfocus="${clearKey}"]`);
    expect(row).toBeTruthy();
    expect(clear).toBeTruthy();
    place(row as Element, ACTION_FOCUSED.x, ACTION_FOCUSED.y, ACTION_FOCUSED.w, ACTION_FOCUSED.h);
    place(clear as Element, CLEAR_PLAIN.x, CLEAR_PLAIN.y, CLEAR_PLAIN.w, CLEAR_PLAIN.h);

    await navSetFocus(rowKey);
    expect(getCurrentFocusKey()).toBe(rowKey);
    await remote.right();
    expect(getCurrentFocusKey()).toBe(clearKey);
  });

  // This direction measures clear today - the scaled box is the small one - so
  // this pins the declared behaviour rather than a fix, and leaves no mirror of
  // the bug above for a longer translation of "Clear" to reintroduce.
  it("hands the cursor back to its row with Left", async () => {
    stubShell();
    const { container } = render(<Screen />);
    await settle();
    await openButtons();

    const rowKey = keyBase(MAC) + "-settings";
    const clearKey = keyBase(MAC) + "-clear-settings";
    const p = (key: string, r: { x: number; y: number; w: number; h: number }) =>
      place(container.querySelector(`[data-sfocus="${key}"]`) as Element, r.x, r.y, r.w, r.h);
    p(rowKey, ACTION_PLAIN);
    p(clearKey, CLEAR_FOCUSED);

    await navSetFocus(clearKey);
    await remote.left();
    expect(getCurrentFocusKey()).toBe(rowKey);
  });

  it("does not swallow Right on a row nothing is taught for", async () => {
    stubShell();
    const { container } = render(<Screen />);
    await settle();
    await openButtons();

    // `up` is in the action list and unbound, so it has no Clear button - and
    // Right there must stay geometry's to answer, or a row with no button
    // beside it would eat the press.
    const unboundKey = keyBase(MAC) + "-up";
    expect(container.querySelector(`[data-sfocus="${unboundKey}"]`)).toBeTruthy();
    expect(container.querySelector(`[data-sfocus="${keyBase(MAC)}-clear-up"]`)).toBeNull();
  });
});

describe("the reassign question's buttons", () => {
  beforeEach(() => {
    useConfigStore.setState({ config: CONFIG as never, error: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Focus is the only fill in this UI. A second filled button beside the white
  // cursor reads as the selected one, and on the reset question that painted
  // the throw-it-away button as the bright one.
  it("carries no fill of its own, so only the cursor looks selected", async () => {
    stubShell();
    const { container } = render(<Screen />);
    await settle();
    await openButtons();
    await press("Reset this remote's buttons");
    await settle();

    const yes = container.querySelector('[data-sfocus="remote-confirm-yes"]');
    const no = container.querySelector('[data-sfocus="remote-confirm-no"]');
    expect(yes).toBeTruthy();
    expect(no).toBeTruthy();
    for (const b of [yes as Element, no as Element]) {
      expect(b.className).not.toMatch(/\bbg-accent\b/);
      expect(b.className).not.toMatch(/\bbg-warn\b/);
    }
    // ...and the dangerous one still says so, in its text rather than a fill.
    expect((yes as Element).className).toMatch(/\btext-warn\b/);
  });
});
