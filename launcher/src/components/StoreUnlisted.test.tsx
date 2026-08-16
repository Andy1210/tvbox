import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { StoreSettings } from "./StoreSettings";
import { AppDetail } from "./AppDetail";
import { setupRemote, setFocus, remote, getCurrentFocusKey } from "../test/remote";
import { useConfigStore } from "../stores/config";
import type { StoreEntry } from "../lib/api";

// Taking off an app that no registry offers any more.
//
// It keeps running - the box builds its grid from what is on disk - but Remove
// lives only in a store row, and an app nobody lists had no row. So a retired
// app could not be removed from the television at all, only over the API.

setupRemote();

const OFFICIAL = "https://andy1210.github.io/tvbox-apps/index.json";

beforeEach(() => {
  useConfigStore.setState({
    config: { parental: { pinSet: false, requirePin: false, lockedGroups: [] } } as never,
  });
});
afterEach(() => vi.unstubAllGlobals());

function entry(over: Partial<StoreEntry> = {}): StoreEntry {
  return {
    id: "listedapp",
    name: "Listed",
    version: "1.0.0",
    installed: true,
    installedVersion: "1.0.0",
    updateAvailable: false,
    installing: false,
    builtin: false,
    source: { url: OFFICIAL, official: true, name: null, autoUpdate: true },
    alsoIn: [],
    ...over,
  } as StoreEntry;
}

const gone = (over: Partial<StoreEntry> = {}): StoreEntry =>
  entry({
    id: "goneapp",
    name: "Gone",
    source: null,
    alsoIn: [],
    unlisted: true,
    unlistedFrom: OFFICIAL,
    ...over,
  });

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("the detail of an app nobody offers", () => {
  it("says why, where it came from, and offers Remove rather than Install", async () => {
    const { container } = render(
      <AppDetail
        app={gone()}
        onInstall={() => {}}
        onUpdate={() => {}}
        onFlatpakUpdate={() => {}}
        onRemove={() => {}}
        onSetUrl={() => {}}
        onExit={() => {}}
      />,
    );
    await settle();
    expect(container.textContent).toContain("No source offers this app any more");
    // The way back, which is the half that turns a dead end into an action.
    expect(container.textContent).toContain(OFFICIAL);
    expect(container.querySelector('[data-sfocus="detail-install"]')).toBeNull();
    expect(container.querySelector('[data-sfocus="detail-remove"]')).not.toBeNull();
    // And that is where the cursor lands, so one press does the only thing there
    // is to do here.
    expect(getCurrentFocusKey()).toBe("detail-remove");
  });
});

describe("the store list", () => {
  function stub(apps: () => StoreEntry[], onUninstall?: () => void) {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        onUninstall?.();
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ registry: OFFICIAL, apps: apps(), error: null, updates: [], autoUpdates: [], sources: [] }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    });
  }

  it("groups them under a heading of their own", async () => {
    const list: StoreEntry[] = [entry(), gone()];
    stub(() => list);
    const { container } = render(<StoreSettings />);
    await settle();
    expect(container.textContent).toContain("Installed, no longer offered by any source");
    expect(container.querySelector('[data-sfocus="store-app-goneapp"]')).not.toBeNull();
  });

  it("does not strand the remote when the last row of one is removed", async () => {
    // The row is gone once the app is, so the detail unmounts with it. Focus was
    // sent to `detail-install`, which for this app never mounts again - and a
    // cursor on a key nothing owns discards every press after it, with only Back
    // out.
    let list: StoreEntry[] = [entry(), gone()];
    stub(
      () => list,
      () => {
        list = [entry()];
      },
    );
    render(<StoreSettings />);
    await settle();

    await setFocus("store-app-goneapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();

    const where = getCurrentFocusKey();
    expect(where).not.toBe("detail-install");
    // Whatever it is, it has to be something that is actually on screen.
    expect(
      document.querySelector(`[data-sfocus="${where}"]`),
      `cursor parked on ${where}, which is not mounted`,
    ).not.toBeNull();
  });
});
