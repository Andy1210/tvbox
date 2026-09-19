import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { RestoreWatcher } from "./RestoreWatcher";
import type { ReconcileStatus } from "../lib/reconcile";

// What the banner says once a restore is over. An app that no registry carries
// any more is not a download that failed: saying so counted it against the
// restore and told the user to expect it back, which it never is.
//
// The wording is the store's own for this state ("no longer offered" / "már nem
// kínálja senki"), not a second phrase for the same idea - and in Hungarian "nem
// érhető el" is already spoken for by a store that is merely down.

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
    stubStatus({ total: 2, done: 2, gone: ["plex"] });
    const text = await banner();
    expect(text).toContain("plex");
    expect(text).toContain("No longer offered");
    expect(text).not.toContain("could not be downloaded");
  });

  it("counts a retired app out of the total rather than against it", async () => {
    // Nine apps the box could bring back, one of them retired: eight landed and
    // one failed to download, so the sentence is about nine, not ten.
    stubStatus({
      total: 10,
      done: 10,
      failed: [{ id: "broken", kind: "bundle", error: "bundle install failed" }],
      gone: ["plex"],
    });
    expect(await banner()).toContain("8 of 9 apps restored");
  });

  it("still names the retired app when something else failed too", async () => {
    // The only run that can ever say it: a retired app leaves the desired state,
    // so there is no second showing. Without this the person sees a total one
    // smaller than their backup's, with nothing accounting for the difference.
    stubStatus({
      total: 10,
      done: 10,
      failed: [{ id: "broken", kind: "bundle", error: "bundle install failed" }],
      gone: ["plex"],
    });
    const text = await banner();
    expect(text).toContain("could not be downloaded");
    expect(text).toContain("plex");
  });

  it("does not claim the apps are back when every one of them was retired", async () => {
    stubStatus({ total: 1, done: 1, gone: ["plex"] });
    const text = await banner();
    expect(text).toContain("Nothing to bring back");
    expect(text).not.toContain("Your apps are back");
  });

  it("caps a long list with a count instead of letting it be cut off", async () => {
    // One truncating line: a cut list reads as the whole list, and the person
    // cannot tell whether their own app is among the ones they cannot see.
    stubStatus({ total: 5, done: 5, gone: ["plex", "jellyfin", "kodi", "emby"] });
    const text = await banner();
    expect(text).toContain("plex, jellyfin +2 more");
    expect(text).not.toContain("kodi");
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
