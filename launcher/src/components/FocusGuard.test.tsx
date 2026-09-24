import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { Home } from "./Home";
import { setupRemote, place, remote, setFocus, getCurrentFocusKey, flushFocus } from "../test/remote";
import { useAppPrefsStore } from "../stores/appPrefs";
import { forgetRows } from "../lib/homeNav";
import { installFocusGuard, setFocusFallback, focusIsLost, HEALED_KEY_EVENT } from "@sdk/focusGuard";
import type { AppManifest } from "../lib/types";
import { PinPad } from "@sdk/PinPad";

// A cursor pointing at a focusable that has gone is a dead remote: every press
// resolves against nothing. The guard brings it back to where the screen says it
// belongs, on the next navigation key or when the window is shown again.

setupRemote();

let APPS: AppManifest[] = [];

vi.mock("../lib/api", () => ({
  fetchApps: () => Promise.resolve(APPS),
  quitApp: () => Promise.resolve(),
}));
vi.mock("../lib/widgets", () => ({
  fetchWidgets: () => Promise.resolve([]),
  subscribeWidgets: () => () => {},
}));
vi.mock("../lib/shell", () => ({ launchApp: () => true }));

function app(id: string): AppManifest {
  return { id, name: id, type: "webclient", status: "ready", icon: "" } as AppManifest;
}
const tile = (id: string): string => `tile:${id}`;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

async function draw(): Promise<void> {
  const { container } = render(<Home />);
  await settle();
  const at = (sel: string, x: number, y: number, w = 200, h = 60) => {
    const el = container.querySelector(sel);
    if (!el) throw new Error("no element for " + sel);
    place(el, x, y, w, h);
  };
  at('[data-sfocus="home-power"]', 1500, 0, 60, 60);
  at('[data-sfocus="home-settings"]', 1600, 0, 60, 60);
  APPS.forEach((a, i) => at(`[data-id="${a.id}"]`, 100 + i * 340, 700, 320, 200));
  const more = container.querySelector('[data-id="__getmore"]');
  if (more) place(more, 100 + APPS.length * 340, 700, 320, 200);
}

/** Point the cursor at a key nothing registered, the state the guard exists for. */
async function loseFocus(): Promise<void> {
  await setFocus("gone:away");
  expect(focusIsLost()).toBe(true);
}

let stop: (() => void) | null = null;
beforeEach(() => {
  forgetRows();
  useAppPrefsStore.setState({ order: [], hidden: [], getMoreHidden: false });
  APPS = [app("files"), app("mediaclient"), app("spotify")];
});
afterEach(() => {
  stop?.();
  stop = null;
});

describe("focus guard", () => {
  it("without it, a lost cursor stays lost: presses do nothing", async () => {
    await draw();
    await loseFocus();
    await remote.right();
    await remote.left();
    await settle();
    expect(getCurrentFocusKey()).toBe("gone:away");
  });

  it("brings a lost cursor back to the tile the rail was left on, and spends that press", async () => {
    stop = installFocusGuard();
    await draw();
    await setFocus(tile("spotify"));
    await settle();
    await loseFocus();
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe(tile("spotify"));
    // The next press is an ordinary one again.
    await remote.left();
    await settle();
    expect(getCurrentFocusKey()).toBe(tile("mediaclient"));
  });

  it("the press that healed reaches no other listener", async () => {
    stop = installFocusGuard();
    await draw();
    const seen: string[] = [];
    const later = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", later);
    try {
      await loseFocus();
      await remote.down();
      await settle();
      expect(seen).toEqual([]);
      await remote.right();
      await settle();
      expect(seen).toEqual(["ArrowRight"]);
    } finally {
      window.removeEventListener("keydown", later);
    }
  });

  it("says which press it spent, so presses are still counted", async () => {
    stop = installFocusGuard();
    await draw();
    const healed: string[] = [];
    const on = (e: Event) => healed.push((e as CustomEvent<{ key: string }>).detail.key);
    window.addEventListener(HEALED_KEY_EVENT, on);
    try {
      await loseFocus();
      await remote.down();
      await settle();
      expect(healed).toEqual(["ArrowDown"]);
      await remote.right();
      await settle();
      expect(healed).toEqual(["ArrowDown"]); // a press that did not heal is an ordinary keydown
    } finally {
      window.removeEventListener(HEALED_KEY_EVENT, on);
    }
  });

  it("heals when the window is shown again, with no press at all", async () => {
    stop = installFocusGuard();
    await draw();
    await loseFocus();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(getCurrentFocusKey()).toBe(tile("files"));
  });

  it("leaves a cursor that is somewhere real alone", async () => {
    stop = installFocusGuard();
    await draw();
    await setFocus(tile("files"));
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe(tile("mediaclient"));
  });

  it("asks the innermost screen first, and skips an answer that does not exist either", async () => {
    stop = installFocusGuard();
    await draw();
    const offMissing = setFocusFallback(() => "also:gone");
    const offInner = setFocusFallback(() => ["nope", "home-settings"]);
    await loseFocus();
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe("home-settings");

    // Once the inner one is gone, a key that does not exist is not trusted:
    // the next provider down (HOME's) answers instead.
    offInner();
    await loseFocus();
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe(tile("files"));
    offMissing();
  });

  it("while a PIN pad is up, a lost cursor goes onto the pad, not behind it", async () => {
    stop = installFocusGuard();
    await draw();
    const pad = render(<PinPad title="PIN" onSubmit={() => {}} onCancel={() => {}} />);
    await settle();
    await loseFocus();
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe("pin-1");
    pad.unmount();
  });

  it("an overlay keeps winning when the screen under it refreshes", async () => {
    stop = installFocusGuard();
    await draw();
    const pad = render(<PinPad title="PIN" onSubmit={() => {}} onCancel={() => {}} />);
    await settle();
    // HOME re-renders with a different tile set while the pad is up.
    await act(async () => {
      useAppPrefsStore.setState({ getMoreHidden: true });
    });
    await settle();
    await loseFocus();
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe("pin-1");
    pad.unmount();
  });

  it("stops after uninstall", async () => {
    installFocusGuard()();
    await draw();
    await loseFocus();
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe("gone:away");
  });
});
