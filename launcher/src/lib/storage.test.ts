import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchStorageStatus } from "./storage";

// The shape check lives here rather than in the component, so it has to be tested
// here too: StorageWatcher's own `s.readOnly` guard makes the banner behave
// correctly whether or not this function filters, which means a mutation that
// deletes the filter passes every component test. What the filter protects is the
// CONTRACT - that a caller can trust `readOnly` to be a boolean - and only a test
// that calls this directly can see it.

function stub(body: unknown, ok = true) {
  vi.stubGlobal("fetch", () =>
    ok
      ? Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }))
      : Promise.reject(new Error("network")),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchStorageStatus", () => {
  it("passes through a verdict", async () => {
    stub({ device: "/dev/mmcblk0p2", mountPoint: "/", fsType: "ext4", readOnly: true });
    expect(await fetchStorageStatus()).toEqual({
      device: "/dev/mmcblk0p2",
      mountPoint: "/",
      fsType: "ext4",
      readOnly: true,
    });
  });

  it("answers null for a box that cannot tell", async () => {
    stub(null);
    expect(await fetchStorageStatus()).toBeNull();
  });

  it("answers null for an object with no verdict in it", async () => {
    stub({ device: "/dev/mmcblk0p2", mountPoint: "/" });
    expect(await fetchStorageStatus()).toBeNull();
  });

  it("answers null for a verdict that is not a boolean", async () => {
    // A truthy non-boolean is the dangerous shape: it would read as "the card has
    // failed" anywhere the value is used without a strict comparison.
    stub({ readOnly: "yes" });
    expect(await fetchStorageStatus()).toBeNull();
  });

  it("answers null when the request fails outright", async () => {
    stub(null, false);
    expect(await fetchStorageStatus()).toBeNull();
  });
});
