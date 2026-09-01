import { describe, it, expect } from "vitest";
import { homeRowTarget } from "./homeNav";

// The rows HOME actually has, in the order they are drawn.
const HEADER = ["home-settings", "home-power"];
const WIDGETS = ["widget:spotify"];
const RUNNING = ["run:plex", "runx:plex", "run:spotify", "runx:spotify"];
const TILES = ["tile:plex", "tile:spotify", "tile:files", "tile:__getmore"];
const ALL = [HEADER, WIDGETS, RUNNING, TILES];
const yes = () => true;

describe("homeRowTarget", () => {
  it("enters the row above at its first key, not at the key above the cursor", () => {
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

  it("skips a row that has nothing in it", () => {
    const rows = [HEADER, [], [], TILES];
    expect(homeRowTarget(rows, "tile:plex", "up", yes)).toBe("home-settings");
    expect(homeRowTarget(rows, "home-power", "down", yes)).toBe("tile:plex");
  });

  it("skips a key spatial navigation does not know, and the row when none is left", () => {
    // A widget whose app has been uninstalled is still in the list until the
    // next fetch answers: aiming at it would swallow the press.
    const exists = (key: string) => key !== "widget:spotify";
    expect(homeRowTarget(ALL, "run:plex", "up", exists)).toBe("home-settings");
    const half = (key: string) => key !== "run:plex";
    expect(homeRowTarget(ALL, "tile:files", "up", half)).toBe("runx:plex");
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

  it("enters the rail at the tile it names first", () => {
    // The rail is the one row that scrolls, so HOME puts the tile the cursor
    // left at the head of that row.
    const remembered = [HEADER, WIDGETS, RUNNING, ["tile:files", "tile:plex", "tile:spotify", "tile:__getmore"]];
    expect(homeRowTarget(remembered, "run:plex", "down", yes)).toBe("tile:files");
  });
});
