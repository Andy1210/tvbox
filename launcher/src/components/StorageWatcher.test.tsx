import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StorageWatcher } from "./StorageWatcher";

// The one thing a box with a failed card can still do is say so. What is tested
// here is the other half of that: it must not say so when it does not know, which
// is every box that has not been updated yet and every request that failed.

function stubStorage(body: unknown, ok = true) {
  vi.stubGlobal("fetch", () =>
    ok
      ? Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }))
      : Promise.reject(new Error("network")),
  );
}

async function banner() {
  const r = render(<StorageWatcher />);
  await act(async () => {});
  return r.container.textContent || "";
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StorageWatcher", () => {
  it("says the card has failed, and what to do about it", async () => {
    stubStorage({ device: "/dev/mmcblk0p2", mountPoint: "/", fsType: "ext4", readOnly: true });
    const text = await banner();
    expect(text).toContain("The storage card has failed");
    expect(text).toContain("Restart it");
  });

  it("shows nothing on a healthy box", async () => {
    stubStorage({ device: "/dev/mmcblk0p2", mountPoint: "/", fsType: "ext4", readOnly: false });
    expect(await banner()).toBe("");
  });

  it("shows nothing when the box cannot tell", async () => {
    // `null` is what the shell answers on a host it cannot read /proc on, and
    // what an older shell's 404 comes back as. Neither is a broken card.
    stubStorage(null);
    expect(await banner()).toBe("");
  });

  it("shows nothing when the request fails", async () => {
    stubStorage(null, false);
    expect(await banner()).toBe("");
  });

  it("ignores an answer that does not carry the verdict", async () => {
    stubStorage({ device: "/dev/mmcblk0p2" });
    expect(await banner()).toBe("");
  });
});
