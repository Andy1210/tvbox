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

// `learnedCode` makes the bridge report that button as just pressed, which is
// how the reassign question is reached: the code is already bound to another
// action, so the screen asks before stealing it.
//
// `hold` keeps every config write pending until it is released, which is the
// only way to write the "leave while a save is in flight" case without racing
// it: the press arms the save, the release decides when it finishes, and the
// test chooses what happens in between.
function stubShell(learnedCode?: number, hold?: { wait: Promise<void> }, failWrites?: boolean) {
  const posted: { url: string; body: unknown }[] = [];
  // The box's own answer shape, and it is load-bearing: `postConfig` THROWS
  // unless the response carries a `config`, so a stub answering `{ok:true}` made
  // every write on this screen reject. The three reset tests never saw it
  // because they assert the request; a test about what the screen does AFTER a
  // save cannot be written against that stub at all.
  let live: Record<string, unknown> = structuredClone(CONFIG) as Record<string, unknown>;
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      posted.push({ url: String(url), body });
      if (String(url).includes("/api/config")) {
        // The shell replaces the devices map wholesale and merges around power,
        // which is what `saveRemote` is written against.
        const remote = { ...(live.remote as object), ...(body.remote as object) };
        live = { ...live, remote };
        // A write the box refuses. `postConfig` throws on a non-2xx and on a
        // 200 that carries no `config`, so either shape is the same rejection
        // to the screen; this is the second, which is the one a half-updated
        // shell would really send.
        const answer = () => (failWrites ? json({ ok: false }) : json({ ok: true, config: live }));
        return hold ? hold.wait.then(answer) : answer();
      }
      return json({ ok: true });
    }
    if (String(url).includes("/remote/devices")) return json({ devices: [{ id: MAC, name: "AR" }] });
    if (String(url).includes("/remote/learned"))
      return json({
        // The screen ignores a capture older than the moment it armed, so this
        // has to be stamped now rather than with a fixed number.
        learned:
          learnedCode === undefined
            ? null
            : { id: MAC, code: learnedCode, name: "KEY_X", ts: Math.floor(Date.now() / 1000) },
      });
    if (String(url).includes("/finder/capable")) return json({ macs: [], ringing: null });
    if (String(url).includes("/firetvir/programmable")) return json({ macs: [] });
    if (String(url).includes("/api/apps")) return json({ apps: [] });
    // The screen reloads the config store after a reset, and a store that came back
    // empty would take the row with it - answer as the box would.
    if (String(url).includes("/api/config")) return json(live);
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
  // own CSS at 1920x1080, in the HUNGARIAN UI: the action button ends at 998.07
  // while Clear starts at 997.69, so `sibling.left >= current.right` is false
  // and Clear was in no candidate list at all. The English layout overlaps too,
  // by more (0.55 px), because "Clear" is shorter than "Törlés" and leaves the
  // action button wider - the worse case is the one worth pinning.
  //
  // The horizontal edges are those measurements to the tenth of a pixel and are
  // what the assertions turn on, so a future "simplification" back to geometry
  // fails instead of shipping. The widths and heights are along for the ride:
  // nothing reads Clear's right edge or any height.
  //
  // Which of the pair is scaled depends on which one the cursor is on, so the
  // two directions are two different sets of numbers.
  const ACTION_FOCUSED = { x: -19.57, y: 200, w: 1017.64, h: 61 };
  const ACTION_PLAIN = { x: 0, y: 200, w: 978.5, h: 59 };
  const CLEAR_PLAIN = { x: 997.69, y: 202, w: 115.91, h: 55 };
  const CLEAR_FOCUSED = { x: 995.37, y: 201, w: 120.55, h: 57 };

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

  // This direction measures clear today - the scaled box is the small one, and
  // the 50x rule leaves it a wide margin - so geometry would answer it too and
  // this test passes with the declaration removed. It pins the OUTCOME, which
  // is the half that matters to somebody holding the remote.
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
    // Right there must stay geometry's to answer. Dropping the `bound` half of
    // the guard is not a cosmetic slip: `setFocus` to a key no component has is
    // not refused, it makes that key the current focus, and the cursor is then
    // on nothing. Every arrow and every OK is silently discarded and only Back
    // gets out, on 28 of this screen's 31 rows.
    const unboundKey = keyBase(MAC) + "-up";
    expect(container.querySelector(`[data-sfocus="${unboundKey}"]`)).toBeTruthy();
    expect(container.querySelector(`[data-sfocus="${keyBase(MAC)}-clear-up"]`)).toBeNull();

    place(container.querySelector(`[data-sfocus="${unboundKey}"]`) as Element, 0, 200, 1017.64, 61);
    await navSetFocus(unboundKey);
    await remote.right();
    expect(getCurrentFocusKey()).toBe(unboundKey);
  });
});

