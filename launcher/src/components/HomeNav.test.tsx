import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { Home } from "./Home";
import { setupRemote, place, remote, setFocus, getCurrentFocusKey, flushFocus } from "../test/remote";
import { useAppPrefsStore } from "../stores/appPrefs";
import type { AppManifest } from "../lib/types";
import type { HomeWidget } from "../lib/widgets";

// Up and Down on HOME, which used to be decided by geometry alone.
//
// HOME's rows are not laid out like a grid: the header sits at the right edge,
// the running apps and the widgets at the left, and the app rail spans the
// screen. So Up from a tile on the right of the rail reached the settings gear,
// passing over the running apps a row closer - and where it did reach them it
// landed on a quit button as often as on the app, because each running app is a
// chip with an X glued to it.
//
// The rectangles below are that layout, to scale enough for the geometry to
// behave as it does on the box.

setupRemote();

let APPS: AppManifest[] = [];
let WIDGETS: HomeWidget[] = [];
let quit: string[] = [];

vi.mock("../lib/api", () => ({
  fetchApps: () => Promise.resolve(APPS),
  quitApp: (id: string) => {
    quit.push(id);
    APPS = APPS.map((a) => (a.id === id ? { ...a, running: false } : a));
    return Promise.resolve();
  },
}));
vi.mock("../lib/widgets", () => ({
  fetchWidgets: () => Promise.resolve(WIDGETS),
  subscribeWidgets: () => () => {},
}));
vi.mock("../lib/shell", () => ({ launchApp: () => true }));

function app(id: string, over: Partial<AppManifest> = {}): AppManifest {
  return { id, name: id, type: "webclient", status: "ready", icon: "", ...over } as AppManifest;
}

/** The keys HOME builds, spelled here so a rename cannot pass unnoticed. */
const tile = (id: string): string => `tile:${id}`;
const run = (id: string): string => `run:${id}`;
const quitBtn = (id: string): string => `runx:${id}`;
const widget = (id: string): string => `widget:${id}`;

/**
 * Let the deferred setFocus (a macrotask) run, then the scheduler settle.
 *
 * Three turns, not one: HOME places its own first focus from a timer too, and
 * one turn leaves that one pending - it then fired in the middle of the next
 * press and pulled the cursor back to the first tile.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

/** Render HOME and lay its focusables out the way the box draws them. */
async function draw(): Promise<HTMLElement> {
  const { container } = render(<Home />);
  await settle(); // the first app-list fetch, and the initial focus it places
  const at = (sel: string, x: number, y: number, w = 200, h = 60) => {
    const el = container.querySelector(sel);
    if (!el) throw new Error("no element for " + sel);
    place(el, x, y, w, h);
  };
  at('[data-sfocus="home-power"]', 1500, 0, 60, 60);
  at('[data-sfocus="home-settings"]', 1600, 0, 60, 60);
  WIDGETS.forEach((w, i) => at(`[data-sfocus="${widget(w.id)}"]`, 100 + i * 320, 200, 300, 80));
  APPS.filter((a) => a.running).forEach((a, i) => {
    at(`[data-sfocus="${run(a.id)}"]`, 100 + i * 360, 400, 260, 70);
    at(`[data-sfocus="${quitBtn(a.id)}"]`, 370 + i * 360, 400, 60, 70);
  });
  APPS.filter((a) => a.ready !== false).forEach((a, i) => at(`[data-id="${a.id}"]`, 100 + i * 340, 700, 320, 200));
  at('[data-id="__getmore"]', 100 + APPS.length * 340, 700, 320, 200);
  return container;
}

beforeEach(() => {
  useAppPrefsStore.setState({ order: [], hidden: [], getMoreHidden: false });
  APPS = [app("files"), app("mediaclient", { running: true }), app("spotify", { running: true }), app("xcloud")];
  WIDGETS = [];
  quit = [];
});

