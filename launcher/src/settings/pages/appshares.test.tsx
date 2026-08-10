import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppSharesPage } from "./appshares";
import { SettingsNavProvider } from "../nav";
import { setupRemote, remote, setFocus } from "../../test/remote";

// What this page must not get wrong is the direction. A box PULLS - it never
// pushes - so "bring saves here" may only appear once there is a box to bring them
// from, and the destination must never travel in the request: the shell resolves
// it from the local manifest, and a UI that sent one would be a path a renderer
// chose.
setupRemote();

function withNav(root: ReactNode): ReactNode {
  return (
    <SettingsNavProvider>
      {(stack) => {
        const top = stack[stack.length - 1];
        return top ? <div key={top.id}>{top.render()}</div> : root;
      }}
    </SettingsNavProvider>
  );
}

const STATUS = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  running: false,
  port: 8096,
  issued: 0,
  rclone: true,
  shares: [
    { id: "retroarch/saves", appId: "retroarch", appName: "RetroArch", name: "saves", present: true, on: false },
    { id: "retroarch/states", appId: "retroarch", appName: "RetroArch", name: "states", present: false, on: false },
  ],
  serving: [],
  peers: [],
  ...over,
});

function stubShell(over: Record<string, unknown> = {}) {
  const posted: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, code: "1234" }) } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(STATUS(over)) } as Response);
  });
  return posted;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(over: Record<string, unknown> = {}) {
  const posted = stubShell(over);
  await act(async () => {
    render(withNav(<AppSharesPage />));
  });
  return posted;
}

describe("app sharing", () => {
  it("lists what each app declares, and says which folder has nothing in it yet", async () => {
    await mount();
    expect(screen.getByText("RetroArch - saves")).toBeTruthy();
    // A folder the app has not written to is still listed: hiding it until the
    // first save would read as the feature being broken.
    expect(screen.getByText("RetroArch - states")).toBeTruthy();
  });

  it("has nothing to bring until a box is connected", async () => {
    await mount();
    expect(screen.queryByText(/from /)).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    await mount({ peers: [{ id: "tvbox-gaming", name: "gaming", host: "192.168.1.7" }] });
    expect(screen.getByText("gaming")).toBeTruthy();
  });

  it("turning a share on sends the whole list, which is what switches the server on", async () => {
    const posted = await mount();
    // Driven with the remote, like the box is: setFocus proves the row's focus key
    // is reachable at all, which a synthetic click would not.
    await setFocus("appshares:share-retroarch/saves");
    await remote.ok();
    const write = posted.find((p) => p.url === "/tvbox/api/appshares");
    expect(write).toBeTruthy();
    expect((write!.body as { enabled: string[] }).enabled).toEqual(["retroarch/saves"]);
  });

  it("offers no way to bring files across: that belongs to the app", async () => {
    // The shell must not grow a second, app-shaped UI beside the app's own. This
    // page is the permission surface - what is offered, and to which boxes - and it
    // says where the action went rather than looking unfinished.
    const posted = await mount({
      peers: [{ id: "tvbox-gaming", name: "gaming", host: "192.168.1.7" }],
      shares: [
        { id: "retroarch/saves", appId: "retroarch", appName: "RetroArch", name: "saves", present: true, on: true },
      ],
    });
    expect(screen.getByText(/in the app itself/i)).toBeTruthy();
    // Nothing on the page offers the action, so there is nothing to press and no
    // request to make: asserting only the second would pass on a page that still
    // rendered the button.
    expect(screen.queryByText(/^(bring|pull|fetch)$/i)).toBeNull();
    expect(posted.find((p) => p.url.includes("/pull"))).toBeUndefined();
  });
});
