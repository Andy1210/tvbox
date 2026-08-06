import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { FileServerPage } from "./fileserver";
import { SettingsNavProvider } from "../nav";
import { setupRemote, remote, setFocus } from "../../test/remote";

// The box can clear a stored password (which stops the server), and the form had no
// way to reach that: an empty entry means "keep the stored one", like every other
// credential form here, so there was no path to "" at all. That is the kind of gap
// nothing else catches - the shell side works, the UI just cannot ask for it.
setupRemote();

// The same shape the real Settings root has: only the top of the stack is mounted,
// so a drill-down can be driven with the remote instead of by calling internals.
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

const STATUS = (hasPass: boolean) => ({
  enabled: false,
  running: false,
  user: "tvbox",
  hasPass,
  port: 8098,
  url: "http://192.168.1.24:8098/",
  folders: [],
  shared: [],
  rclone: true,
  minPassword: 8,
  candidates: [{ id: "tvbox:ambient", name: "screensaver", warn: false }],
});

function stubShell(hasPass: boolean, over: Partial<ReturnType<typeof STATUS>> = {}) {
  const posted: unknown[] = [];
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
    const body =
      init?.method === "POST" ? { ok: true, status: { ...STATUS(false), ...over } } : { ...STATUS(hasPass), ...over };
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  });
  return posted;
}
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("the file server form", () => {
  beforeEach(() => setupRemote());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers to clear the password only when one is stored, and clearing sends an empty one", async () => {
    const posted = stubShell(true);
    render(<FileServerPage />);
    await settle();
    expect(screen.queryByText("Clear password")).not.toBeNull();
    // Driven the way the box is: focus the control, press OK. That also proves the
    // focus key is reachable at all, which a synthetic click would not.
    await setFocus("fs:pass-clear");
    await remote.ok();
    await settle();
    expect(posted).toContainEqual({ pass: "" });
  });

  it("does not offer it when there is no password to clear", async () => {
    stubShell(false);
    render(<FileServerPage />);
    await settle();
    expect(screen.queryByText("Clear password")).toBeNull();
    // and it says what is missing instead
    expect(screen.queryByText(/at least 8 characters/)).not.toBeNull();
  });

  it("offers a way out when the shell does not answer, instead of looking stopped", async () => {
    // "stopped" plus a full set of controls that all fail is the wrong story: the box
    // is not reachable, and every control below would just error.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no shell")));
    render(<FileServerPage />);
    await settle();
    expect(screen.queryByText("Try again")).not.toBeNull(); // app.retry, shared with the store
    expect(screen.queryByText("Can't reach the box")).not.toBeNull();
    expect(screen.queryByText("Enabled")).toBeNull(); // and none of the controls that would fail
  });

  it("greys the switch while the binary that serves it is missing", async () => {
    const posted = stubShell(true, { rclone: false });
    render(<FileServerPage />);
    await settle();
    await setFocus("fs:enabled");
    await remote.ok();
    await settle();
    expect(posted).toEqual([]); // nothing was configured that the box cannot honour
    // Said at least once: the row carries it as a hint before the press, and the press
    // adds it as an error - either is enough for the user to know why.
    expect(screen.queryAllByText("rclone is not installed.").length).toBeGreaterThan(0);
  });

  it("renders the folders the box discovered, not a list of its own", async () => {
    stubShell(true);
    render(withNav(<FileServerPage />));
    await settle();
    // The folder list is a page of its own now, so walk to it with the remote.
    await setFocus("fs:folders");
    await remote.ok();
    await settle();
    // verbatim: this is the name the folder has over the network, so it is the name
    // to go looking for in a file manager - a translated label would name nothing
    expect(screen.queryByText("screensaver")).not.toBeNull();
    expect(screen.queryByText(/holds the box's settings/)).toBeNull(); // no warn candidate in this fixture
  });
});
