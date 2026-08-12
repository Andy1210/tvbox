import { describe, it, expect, vi, afterEach } from "vitest";
import { radioState, setBuiltinRadio, applyBuiltinRadio } from "./radios";

// The built-in radios are the one setting here that survives a reboot and can leave
// a box with nothing able to reach it, so what is pinned is the round trip: the
// confirmation the box asks for has to reach it on the next press, a failure has to
// carry systemd's own words to the screen, and an unreachable shell must not read
// as "both radios are on".

function stubFetch(answer: unknown, capture?: (init: RequestInit) => void) {
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    if (init) capture?.(init);
    return Promise.resolve(new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } }));
  });
}

describe("the built-in radio setting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads as unknown when the shell cannot be reached", async () => {
    // Not "both on": the UI offers nothing on an unreadable answer, where a wrong
    // reading would offer to turn off a radio that is already off.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));
    expect(await radioState()).toEqual({ wifi: null, bt: null, readable: false, helper: false });
  });

  it("sends the direction and the confirmation as real booleans", async () => {
    let body: unknown = null;
    stubFetch({ ok: true }, (init) => (body = JSON.parse(String(init.body))));
    await setBuiltinRadio("wifi", false);
    expect(body).toEqual({ radio: "wifi", on: false, confirm: false });
    await setBuiltinRadio("bt", true, true);
    expect(body).toEqual({ radio: "bt", on: true, confirm: true });
  });

  it("turns the box's refusal into a confirmation, not a failure", async () => {
    stubFetch({ ok: false, error: "needs-confirm" });
    const r = await applyBuiltinRadio("wifi", false, false);
    expect(r.needsConfirm).toBe(true);
    expect(r.key).toBe("radios.confirmStrand");
  });

  it("carries systemd's own message, because the box user cannot read the journal", async () => {
    // "Access denied" (no polkit grant) and "Unit not found" (never provisioned) are
    // the two failures this feature actually hits, and they are indistinguishable
    // from the couch without this line.
    stubFetch({
      ok: false,
      error: "apply-failed",
      detail: "Failed to start tvbox-radio@bt-off.service: Access denied",
    });
    const r = await applyBuiltinRadio("bt", false, false);
    expect(r.needsConfirm).toBe(false);
    expect(r.key).toBe("radios.failed");
    expect(r.detail).toMatch(/Access denied/);
  });

  it("reports a change that landed as needing a restart", async () => {
    stubFetch({ ok: true, radio: "bt", on: false, rebootRequired: true });
    expect(await applyBuiltinRadio("bt", false, true)).toEqual({ key: "radios.needsRestart", needsConfirm: false });
  });
});
