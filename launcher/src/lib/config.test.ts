import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchConfig } from "./config";

// Rule #7 again: fetchConfig returns null ONLY when the shell is unreachable, so
// the UI can tell "transient hiccup -> offer retry" apart from a real config.
// Returning {} on a hiccup would drop the user into first-run onboarding.
describe("fetchConfig", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.unstubAllGlobals());

  it("returns the parsed config when the shell responds", async () => {
    const cfg = { parental: { pinSet: true, lockedGroups: [] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(cfg) }));
    const res = await fetchConfig();
    expect(res).toEqual(cfg);
  });

  it("returns null on a network error (retry, not onboarding)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await fetchConfig()).toBeNull();
  });

  it("returns null on a non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    expect(await fetchConfig()).toBeNull();
  });
});
