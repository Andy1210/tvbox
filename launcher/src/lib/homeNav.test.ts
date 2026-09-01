import { describe, it, expect, beforeEach } from "vitest";
import { forgetRows, homeRowEnd, homeRowTarget, rememberRow, type HomeRow } from "./homeNav";

// The rows HOME actually has, in the order they are drawn: keys left to right,
// entries the keys a press may land on. The running row's quit buttons are keys
// and not entries, which is the rule this file exists to hold.
const HEADER: HomeRow = {
  name: "",
  keys: ["home-power", "home-settings"],
  entries: ["home-settings", "home-power"],
};
const WIDGETS: HomeRow = { name: "widgets", keys: ["widget:spotify"], entries: ["widget:spotify"] };
const RUNNING: HomeRow = {
  name: "running",
  keys: ["run:plex", "runx:plex", "run:spotify", "runx:spotify"],
  entries: ["run:plex", "run:spotify"],
};
const TILES: HomeRow = {
  name: "rail",
  keys: ["tile:plex", "tile:spotify", "tile:files", "tile:__getmore"],
  entries: ["tile:plex", "tile:spotify", "tile:files", "tile:__getmore"],
};
const ALL = [HEADER, WIDGETS, RUNNING, TILES];
const yes = () => true;

beforeEach(() => forgetRows());

describe("homeRowTarget", () => {
  it("enters the row above at its first entry, not at the key above the cursor", () => {
    // The whole complaint: the quit button is beside the chip, and geometry
    // reaches whichever of the two is nearer.
    expect(homeRowTarget(ALL, "tile:files", "up", yes)).toBe("run:plex");
    expect(homeRowTarget(ALL, "tile:__getmore", "up", yes)).toBe("run:plex");
  });

  it("steps one row per press, in both directions", () => {
    expect(homeRowTarget(ALL, "run:plex", "up", yes)).toBe("widget:spotify");
    expect(homeRowTarget(ALL, "widget:spotify", "up", yes)).toBe("home-settings");
    expect(homeRowTarget(ALL, "home-settings", "down", yes)).toBe("widget:spotify");
    expect(homeRowTarget(ALL, "widget:spotify", "down", yes)).toBe("run:plex");
    expect(homeRowTarget(ALL, "run:plex", "down", yes)).toBe("tile:plex");
  });

  it("leaves a row from its quit button the same way as from its chip", () => {
    expect(homeRowTarget(ALL, "runx:spotify", "up", yes)).toBe("widget:spotify");
    expect(homeRowTarget(ALL, "runx:spotify", "down", yes)).toBe("tile:plex");
  });

  it("never lands on a quit button, even as a row's remembered place", () => {
    rememberRow("running", "runx:spotify");
    expect(homeRowTarget(ALL, "tile:files", "up", yes)).toBe("run:plex");
  });

  it("comes back to where a row was left", () => {
    rememberRow("running", "run:spotify");
    rememberRow("rail", "tile:files");
    expect(homeRowTarget(ALL, "tile:files", "up", yes)).toBe("run:spotify");
    expect(homeRowTarget(ALL, "run:spotify", "down", yes)).toBe("tile:files");
    // ...and forgets an app that has gone, rather than aiming at it.
    rememberRow("running", "run:gone");
    expect(homeRowTarget(ALL, "tile:files", "up", yes)).toBe("run:plex");
  });

  it("gives the header no memory, because that is where the power menu is", () => {
    rememberRow("", "home-power");
    expect(homeRowTarget(ALL, "widget:spotify", "up", yes)).toBe("home-settings");
  });

  it("skips a row that has nothing in it", () => {
    const rows = [
      HEADER,
      { name: "widgets", keys: [], entries: [] },
      { name: "running", keys: [], entries: [] },
      TILES,
    ];
    expect(homeRowTarget(rows, "tile:plex", "up", yes)).toBe("home-settings");
    expect(homeRowTarget(rows, "home-power", "down", yes)).toBe("tile:plex");
  });

  it("skips a key spatial navigation does not know, and the row when none is left", () => {
    // A widget whose app has been uninstalled is still in the list until the
    // next fetch answers: aiming at it would swallow the press.
    const exists = (key: string) => key !== "widget:spotify";
    expect(homeRowTarget(ALL, "run:plex", "up", exists)).toBe("home-settings");
    const half = (key: string) => key !== "run:plex";
    expect(homeRowTarget(ALL, "tile:files", "up", half)).toBe("run:spotify");
  });

  it("hands the press back at the top and the bottom", () => {
    expect(homeRowTarget(ALL, "home-settings", "up", yes)).toBeNull();
    expect(homeRowTarget(ALL, "tile:__getmore", "down", yes)).toBeNull();
  });

  it("hands the press back for a key that is on no row", () => {
    // A modal's own button: the power menu is drawn over HOME, and its rows are
    // its own business.
    expect(homeRowTarget(ALL, "power-reboot", "up", yes)).toBeNull();
  });
});

describe("homeRowEnd", () => {
  it("goes round at the ends rather than off the row", () => {
    expect(homeRowEnd(ALL, "tile:plex", "left", yes)).toBe("tile:__getmore");
    expect(homeRowEnd(ALL, "tile:__getmore", "right", yes)).toBe("tile:plex");
    expect(homeRowEnd(ALL, "home-power", "left", yes)).toBe("home-settings");
  });

  it("wraps the running row chip to chip, never onto a quit button", () => {
    expect(homeRowEnd(ALL, "runx:spotify", "right", yes)).toBe("run:plex");
    expect(homeRowEnd(ALL, "run:plex", "left", yes)).toBe("run:spotify");
  });

  it("leaves the middle of a row to geometry", () => {
    expect(homeRowEnd(ALL, "run:plex", "right", yes)).toBeUndefined();
    expect(homeRowEnd(ALL, "runx:spotify", "left", yes)).toBeUndefined();
    expect(homeRowEnd(ALL, "tile:spotify", "left", yes)).toBeUndefined();
  });

  it("keeps the press when a row has nowhere to go round to", () => {
    const one: HomeRow = { name: "running", keys: ["run:plex", "runx:plex"], entries: ["run:plex"] };
    // Left from the only chip: the row's other key is its quit button, which is
    // not a place to land, so the press stays in the row rather than reaching
    // the header above and to the right of it.
    expect(homeRowEnd([HEADER, one], "run:plex", "left", yes)).toBeNull();
  });

  it("says nothing about a key that is on no row", () => {
    expect(homeRowEnd(ALL, "power-reboot", "left", yes)).toBeUndefined();
  });

  it("goes round to something that is really there", () => {
    const gone = (key: string) => key !== "tile:__getmore";
    expect(homeRowEnd(ALL, "tile:plex", "left", gone)).toBe("tile:files");
  });

  it("judges the end of a row by what is on the screen", () => {
    // A widget whose app has been uninstalled is still in the list until the
    // next fetch answers. Counting it made the card beside it look like the
    // middle of the row, so the press fell through to geometry and left the
    // row - which is the leak this function exists to stop.
    const widgets: HomeRow = {
      name: "widgets",
      keys: ["widget:gone", "widget:files", "widget:also-gone"],
      entries: ["widget:gone", "widget:files", "widget:also-gone"],
    };
    const only = (key: string) => key === "widget:files";
    expect(homeRowEnd([widgets], "widget:files", "right", only)).toBeNull();
    expect(homeRowEnd([widgets], "widget:files", "left", only)).toBeNull();
    // ...and a key that is in the list but not on the screen is nobody's end.
    expect(homeRowEnd([widgets], "widget:gone", "left", only)).toBeUndefined();
  });
});
