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
// appear, a press asks the box for the opposite value, and the page shows what the
// box has rather than what was pressed.

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

let fetchApps: ReturnType<typeof vi.spyOn>;
let setAppSwitch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchApps = vi.spyOn(api, "fetchApps");
  setAppSwitch = vi.spyOn(api, "setAppSwitch").mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

async function draw(list: AppManifest[]) {
  fetchApps.mockResolvedValue(list);
  const r = render(<AppSwitchesPage />);
  await act(async () => {}); // the list arrives async
  return r.container;
}

describe("Settings -> Apps -> App settings", () => {
  it("names the app next to the switch, and shows its hint", async () => {
    const c = await draw([app()]);
    expect(c.textContent).toContain("YouTube - Cast from phone");
    expect(c.textContent).toContain("Shows up in the phone's cast list");
  });

  it("lists only the apps that declare one", async () => {
    const c = await draw([app(), app({ id: "files", name: "Files", switches: undefined })]);
    expect(c.textContent).toContain("YouTube");
    expect(c.textContent).not.toContain("Files");
  });

  it("says so when nothing declares one, rather than showing an empty box", async () => {
    const c = await draw([app({ switches: undefined })]);
    expect(c.textContent).toContain("No installed app asks for one of these.");
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
    fetchApps.mockResolvedValue([app()]);
    const { container } = render(<AppSwitchesPage />);
    await act(async () => {});
    await setFocus("appswitches:youtube-cast");
    await act(async () => {
      await remote.ok();
    });
    await act(async () => {});
    expect(container.textContent).toContain("Cast from phone");
    expect(fetchApps).toHaveBeenCalledTimes(2); // mount, then after the write
  });

  it("sends one write per press while the box has not answered", async () => {
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
});
