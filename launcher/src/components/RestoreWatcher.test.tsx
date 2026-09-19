import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { RestoreWatcher } from "./RestoreWatcher";
import type { ReconcileStatus } from "../lib/reconcile";

// What the banner says once a restore is over. An app that no registry carries
// any more is not a download that failed: saying so counted it against the
// restore and told the user to expect it back, which it never is.

function stubStatus(over: Partial<ReconcileStatus>) {
  const status: ReconcileStatus = {
    active: false,
    pending: false,
    reason: "restore",
    startedAt: 1,
    finishedAt: 2,
    total: 1,
    done: 1,
    current: null,
    failed: [],
    gone: [],
    steps: [],
    ...over,
  };
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response(JSON.stringify(status), { headers: { "Content-Type": "application/json" } })),
  );
}

async function banner() {
  const r = render(<RestoreWatcher />);
  await act(async () => {});
  return r.container.textContent || "";
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RestoreWatcher", () => {
  it("names the retired app instead of reporting a failed download", async () => {
    stubStatus({ gone: [{ id: "plex", name: "Plex" }] });
    const text = await banner();
    expect(text).toContain("Plex");
    expect(text).toContain("No longer available");
    expect(text).not.toContain("could not be downloaded");
  });

  it("counts a retired app out of the total rather than against it", async () => {
    // Nine apps the box could bring back, one of them retired: eight landed and
    // one failed to download, so the sentence is about nine, not ten.
    stubStatus({
      total: 10,
      done: 10,
      failed: [{ id: "broken", kind: "bundle", error: "bundle install failed" }],
      gone: [{ id: "plex", name: "Plex" }],
    });
    const text = await banner();
    expect(text).toContain("8 of 9 apps restored");
  });

  it("says nothing extra when every app came back", async () => {
    stubStatus({});
    expect(await banner()).toContain("Your apps are back");
  });

  it("survives a shell that does not send the field at all", async () => {
    // The status is a wire format: a launcher run against an older shell (vite
    // dev, a half-finished deploy) gets no `gone`, and a render that read it
    // unguarded would take the whole launcher down with it.
    stubStatus({ gone: undefined });
    expect(await banner()).toContain("Your apps are back");
  });
});
