import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { StoreSettings } from "./StoreSettings";
import { AppDetail } from "./AppDetail";
import { setupRemote, setFocus, remote, getCurrentFocusKey } from "../test/remote";
import { useConfigStore } from "../stores/config";
import type { StoreEntry } from "../lib/api";

// Taking off an app that no registry offers any more.
//
// It keeps running - the box builds its grid from what is on disk - but Remove
// lives only in a store row, and an app nobody lists had no row. So a retired
// app could not be removed from the television at all, only over the API.

setupRemote();

const OFFICIAL = "https://andy1210.github.io/tvbox-apps/index.json";
// One configured store answering, one not - the only state in which an
// `unchecked` row exists at all, and the state the panel used to read as "I
// could not read the list".
const ONE_DOWN = [
  { url: OFFICIAL, official: true, name: null, autoUpdate: true, error: null, count: 1 },
  {
    url: "http://192.168.1.19:8790/index.json",
    official: false,
    name: "Dev",
    autoUpdate: false,
    error: "fetch failed",
    count: 0,
  },
];

beforeEach(() => {
  useConfigStore.setState({
    config: { parental: { pinSet: false, requirePin: false, lockedGroups: [] } } as never,
  });
});
afterEach(() => vi.unstubAllGlobals());

function entry(over: Partial<StoreEntry> = {}): StoreEntry {
  return {
    id: "listedapp",
    name: "Listed",
    version: "1.0.0",
    installed: true,
    installedVersion: "1.0.0",
    updateAvailable: false,
    installing: false,
    builtin: false,
    source: { url: OFFICIAL, official: true, name: null, autoUpdate: true },
    alsoIn: [],
    ...over,
  } as StoreEntry;
}

const gone = (over: Partial<StoreEntry> = {}): StoreEntry =>
  entry({
    id: "goneapp",
    name: "Gone",
    source: null,
    alsoIn: [],
    unlisted: true,
    unlistedFrom: OFFICIAL,
    ...over,
  });

const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("the detail of an app nobody offers", () => {
  it("says why, where it came from, and offers Remove rather than Install", async () => {
    const { container } = render(
      <AppDetail
        app={gone()}
        onInstall={() => {}}
        onUpdate={() => {}}
        onFlatpakUpdate={() => {}}
        onRemove={() => {}}
        onSetUrl={() => {}}
        onExit={() => {}}
      />,
    );
    await settle();
    expect(container.textContent).toContain("No source offers this app any more");
    // The way back, which is the half that turns a dead end into an action.
    expect(container.textContent).toContain(OFFICIAL);
    expect(container.querySelector('[data-sfocus="detail-install"]')).toBeNull();
    expect(container.querySelector('[data-sfocus="detail-remove"]')).not.toBeNull();
    // And that is where the cursor lands, so one press does the only thing there
    // is to do here.
    expect(getCurrentFocusKey()).toBe("detail-remove");
  });
});

describe("an app this box cannot read", () => {
  it("says that, rather than that nobody offers it", async () => {
    // A registry is still serving it; the box just does not speak its manifest.
    // Saying "no longer offered" would be a claim about the world when the true
    // claim is about the box - and it would send somebody looking for a store
    // that is right there.
    const { container } = render(
      <AppDetail
        app={gone({ unlistedReason: "unreadable", unlistedFrom: null })}
        onInstall={() => {}}
        onUpdate={() => {}}
        onFlatpakUpdate={() => {}}
        onRemove={() => {}}
        onSetUrl={() => {}}
        onExit={() => {}}
      />,
    );
    await settle();
    expect(container.textContent).toContain("cannot read its entry");
    expect(container.textContent).not.toContain("No source offers this app any more");
    expect(container.querySelector('[data-sfocus="detail-remove"]')).not.toBeNull();
  });
});

describe("an app the box could not check", () => {
  it("says a store did not answer rather than that nobody offers it", async () => {
    // One configured registry that is gone for good fails on every refresh, so
    // "no source offers this" would be a claim nobody checked - and the pinned
    // registry is not the one to go and look at. What is true is that a store
    // did not answer.
    const { container } = render(
      <AppDetail
        app={gone({ unlistedReason: "unchecked", unlistedFrom: null })}
        onInstall={() => {}}
        onUpdate={() => {}}
        onFlatpakUpdate={() => {}}
        onRemove={() => {}}
        onSetUrl={() => {}}
        onExit={() => {}}
      />,
    );
    await settle();
    expect(container.textContent).toContain("A store is not answering");
    expect(container.textContent).not.toContain("No source offers this app any more");
    expect(container.textContent).not.toContain("cannot read its entry");
    // The row exists for one reason.
    expect(container.querySelector('[data-sfocus="detail-remove"]')).not.toBeNull();
    expect(getCurrentFocusKey()).toBe("detail-remove");
  });
});

