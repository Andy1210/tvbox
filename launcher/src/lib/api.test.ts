import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchApps } from "./api";

// Rule #7 (degrade gracefully): with no shell REACHABLE - vite dev, or a shell
// hiccup - the launcher falls back to a built-in tile list so the screen is
// never dead. But an EMPTY list from a reachable shell is a valid answer (a
// fresh box has no apps installed - Kodi model) and must be returned as-is, not
// mistaken for a failure (that wrongly seeded 4 phantom apps on a fresh box).
describe("fetchApps", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.unstubAllGlobals());

  const ok = (data: unknown) => vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(data) });

  it("returns the shell's list when it is a non-empty array", async () => {
    vi.stubGlobal("fetch", ok([{ id: "plex", name: "Plex", type: "webclient", status: "ready" }]));
    const apps = await fetchApps();
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe("plex");
  });

  it("falls back to the built-in list on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no shell")));
    const ids = (await fetchApps()).map((a) => a.id);
    expect(ids).toEqual(["plex", "livetv", "youtube", "spotify"]);
  });

  it("returns an empty list as-is (fresh box - no apps installed, NOT a failure)", async () => {
    vi.stubGlobal("fetch", ok([]));
    expect(await fetchApps()).toEqual([]);
  });

  it("falls back on a non-array payload", async () => {
    vi.stubGlobal("fetch", ok({ oops: true }));
    expect((await fetchApps()).length).toBeGreaterThan(0);
  });

  it("falls back on a non-OK HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect((await fetchApps()).length).toBeGreaterThan(0);
  });
});