describe("the reset question's buttons", () => {
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

// A press here can put a DIFFERENT control under the cursor and finish before
// the finger lifts, which is what makes a held OK dangerous on this screen and
// nowhere else in settings.
describe("an OK that is still held down", () => {
  beforeEach(() => {
    useConfigStore.setState({ config: CONFIG as never, error: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not teach a button after Clear has moved the cursor onto its row", async () => {
    const posted = stubShell();
    const { container } = render(<Screen />);
    await settle();
    await openButtons();

    const rowKey = keyBase(MAC) + "-settings";
    const clearKey = keyBase(MAC) + "-clear-settings";
    await navSetFocus(clearKey);
    expect(getCurrentFocusKey()).toBe(clearKey);

    // The press itself: the mapping goes, the button unmounts, and the cursor
    // lands back on the row it belonged to.
    await remote.ok();
    await settle();
    expect(container.querySelector(`[data-sfocus="${clearKey}"]`)).toBeNull();
    expect(getCurrentFocusKey()).toBe(rowKey);

    // ...and now the same hold repeats, onto the row. Without the page's
    // swallow this arms learn mode, and the bridge then eats every press on
    // this remote for ten seconds: the next button the user reaches for on a
    // remote that has gone dead is bound to the action they just cleared.
    await remote.okHeld();
    await settle();
    expect(posted.filter((p) => p.url.includes("/remote/learn"))).toHaveLength(0);
    expect(container.querySelector('[data-sfocus="remote-learn-cancel"]')).toBeNull();

    // The deliberate press that follows must still work, or the fix has traded
    // one dead screen for another.
    await remote.ok();
    await settle();
    expect(container.querySelector('[data-sfocus="remote-learn-cancel"]')).toBeTruthy();
  });
});

// The confirm button has two branches and only the destructive one is exercised
// above, so a regression that painted the reassign confirm accent again would
// have gone through. This is the other branch, reached the way a user reaches
// it: teach a button that is already bound to something else.
describe("the reassign question's buttons", () => {
  beforeEach(() => {
    useConfigStore.setState({ config: CONFIG as never, error: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("carry no fill either, and no warning colour on a question that destroys nothing", async () => {
    // 1075 is the code `settings` already holds, so learning it for another
    // action is the conflict.
    stubShell(1075);
    const { container } = render(<Screen />);
    await settle();
    await openButtons();

    await press("Home"); // arms learn mode for the `home` action
    // The screen polls the bridge every 250 ms for the captured code.
    await act(async () => await new Promise((r) => setTimeout(r, 600)));

    expect(screen.getByText("Button already mapped")).toBeTruthy();
    const yes = container.querySelector('[data-sfocus="remote-confirm-yes"]');
    const no = container.querySelector('[data-sfocus="remote-confirm-no"]');
    expect(yes).toBeTruthy();
    expect(no).toBeTruthy();
    for (const b of [yes as Element, no as Element]) {
      expect(b.className).not.toMatch(/\bbg-accent\b/);
      expect(b.className).not.toMatch(/\bbg-warn\b/);
    }
    // Nothing is thrown away by reassigning, so this one carries no warning
    // colour at all: the two buttons differ by their labels and the cursor.
    expect((yes as Element).className).not.toMatch(/\btext-warn\b/);
  });
});

// Leaving the page while a save is in flight.
//
// Back does not wait for one, and every refocus here is deferred a tick, so a
// timer armed by the press could fire after the page had gone. Spatial
// navigation does not refuse a key that no longer exists - it makes it the
// current focus - so the page underneath would be left with a dead D-pad and
// only Back working.
describe("leaving while a save is still going", () => {
  beforeEach(() => {
    useConfigStore.setState({ config: CONFIG as never, error: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not move the cursor once the page is gone", async () => {
    let release = () => {};
    const hold = { wait: new Promise<void>((r) => (release = r)) };
    stubShell(undefined, hold);
    const { container } = render(<Screen />);
    await settle();
    await openButtons();

    const rowKey = keyBase(MAC) + "-settings";
    const clearKey = keyBase(MAC) + "-clear-settings";
    await navSetFocus(clearKey);

    // The press. Its save cannot finish yet, so no refocus is armed.
    await act(async () => {
      (container.querySelector(`[data-sfocus="${clearKey}"]`) as HTMLElement).click();
    });
    await settle();
    expect(screen.queryByText("Button test")).toBeTruthy();

    // Back, while the write is still out. The page goes.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    await settle();
    expect(screen.queryByText("Button test")).toBeNull();
    const landed = getCurrentFocusKey();

    // Only now does the box answer, so the refocus is armed against a page that
    // no longer exists. It must not fire.
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(getCurrentFocusKey()).toBe(landed);
    expect(getCurrentFocusKey()).not.toBe(rowKey);
  });
});

// A Clear the box refused.
//
// The mapping and its button are still there, so the cursor has to stay on the
// button: the row beside it teaches that action on OK, which is the opposite of
// what was asked for one press earlier.
describe("a Clear the box would not accept", () => {
  beforeEach(() => {
    useConfigStore.setState({ config: CONFIG as never, error: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("leaves the cursor on the button, so the next press is the retry", async () => {
    stubShell(undefined, undefined, true);
    const { container } = render(<Screen />);
    await settle();
    await openButtons();

    const clearKey = keyBase(MAC) + "-clear-settings";
    await navSetFocus(clearKey);
    await act(async () => {
      (container.querySelector(`[data-sfocus="${clearKey}"]`) as HTMLElement).click();
    });
    await settle();

    // Nothing was cleared, so the button is still on screen...
    expect(container.querySelector(`[data-sfocus="${clearKey}"]`)).toBeTruthy();
    // ...and the cursor has not wandered onto the row that would teach it.
    expect(getCurrentFocusKey()).toBe(clearKey);
  });
});