describe("an app the box could not check, installed from a registry it no longer has", () => {
  it("still names that registry", async () => {
    // The pin only ever names a registry the box NO LONGER has configured, and
    // a different store being down says nothing about that one. Suppressing it
    // here would drop the only sentence that turns the screen into an action.
    const { container } = render(
      <AppDetail
        app={gone({ unlistedReason: "unchecked", unlistedFrom: OFFICIAL })}
        onInstall={() => {}}
        onUpdate={() => {}}
        onFlatpakUpdate={() => {}}
        onRemove={() => {}}
        onSetUrl={() => {}}
        onExit={() => {}}
      />,
    );
    await settle();
    expect(container.textContent).toContain("A store is not answering");
    expect(container.textContent).toContain(OFFICIAL);
  });
});

describe("an app that is also a flatpak", () => {
  it("still lands the cursor on Remove", async () => {
    // The flatpak update is real - the ref is the box's, not the registry's -
    // but it sits directly under a line saying the app cannot be updated, and
    // one OK there starts a several-hundred-megabyte download instead of the
    // removal this screen exists for.
    const { container } = render(
      <AppDetail
        app={gone({ flatpaks: [{ ref: "org.libretro.RetroArch", name: "RetroArch", version: "1.19.1" }] })}
        onInstall={() => {}}
        onUpdate={() => {}}
        onFlatpakUpdate={() => {}}
        onRemove={() => {}}
        onSetUrl={() => {}}
        onExit={() => {}}
      />,
    );
    await settle();
    expect(container.querySelector('[data-sfocus="detail-flatpak"]'), "the button still exists").not.toBeNull();
    expect(getCurrentFocusKey()).toBe("detail-remove");
  });
});

