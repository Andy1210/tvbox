import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AboutPane } from "./about";
import { SettingsNavProvider } from "../nav";
import { setupRemote } from "../../test/remote";

// The Status row answers from the last health read. A read that fails must not
// leave an earlier "working" on screen as if it were current.
setupRemote();

let healthOk = true;
function stubShell() {
  vi.stubGlobal("fetch", (url: string) => {
    if (String(url).includes("/health")) {
      if (!healthOk) return Promise.resolve(new Response("down", { status: 503 }));
      return Promise.resolve(new Response(JSON.stringify({ status: "ok", issues: [] })));
    }
    return Promise.resolve(new Response("not json"));
  });
}

describe("the About status row", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    healthOk = true;
  });

  it("goes back to a dash when a later health read fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubShell();
    render(<SettingsNavProvider>{() => <AboutPane />}</SettingsNavProvider>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.queryByText("Everything is working")).not.toBeNull();
    healthOk = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(screen.queryByText("Everything is working")).toBeNull();
  });
});
