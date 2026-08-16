import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { AppDetail } from "./AppDetail";
import { setupRemote, setFocus, remote, getCurrentFocusKey, place, flushFocus } from "../test/remote";
import { useConfigStore } from "../stores/config";
import type { StoreEntry } from "../lib/api";

// Taking an app from a registry other than the one it stands with.
//
// The pin is what stops a published app from taking over a local build of the
// same id, and it is right - but it also means an app can never LEAVE the
// registry it came from unless somebody says so. This is where that is said: one
// press per other registry, on the screen the install press is already on.
//
// The case it exists for is an app that is BOTH published and being worked on,
// where the two carry the same version number: a debug build stands in for the
// published one under its own version, so nothing about the version can decide
// this.

setupRemote();

// The child lock is global state and another suite may have left one set, so it
// is stated here rather than assumed - the lock's presence is the whole subject
// of one of these tests.
beforeEach(() => {
  useConfigStore.setState({
    config: { parental: { pinSet: false, requirePin: false, lockedGroups: [] } } as never,
  });
});

const OFFICIAL = "https://andy1210.github.io/tvbox-apps/index.json";
const LOCAL = "http://192.168.1.19:8790/index.json";

function entry(over: Partial<StoreEntry> = {}): StoreEntry {
  return {
    id: "mediaclient",
    name: "Media",
    version: "0.54.2",
    installed: true,
    installedVersion: "0.54.2",
    updateAvailable: false,
    installing: false,
    builtin: false,
    source: { url: OFFICIAL, official: true, name: null, autoUpdate: true },
    alsoIn: [{ url: LOCAL, name: "dev", official: false }],
    ...over,
  } as StoreEntry;
}

/**
 * Let the screen's own opening focus land before the test moves it.
 *
 * `AppDetail` focuses its first action a macrotask after mount, so a `setFocus`
 * issued straight after render is overwritten - and an assertion that happens to
 * name the same key then passes without the press doing anything.
 */
async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushFocus();
}

function draw(app: StoreEntry, onSwitchSource?: (url: string) => void): HTMLElement {
  const { container } = render(
    <AppDetail
      app={app}
      onInstall={() => {}}
      onSwitchSource={onSwitchSource}
      onUpdate={() => {}}
      onFlatpakUpdate={() => {}}
      onRemove={() => {}}
      onSetUrl={() => {}}
      onExit={() => {}}
    />,
  );
  return container;
}

describe("an app offered by more than one registry", () => {
  it("offers a press per other registry, named", () => {
    const container = draw(entry(), vi.fn());
    expect(container.textContent).toContain("dev");
  });

  it("takes it from the one that was pressed", async () => {
    const switched = vi.fn();
    draw(entry(), switched);

    await setFocus(`detail-source-${LOCAL}`);
    await act(async () => {
      await remote.ok();
    });

    // The URL, not the name: the box matches it against its own configured list,
    // and two registries can carry the same label.
    expect(switched).toHaveBeenCalledWith(LOCAL);
  });

  it("says nothing when no other registry has it", () => {
    // Asserted on the ROW's own label, not on the registry's name: with an empty
    // list the buttons render nothing either way, so looking for "dev" passed
    // even with the length guard removed - a test that could not fail.
    const container = draw(entry({ alsoIn: [] }), vi.fn());
    expect(container.textContent).not.toContain("Take it from");
  });

  it("says nothing on a built-in app", () => {
    // Every press would be refused by the box ("built-in app"), and a refusal is
    // a screen somebody has to get out of.
    const container = draw(entry({ builtin: true }), vi.fn());
    expect(container.textContent).not.toContain("Take it from");
  });

  it("asks for the PIN first, like the Install button beside it", async () => {
    // This press can perform a FIRST install, which is the action the child lock
    // exists for - and a lock the button beside it honours is not a lock. Stated
    // as the lock STOPPING it, because that is the property: with no lock the
    // press goes through either way and the assertion would prove nothing.
    useConfigStore.setState({
      config: { parental: { pinSet: true, requirePin: true, lockedGroups: [] } } as never,
    });
    const switched = vi.fn();
    draw(entry({ installed: false, installedVersion: null }), switched);

    await setFocus(`detail-source-${LOCAL}`);
    await act(async () => {
      await remote.ok();
    });

    expect(switched, "the lock has to stand in front of this press too").not.toHaveBeenCalled();
  });

  it("keeps out of the way while an install is running", () => {
    // The buttons sit where the progress indicator goes, and pressing one
    // mid-install would start a second fetch of the same app.
    const container = draw(entry({ installing: true }), vi.fn());
    expect(container.textContent).not.toContain("Take it from");
  });
});

// NOT tested here: that Down from a registry button reaches the app's own
// action. The failure it fixes is geometric - measured in a real browser at
// 1080p, where the "Take it from:" label pushes the buttons right of the action
// row and the corner distance then picks Uninstall over Update, or skips the row
// entirely when a registry has a long name. Three attempts to reproduce that in
// this harness produced tests that passed against the unfixed code, because the
// rectangles here are the ones a test places rather than the ones a browser
// computes. The mechanism the fix uses - a focused button answering an arrow
// before spatial navigation resolves it - is the SDK's own, shipped and used by
// the media client's A-Z strip. Left untested rather than tested falsely.

describe("a registry that did not answer", () => {
  it("is offered, and says so", () => {
    // It is the way back to where the app came from, so it stays - but a button
    // that looks like the others and can only fail is worse than one that
    // explains itself.
    const container = draw(entry({ alsoIn: [{ url: LOCAL, name: "dev", official: false, silent: true }] }), vi.fn());
    expect(container.textContent).toContain("dev");
    expect(container.textContent).toContain("not answering");
  });
});