describe("the store list", () => {
  // `sources` matters as much as `apps` here: an `unchecked` row can only exist
  // when one source errored, and the panel reads that array to decide whether
  // the list it just rendered may be believed.
  function stub(
    apps: () => StoreEntry[],
    onUninstall?: () => void,
    sources: unknown[] = [],
    answer?: () => { ok: boolean; error?: string },
  ) {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        // What the box really answers a second time: the app is already gone,
        // so `uninstall` refuses it (shell/store.js "not a store app").
        const id = String(JSON.parse(String(init.body) || "{}").id || "");
        const known = apps().some((x) => x.id === id);
        onUninstall?.();
        return Promise.resolve(
          new Response(
            JSON.stringify(answer ? answer() : known ? { ok: true } : { ok: false, error: "not a store app" }),
            {
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ registry: OFFICIAL, apps: apps(), error: null, updates: [], autoUpdates: [], sources }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    });
  }

  it("groups them under a heading of their own", async () => {
    const list: StoreEntry[] = [entry(), gone()];
    stub(() => list);
    const { container } = render(<StoreSettings />);
    await settle();
    expect(container.textContent).toContain("Installed, no longer offered by any source");
    expect(container.querySelector('[data-sfocus="store-app-goneapp"]')).not.toBeNull();
  });

  it("gives an unchecked app a heading of its own, not the unreadable one", async () => {
    const list: StoreEntry[] = [entry(), gone({ unlistedReason: "unchecked", unlistedFrom: null })];
    stub(() => list);
    const { container } = render(<StoreSettings />);
    await settle();
    expect(container.textContent).toContain("could not ask every store");
    // The ROW's own sentence too, not only the heading: without this the row
    // could fall through to "this box cannot read it" and the test would still
    // pass, since that is not the string being negated.
    expect(container.textContent).toContain("a store is not answering");
    expect(container.textContent).not.toContain("cannot read what the store sent");
    expect(container.textContent).not.toContain("this box cannot read it");
    expect(container.querySelector('[data-sfocus="store-app-goneapp"]')).not.toBeNull();
  });

  it("puts the cursor on a real row after removing one, with a source down", async () => {
    // The state this whole release is about: a configured store that does not
    // answer is what makes the row exist at all, and the panel used to read any
    // source error as "I could not read the list". The cursor then went to the
    // retry button, which is rendered only when the WHOLE catalogue failed - so
    // it never mounted, and every arrow after the removal was discarded.
    let list: StoreEntry[] = [
      entry({ id: "a1", name: "A1" }),
      gone({ unlistedReason: "unchecked", unlistedFrom: null }),
      entry({ id: "z9", name: "Z9" }),
    ];
    stub(
      () => list,
      () => {
        // What the shell really answers once it is gone: no source lists it and
        // it is no longer installed, so it loses its row.
        list = [entry({ id: "a1", name: "A1" }), entry({ id: "z9", name: "Z9" })];
      },
      ONE_DOWN,
    );
    const { container } = render(<StoreSettings />);
    await settle();
    await setFocus("store-app-goneapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    expect(getCurrentFocusKey(), "the neighbour, and a key that is actually on screen").toBe("store-app-z9");
    expect(container.querySelector('[data-sfocus="store-app-z9"]')).not.toBeNull();
    expect(container.textContent).toContain("Gone removed");
  });

  it("believes the list over a refusal, with a source down", async () => {
    // The second OK of a double press is answered "not a store app", which
    // means the FIRST one worked - so the list settles it, and a list read
    // while one store was down is still proof: an installed app keeps a row
    // whatever the stores answered. That single line is the one round one
    // argued hardest about, and before it the screen said a removal that had
    // worked had failed.
    let list: StoreEntry[] = [
      entry({ id: "a1", name: "A1" }),
      gone({ unlistedReason: "unchecked", unlistedFrom: null }),
    ];
    stub(
      () => list,
      () => {
        list = [entry({ id: "a1", name: "A1" })];
      },
      ONE_DOWN,
      () => ({ ok: false, error: "not a store app" }),
    );
    const { container } = render(<StoreSettings />);
    await settle();
    await setFocus("store-app-goneapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    expect(container.textContent).toContain("Gone removed");
    expect(container.textContent).not.toContain("action failed");
  });

  it("keeps the cursor by name when the list changed under it", async () => {
    // The cursor used to go to whatever sat at the removed row's INDEX, and a
    // list that grew in the meantime hands it to an unrelated app - one press
    // from that app's own Uninstall.
    let list: StoreEntry[] = [entry({ id: "a1", name: "A1" }), gone(), entry({ id: "z9", name: "Z9" })];
    stub(
      () => list,
      () => {
        // The catalogue came back bigger while the removal was in flight.
        list = [
          entry({ id: "a1", name: "A1" }),
          entry({ id: "n1", name: "N1" }),
          entry({ id: "n2", name: "N2" }),
          entry({ id: "z9", name: "Z9" }),
        ];
      },
    );
    render(<StoreSettings />);
    await settle();
    await setFocus("store-app-goneapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    expect(getCurrentFocusKey(), "the row that FOLLOWED it, whatever moved").toBe("store-app-z9");
  });

  it("says removed for an ordinary app, whose row stays behind", async () => {
    // The row does NOT disappear when a still-offered app is removed - the
    // registry keeps listing it, with installed false. Reading "still in the
    // list" as "the removal failed" put "action failed" on the screen for every
    // ordinary removal, in the same frame as the button turning into Install.
    let list: StoreEntry[] = [entry()];
    stub(
      () => list,
      () => {
        list = [entry({ installed: false, installedVersion: null })];
      },
    );
    const { container } = render(<StoreSettings />);
    await settle();
    await setFocus("store-app-listedapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    expect(container.textContent).toContain("removed");
    expect(container.textContent).not.toContain("failed");
  });

  it("does not claim a removal the box answered 200 to but could not verify", async () => {
    // The shape the box really produces when a registry is unreachable: HTTP
    // 200, an empty app list, and an `error` in the body. Reading that as
    // "everything is gone" is how a failed removal reported success - the 500
    // case below was covered and this one was not.
    let broken = false;
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        broken = true;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: "busy" }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            registry: OFFICIAL,
            apps: broken ? [] : [entry()],
            error: broken ? "registry unreachable" : null,
            updates: [],
            autoUpdates: [],
            sources: [],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    const { container } = render(<StoreSettings />);
    await settle();
    await setFocus("store-app-listedapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    expect(container.textContent).toContain("failed");
    // And the cursor has to be on what that screen actually renders - the retry,
    // not the empty-store button, which is hidden while there is an error.
    const where = getCurrentFocusKey();
    expect(document.querySelector(`[data-sfocus="${where}"]`), `cursor parked on ${where}`).not.toBeNull();
  });

  it("does not claim a removal that could not be checked", async () => {
    // If the list cannot be read afterwards, an empty answer is "I did not see",
    // not "everything is gone" - and the press said no.
    let broken = false;
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        broken = true;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: "busy" }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (broken) return Promise.resolve(new Response("nope", { status: 500 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            registry: OFFICIAL,
            apps: [entry()],
            error: null,
            updates: [],
            autoUpdates: [],
            sources: [],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    const { container } = render(<StoreSettings />);
    await settle();
    await setFocus("store-app-listedapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    expect(container.textContent, "nothing was removed, and nothing could confirm it either").toContain("failed");
  });

  it("says it was removed even when a second press raced the first", async () => {
    // The second OK inside one round trip is answered "not a store app", and
    // the sentence used to be written by whichever press replied last - so a
    // successful removal announced itself as a failure.
    let list: StoreEntry[] = [entry(), gone()];
    stub(
      () => list,
      () => {
        list = [entry()];
      },
    );
    const { container } = render(<StoreSettings />);
    await settle();
    await setFocus("store-app-goneapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
      await remote.ok();
    });
    await settle();
    expect(container.textContent).toContain("removed");
    expect(container.textContent).not.toContain("failed");
  });

  it("does not keep an address editor open over a screen that closed under it", async () => {
    // The keyboard is rendered inside the detail view; its state was not. So a
    // screen that closes on its own - a poll that no longer lists the app -
    // left the editor armed, and the next press opened ANOTHER app's detail
    // with the previous app's address editor on top of it.
    //
    // Driven through the poll rather than through Back, because Back closes the
    // editor itself and proves nothing: with that route the test passed against
    // the bug.
    let list: StoreEntry[] = [
      entry({ id: "hosted", name: "Hosted", urlConfig: "hosted", baseUrl: "", installing: true }),
      entry({ id: "other", name: "Other" }),
    ];
    stub(() => list);
    const { container } = render(<StoreSettings />);
    await settle();
    await setFocus("store-app-hosted");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-url");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    expect(container.querySelector('[data-sfocus^="osk-"]'), "the editor is up").not.toBeNull();

    // It goes away underneath, while the panel is polling because of the install.
    list = [entry({ id: "other", name: "Other" })];
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1800));
    });
    // The keyboard is inside the detail, so it is off screen either way. What
    // matters is whether it is still ARMED: opening the next app is where it
    // came back, over a screen it does not belong to.
    await setFocus("store-app-other");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    expect(container.textContent, "Other's detail is open").toContain("Other");
    expect(
      container.querySelector('[data-sfocus^="osk-"]'),
      "the previous app's address editor must not reopen over another app",
    ).toBeNull();
  }, 10000);

  it("puts the cursor somewhere on a store that is already empty", async () => {
    // Not the removal path - arriving at a store with no rows at all, which a
    // fresh box and a registry serving nothing both produce. The button was
    // there and nothing ever put the cursor on it, so the panel was a picture:
    // every arrow and every OK discarded, only Back out.
    stub(() => []);
    render(<StoreSettings />);
    await settle();
    expect(getCurrentFocusKey()).toBe("store-empty");
  });

  it("puts the cursor on something reachable even when nothing is left", async () => {
    // Removing the last app leaves a store with no rows - and that screen used
    // to hold nothing focusable at all, so arrows and OK did nothing and only
    // Back escaped.
    let list: StoreEntry[] = [gone()];
    stub(
      () => list,
      () => {
        list = [];
      },
    );
    render(<StoreSettings />);
    await settle();
    await setFocus("store-app-goneapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    const where = getCurrentFocusKey();
    expect(document.querySelector(`[data-sfocus="${where}"]`), `cursor parked on ${where}`).not.toBeNull();
  });

  it("ignores a press that was queued behind the removal", async () => {
    // The cursor lands on the row that took the removed one's place, and an
    // installed app's detail opens focused on its own Uninstall - so a press
    // still travelling when the list came back would arm a removal nobody asked
    // for, two presses from one.
    let list: StoreEntry[] = [entry(), gone()];
    stub(
      () => list,
      () => {
        list = [entry()];
      },
    );
    render(<StoreSettings />);
    await settle();
    await setFocus("store-app-goneapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    // The queued one, arriving on whatever the cursor now holds.
    await act(async () => {
      await remote.ok();
    });
    await settle();
    expect(
      document.body.textContent,
      "another app's detail must not open from a press meant for the last one",
    ).not.toContain("Uninstall");
  });

  it("does not strand the remote when the last row of one is removed", async () => {
    // The row is gone once the app is, so the detail unmounts with it. Focus was
    // sent to `detail-install`, which for this app never mounts again - and a
    // cursor on a key nothing owns discards every press after it, with only Back
    // out.
    let list: StoreEntry[] = [entry(), gone()];
    stub(
      () => list,
      () => {
        list = [entry()];
      },
    );
    render(<StoreSettings />);
    await settle();

    await setFocus("store-app-goneapp");
    await act(async () => {
      await remote.ok();
    });
    await settle();
    await setFocus("detail-remove");
    await act(async () => {
      await remote.ok();
    });
    await settle();

    const where = getCurrentFocusKey();
    expect(where).not.toBe("detail-install");
    // Whatever it is, it has to be something that is actually on screen.
    expect(
      document.querySelector(`[data-sfocus="${where}"]`),
      `cursor parked on ${where}, which is not mounted`,
    ).not.toBeNull();
  });
});
