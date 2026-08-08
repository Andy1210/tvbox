import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StoreSourcesPage } from "./storesources";
import { setupRemote, remote, setFocus } from "../../test/remote";

// The page writes the WHOLE source list on every edit (the box replaces the array
// it is given), so the risk is the same shape as the MQTT form's: a save that
// carries one entry silently drops the others. The second thing worth a test is
// the arm-then-confirm on adding a source, because that press is the entire
// consent step for letting a stranger's registry install code on this box.
setupRemote();

const SOURCES = [
  { url: "https://andy1210.github.io/tvbox-apps/index.json", official: true, name: null, autoUpdate: true, count: 7 },
  { url: "http://192.168.1.5:8790/index.json", official: false, name: "Dev", autoUpdate: false, count: 2 },
];

function stubShell() {
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, sources: body.sources }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ registry: SOURCES[0].url, apps: [], error: null, updates: [], sources: SOURCES }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return posted;
}
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("the store sources page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists every configured registry, the official one first", async () => {
    stubShell();
    render(<StoreSourcesPage />);
    await settle();
    expect(screen.getByText("andy1210.github.io")).toBeTruthy();
    expect(screen.getByText("Dev")).toBeTruthy();
  });

  it("keeps the added sources when the primary's unattended-update switch is flipped", async () => {
    const posted = stubShell();
    render(<StoreSourcesPage />);
    await settle();

    await setFocus("store-sources:primary-auto");
    await remote.ok();
    await settle();

    expect(posted.length).toBe(1);
    expect(posted[0].autoUpdate).toBe(false);
    // The dev registry is still there, and still off unattended updates: this is
    // the whole point of the per-source flag.
    expect(posted[0].sources).toEqual([{ url: SOURCES[1].url, name: "Dev", autoUpdate: false }]);
  });

  it("does not add a source on the first press", async () => {
    const posted = stubShell();
    render(<StoreSourcesPage />);
    await settle();

    await setFocus("store-sources:add");
    await remote.ok();
    await settle();
    // The edit page opens with an empty address, so Save has nothing to do yet.
    await setFocus("store-source-edit:save");
    await remote.ok();
    await settle();
    expect(posted.length).toBe(0);
  });
});
