import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { AppSwitchesPage } from "./appswitches";
import { setupRemote, setFocus, remote } from "../../test/remote";
import * as api from "../../lib/api";
import type { AppManifest } from "../../lib/types";

// The page that exists so a setting can be FOUND.
//
// The switch it was built for decides whether the box answers a phone that casts
// YouTube, and the app it belongs to is Google's own TV page - so there is no app
// screen of ours to put it on. What matters here: only apps that declare a switch
// appear, a press asks the box for the opposite value, the page shows what the box
// has rather than what was pressed, and neither a dead box nor a refused write is
// allowed to look like an answer.

setupRemote();

function app(over: Partial<AppManifest> = {}): AppManifest {
  return {
    id: "youtube",
    name: "YouTube",
    type: "webclient",
    status: "ready",
    switches: [{ key: "cast", label: "Cast from phone", hint: "Shows up in the phone's cast list", on: true }],
    ...over,
  } as AppManifest;
}

let fetchAppsOrNull: ReturnType<typeof vi.spyOn>;
let setAppSwitch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchAppsOrNull = vi.spyOn(api, "fetchAppsOrNull");
  setAppSwitch = vi.spyOn(api, "setAppSwitch").mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

async function draw(list: AppManifest[] | null) {
  fetchAppsOrNull.mockResolvedValue(list);
  const r = render(<AppSwitchesPage />);
  await act(async () => {}); // the list arrives async
  return r.container;
}

describe("Settings -> Apps -> extra app settings", () => {
  it("names the app next to the switch, and shows its hint", async () => {
    const c = await draw([app()]);
    expect(c.textContent).toContain("YouTube - Cast from phone");
    expect(c.textContent).toContain("Shows up in the phone's cast list");
  });

  it("is a page you can leave, and says so", async () => {
    // Without an `onBack`, SettingsPage registers no Back handler at all and the
    // press falls through to the root one - which exits Settings to the home screen,
    // losing the whole context. The chevron next to the title is the same condition,
    // so its presence is what says the page is leavable.
    const c = await draw([app()]);
    expect(c.querySelector("h2 svg"), "no back chevron -> no Back handler either").toBeTruthy();
    const unreachable = await draw(null);
    expect(unreachable.querySelector("h2 svg"), "and the same on the unreachable page").toBeTruthy();
  });

  it("shows the state the box reports, not a fixed one", async () => {
    expect((await draw([app()])).textContent).toContain("On");
    expect((await draw([app({ switches: [{ key: "cast", label: "Cast", on: false }] })])).textContent).toContain("Off");
  });

  it("lists only the apps that declare one", async () => {
    const c = await draw([app(), app({ id: "files", name: "Files", switches: undefined })]);
    expect(c.textContent).toContain("YouTube");
    expect(c.textContent).not.toContain("Files");
  });

  it("says so when nothing declares one, rather than showing an empty box", async () => {
    const c = await draw([app({ switches: undefined })]);
    expect(c.textContent).toContain("None of the installed apps has one of these.");
  });

  it("does not turn a dead box into a claim about the apps", async () => {
    // fetchApps falls back to a demo list on failure, and none of those declare a
    // switch - so the honest-looking sentence would be a lie told by a failed fetch.
    const c = await draw(null);
    expect(c.textContent).toContain("Can't reach the box");
    expect(c.textContent).not.toContain("None of the installed apps");
  });

  it("recovers when the box answers on a retry", async () => {
    fetchAppsOrNull.mockResolvedValueOnce(null).mockResolvedValueOnce([app()]);
    const { container } = render(<AppSwitchesPage />);
    await act(async () => {});
    expect(container.textContent).toContain("Can't reach the box");
    await setFocus("appswitches:retry");
    await act(async () => {
      await remote.ok();
    });
    expect(container.textContent).toContain("Cast from phone");
  });

  it("asks the box for the value the row is NOT showing", async () => {
    await draw([app()]);
    await setFocus("appswitches:youtube-cast");
    await act(async () => {
      await remote.ok();
    });
    expect(setAppSwitch).toHaveBeenCalledWith("youtube", "cast", false);
  });

  it("ends up showing what the box has, not what was pressed", async () => {
    // A refused write (the app was removed, so the manifest no longer declares the
    // switch) must not leave the row lying: the reload is what corrects it.
    setAppSwitch.mockResolvedValue(false);
    fetchAppsOrNull.mockResolvedValue([app()]);
    const { container } = render(<AppSwitchesPage />);
    await act(async () => {});
    await setFocus("appswitches:youtube-cast");
    await act(async () => {
      await remote.ok();
    });
    await act(async () => {});
    expect(container.textContent).toContain("Cast from phone");
    expect(fetchAppsOrNull).toHaveBeenCalledTimes(2); // mount, then after the write
  });

  it("says a refused write was refused", async () => {
    // Otherwise the pill flips, flips back, and reads as "the press did not register".
    setAppSwitch.mockResolvedValue(false);
    const c = await draw([app()]);
    await setFocus("appswitches:youtube-cast");
    await act(async () => {
      await remote.ok();
    });
    await act(async () => {});
    expect(c.textContent).toContain("Couldn't save that.");
  });

  it("sends one write per press on the same row while the box has not answered", async () => {
    let release: (v: boolean) => void = () => {};
    setAppSwitch.mockImplementation(() => new Promise<boolean>((r) => (release = r)));
    await draw([app()]);
    await setFocus("appswitches:youtube-cast");
    await act(async () => {
      await remote.ok();
      await remote.ok();
    });
    expect(setAppSwitch).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(true);
    });
  });

  it("but a press on ANOTHER row is not swallowed by the first one's write", async () => {
    // Two switches are two independent writes. A page-wide guard dropped the second
    // press with nothing on screen to say why.
    let release: (v: boolean) => void = () => {};
    setAppSwitch.mockImplementation(() => new Promise<boolean>((r) => (release = r)));
    await draw([
      app({
        switches: [
          { key: "cast", label: "Cast", on: true },
          { key: "other", label: "Other", on: false },
        ],
      }),
    ]);
    await setFocus("appswitches:youtube-cast");
    await act(async () => {
      await remote.ok();
    });
    await setFocus("appswitches:youtube-other");
    await act(async () => {
      await remote.ok();
    });
    expect(setAppSwitch).toHaveBeenCalledTimes(2);
    expect(setAppSwitch).toHaveBeenLastCalledWith("youtube", "other", true);
    await act(async () => {
      release(true);
    });
  });
});
