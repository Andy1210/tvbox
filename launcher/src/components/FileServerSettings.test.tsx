import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { FileServerSettings } from "./FileServerSettings";
import { setupRemote, remote, setFocus } from "../test/remote";

// The box can clear a stored password (which stops the server), and the form had no
// way to reach that: an empty entry means "keep the stored one", like every other
// credential form here, so there was no path to "" at all. That is the kind of gap
// nothing else catches - the shell側 works, the UI just cannot ask for it.
setupRemote();

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
  candidates: [{ id: "tvbox:ambient", kind: "ambient", name: "screensaver", warn: false }],
});

function stubShell(hasPass: boolean) {
  const posted: unknown[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
    const body = init?.method === "POST" ? { ok: true, status: STATUS(false) } : STATUS(hasPass);
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
    render(<FileServerSettings />);
    await settle();
    const clear = screen.getByText("Clear password");
    await act(async () =>
      clear.closest("[data-focus-key], div, button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await settle();
    expect(posted).toContainEqual({ pass: "" });
  });

  it("does not offer it when there is no password to clear", async () => {
    stubShell(false);
    render(<FileServerSettings />);
    await settle();
    expect(screen.queryByText("Clear password")).toBeNull();
    // and it says what is missing instead
    expect(screen.queryByText(/at least 8 characters/)).not.toBeNull();
  });

  it("renders the folders the box discovered, not a list of its own", async () => {
    stubShell(true);
    render(<FileServerSettings />);
    await settle();
    expect(screen.queryByText("Screensaver images")).not.toBeNull(); // known kind, our own name
    expect(screen.queryByText(/holds the box's settings/)).toBeNull(); // no warn candidate in this fixture
  });
});
