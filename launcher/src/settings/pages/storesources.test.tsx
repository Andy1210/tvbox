import { describe, it, expect, vi, afterEach } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StoreSourcesPage } from "./storesources";
import { setupRemote, remote, setFocus } from "../../test/remote";
import { SettingsNavProvider, useSettingsNav, type StackEntry } from "../nav";

// The page pushes its editor onto the settings stack, and only the top of that
// stack is mounted - so a test that renders the page bare can never reach the
// editor at all. This is the same composition Settings.tsx does, and the sources
// page is PUSHED here the way the Apps pane pushes it: a pop too many then shows
// the settings root, which is what makes an extra pop visible to a test.
function Stack({ stack }: { stack: StackEntry[] }) {
  const nav = useSettingsNav();
  useEffect(() => {
    nav.push({ id: "store-sources", title: "", render: () => <StoreSourcesPage /> });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const top = stack[stack.length - 1];
  return top ? <div key={top.id}>{top.render()}</div> : <div>settings root</div>;
}
function Page() {
  return <SettingsNavProvider>{(stack) => <Stack stack={stack} />}</SettingsNavProvider>;
}

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

function stubShell(postDelayMs = 0) {
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      const answer = new Response(JSON.stringify({ ok: true, sources: body.sources }), {
        headers: { "Content-Type": "application/json" },
      });
      return postDelayMs ? new Promise((r) => setTimeout(() => r(answer), postDelayMs)) : Promise.resolve(answer);
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
    render(<Page />);
    await settle();
    expect(screen.getByText("andy1210.github.io")).toBeTruthy();
    expect(screen.getByText("Dev")).toBeTruthy();
  });

  it("keeps the added sources when the primary's unattended-update switch is flipped", async () => {
    const posted = stubShell();
    render(<Page />);
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

  // Every save replaces the whole list, so a press that lands while the previous
  // one is still in flight would write a state nobody asked for. A TV remote
  // repeats faster than a save answers.
  it("ignores a second press while the save is still in flight", async () => {
    const posted = stubShell(60);
    render(<Page />);
    await settle();

    await setFocus("store-sources:primary-auto");
    await remote.ok();
    await remote.ok();
    await act(async () => await new Promise((r) => setTimeout(r, 150)));

    expect(posted.length).toBe(1);
  });

  it("removing a source is not reported as a refused address", async () => {
    const posted = stubShell();
    render(<Page />);
    await settle();

    await setFocus("store-sources:src-" + SOURCES[1].url);
    await remote.ok();
    await settle();
    await setFocus("store-source-edit:remove");
    await remote.ok(); // arms
    await settle();
    await remote.ok(); // removes
    await settle();

    expect(posted.length).toBe(1);
    expect(posted[0].sources).toEqual([]);
    // The page closed instead of staying up with an error: the list is back.
    expect(screen.getByText("andy1210.github.io")).toBeTruthy();
  });

  // Back while a save is in flight closes the editor; the write is already on its
  // way and still finishes, but the pop that follows it would close the page
  // BELOW - the sources list itself.
  it("Back during a save does not close the page underneath as well", async () => {
    stubShell(60);
    render(<Page />);
    await settle();

    await setFocus("store-sources:src-" + SOURCES[1].url);
    await remote.ok();
    await settle();
    await setFocus("store-source-edit:remove");
    await remote.ok(); // arms
    await settle();
    await remote.ok(); // removes, answer is 60ms away
    await remote.back(); // ...and the user leaves meanwhile
    await act(async () => await new Promise((r) => setTimeout(r, 200)));

    expect(screen.queryByText("settings root")).toBeNull();
    expect(screen.getByText("andy1210.github.io")).toBeTruthy();
  });

  it("does not add a source on the first press", async () => {
    const posted = stubShell();
    render(<Page />);
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
