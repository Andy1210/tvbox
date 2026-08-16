import { describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { AppDetail } from "./AppDetail";
import { setupRemote, setFocus, remote } from "../test/remote";
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
    // With a handler, so the absence is the list being empty rather than the
    // screen not offering the feature at all.
    const container = draw(entry({ alsoIn: [] }), vi.fn());
    expect(container.textContent).not.toContain("dev");
  });

  it("keeps out of the way while an install is running", () => {
    // The buttons sit where the progress indicator goes, and pressing one
    // mid-install would start a second fetch of the same app.
    const container = draw(entry({ installing: true }), vi.fn());
    expect(container.textContent).not.toContain("dev");
  });
});
