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
  // Most fixtures are one plan step per app, so the app count follows the step
  // total unless a case is specifically about the two differing.
  if (!("wanted" in over)) status.wanted = status.total;
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
    expect(await banner()).toContain("Apps restored: 8 of 9");
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
    expect(text).toContain("None of your apps could come back");
    expect(text).not.toContain("Your apps are back");
  });

  it("counts apps, not plan steps", async () => {
    // Two apps, one retired and one the backup restored whole - the whole one owes
    // no step, so the STEP total is 1, and subtracting the retired app from it
    // says "nothing to bring back" about a box whose app is back. The mismatch
    // runs the other way too: one app can owe both a deps and a bundle step.
    stubStatus({ total: 1, done: 1, wanted: 2, gone: ["plex"] });
    const text = await banner();
    expect(text).toContain("Your apps are back");
    expect(text).toContain("plex");
    expect(text).not.toContain("could come back");
  });

  it("counts an app that failed twice as one app", async () => {
    stubStatus({
      total: 4,
      done: 4,
      wanted: 3,
      failed: [
        { id: "broken", kind: "deps", error: "dependency install failed" },
        { id: "broken", kind: "bundle", error: "bundle install failed" },
      ],
    });
    expect(await banner()).toContain("Apps restored: 2 of 3 - 1 could not be downloaded");
  });

  it("falls back to the step total when the shell sends no app count", async () => {
    // An older shell: the old behaviour rather than a crash or a blank sentence.
    stubStatus({ total: 10, done: 10, wanted: undefined, failed: [{ id: "x", kind: "bundle", error: "no" }] });
    expect(await banner()).toContain("Apps restored: 9 of 10");
  });

  it("does not collapse the failed steps when it is counting steps", async () => {
    // Both halves of the fallback move together or it is not the old behaviour.
    // An app that lost both its deps and its bundle is two of a STEP total, and
    // collapsing it to one app against that total reports 3 of 4 where the old
    // code said 2 of 4 - an app claimed back that never came.
    stubStatus({
      total: 4,
      done: 4,
      wanted: undefined,
      failed: [
        { id: "broken", kind: "deps", error: "dependency install failed" },
        { id: "broken", kind: "bundle", error: "bundle install failed" },
      ],
    });
    expect(await banner()).toContain("Apps restored: 2 of 4 - 2 could not be downloaded");
  });

  it("does not use the step total to claim nothing came back", async () => {
    // The same shape the app count exists to fix, on a shell that cannot send it:
    // one retired app beside one the backup carried whole is a STEP total of 1,
    // so subtracting the retirement gives 0. Saying "none could come back" there
    // is the old bug wearing the new sentence.
    stubStatus({ total: 1, done: 1, wanted: undefined, gone: ["plex"] });
    const text = await banner();
    expect(text).toContain("Your apps are back");
    expect(text).not.toContain("could come back");
  });

  it("caps a long list with a count instead of letting it run away", async () => {
    // A list that outgrows the line reads as the whole list, and the person
    // cannot tell whether their own app is among the ones they cannot see.
    stubStatus({ total: 5, done: 5, gone: ["plex", "jellyfin", "kodi", "emby"] });
    const text = await banner();
    expect(text).toContain("plex, jellyfin +2 more");
    expect(text).not.toContain("kodi");
  });

  it("does not hide a single name behind a count that is longer than it", async () => {
    // " +1 more" is longer than most app ids here, so compressing at three costs
    // characters AND trades a name for a digit. Measured: "plex, jellyfin +1 more"
    // is 22 characters against "plex, jellyfin, kodi" at 20.
    stubStatus({ total: 4, done: 4, gone: ["plex", "jellyfin", "kodi"] });
    const text = await banner();
    expect(text).toContain("plex, jellyfin, kodi");
    expect(text).not.toContain("more");
  });

  it("names both when there are exactly two", async () => {
    stubStatus({ total: 3, done: 3, gone: ["plex", "jellyfin"] });
    const text = await banner();
    expect(text).toContain("plex, jellyfin");
    expect(text).not.toContain("more");
  });

  it("compresses two names that are long enough to push the count off the line", async () => {
    // An id may be 40 characters, so a count of NAMES is not a bound on their
    // width: two of them run to 82 on their own, and the clamp then ate the
    // "+N more" itself - the one thing the compression is for.
    const long = ["a".repeat(40), "b".repeat(40), "c"];
    stubStatus({ total: 4, done: 4, gone: long });
    const text = await banner();
    expect(text).toContain("+1 more");
    expect(text).not.toContain("ccc");
  });

  it("lets the finished summary wrap instead of truncating it", async () => {
    // The longest sentence it can produce is 94 characters in English and 106 in
    // Hungarian, against about 74 that fit on one line at 1360x768 - so
    // truncating it ate the clause this banner exists to add. happy-dom lays
    // nothing out, so the decision is pinned by the class.
    stubStatus({ total: 2, done: 2, gone: ["plex"] });
    const r = render(<RestoreWatcher />);
    await act(async () => {});
    const label = r.container.querySelector("span.flex-1");
    expect(label?.className).not.toContain("truncate");
    expect(label?.className).toContain("line-clamp-2");
  });

  it("shows no numeric counter while it runs", async () => {
    // It counted plan STEPS while the summary counts apps, so the denominator
    // changed between the two - "1/4" running, "2 of 3" at the end - which reads
    // as a bug from the sofa. The bar carries the progress and needs no unit.
    stubStatus({ active: true, finishedAt: null, total: 4, done: 1, wanted: 3 });
    const text = await banner();
    expect(text).not.toContain("1/4");
    expect(text).not.toContain("/3");
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