describe("HOME vertical navigation", () => {
  it("goes up from the rail to the first running app, not to the gear or the X", async () => {
    await draw();
    // The rightmost tile: this is the corner the complaint came from, where the
    // settings gear is the nearest thing above.
    await setFocus(tile("__getmore"));
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("mediaclient"));
  });

  it("reaches the gear one row at a time, and comes back down the same way", async () => {
    WIDGETS = [{ id: "spotify", title: "Now playing", subtitle: "" }];
    await draw();
    await setFocus(tile("files"));
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("mediaclient"));
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe(widget("spotify"));
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe("home-settings");
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe("home-settings"); // the top of the screen
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe(widget("spotify"));
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("mediaclient"));
  });

  it("leaves a quit button by the row it is in, not by what is beside it", async () => {
    await draw();
    await setFocus(quitBtn("spotify"));
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe("home-settings");
    await setFocus(quitBtn("spotify"));
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe(tile("files"));
  });

  it("still reaches a quit button, which is what Right is for", async () => {
    await draw();
    await setFocus(run("spotify"));
    expect(getCurrentFocusKey()).toBe(run("spotify"));
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe(quitBtn("spotify"));
  });

  it("comes back to where each row was left, not to its first item", async () => {
    WIDGETS = [
      { id: "files", title: "One", subtitle: "" },
      { id: "xcloud", title: "Two", subtitle: "" },
    ];
    await draw();
    // Walk to the second running app and the second widget, then come back to
    // each from below: the highlight must not jump back to the first.
    await setFocus(run("spotify"));
    await settle();
    await setFocus(widget("xcloud"));
    await settle();
    await setFocus(tile("xcloud"));
    await settle();
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("spotify"));
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe(widget("xcloud"));
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("spotify"));
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe(tile("xcloud"));
  });

  it("remembers the app of a quit button, never the button", async () => {
    await draw();
    await setFocus(quitBtn("spotify"));
    await settle();
    await setFocus(tile("files"));
    await settle();
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("spotify"));
  });

  it("goes round the running row rather than off it", async () => {
    await draw();
    // Right off the last quit button used to land on the power button: the
    // header is a legal horizontal candidate from anywhere left of it.
    await setFocus(quitBtn("spotify"));
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("mediaclient"));
    await remote.left();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("spotify"));
  });

  it("keeps a single running app's row to itself", async () => {
    APPS = [app("files"), app("mediaclient", { running: true }), app("xcloud")];
    await draw();
    await setFocus(quitBtn("mediaclient"));
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe(quitBtn("mediaclient"));
    await setFocus(run("mediaclient"));
    await remote.left();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("mediaclient"));
  });

  it("goes straight to the gear when nothing is running", async () => {
    APPS = [app("files"), app("xcloud")];
    await draw();
    await setFocus(tile("files"));
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe("home-settings");
    await remote.left();
    await settle();
    expect(getCurrentFocusKey()).toBe("home-power");
  });

  it("does not eat the press at the bottom of the screen", async () => {
    await draw();
    await setFocus(tile("files"));
    await remote.down();
    await settle();
    expect(getCurrentFocusKey()).toBe(tile("files"));
  });

  it("cannot be steered by an app whose id reads like another row's key", async () => {
    // App ids are only constrained to [a-z0-9_-], and nothing is reserved: a
    // tile keyed by the bare id used to overwrite whichever key it collided
    // with, and it mounts last. The colon in every derived key is what stops it.
    APPS = [app("home-settings"), app("run-mediaclient"), app("mediaclient", { running: true })];
    await draw();
    await setFocus(tile("home-settings"));
    await remote.up();
    await settle();
    expect(getCurrentFocusKey()).toBe(run("mediaclient"));
    await remote.up();
    await settle();
    // The real gear, not the tile calling itself one.
    expect(getCurrentFocusKey()).toBe("home-settings");
  });

  it("lands on the tile the rail was left on after quitting the last running app", async () => {
    APPS = [app("files"), app("mediaclient", { running: true }), app("xcloud")];
    const container = await draw();
    await setFocus(tile("xcloud"));
    await settle();
    await remote.up();
    await settle();
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe(quitBtn("mediaclient"));
    await act(async () => {
      (container.querySelector(`[data-sfocus="${quitBtn("mediaclient")}"]`) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();
    expect(quit).toEqual(["mediaclient"]);
    expect(getCurrentFocusKey()).toBe(tile("xcloud"));
  });
});
