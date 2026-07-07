import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PublicConfig } from "@sdk/config";

// The config store is what components subscribe to. Its load() must set the
// `error` flag (not a bogus config) when the shell is unreachable, so the UI
// shows a retry screen instead of onboarding - mirroring fetchConfig's contract.
// useConfigStore now lives in @tvbox/app-sdk and calls @sdk/config's fetchConfig,
// so the mock targets that module (the launcher's lib/config just re-exports it).
const fetchConfig = vi.fn();
vi.mock("@sdk/config", () => ({
  fetchConfig: () => fetchConfig(),
  saveIptv: vi.fn(),
  saveParental: vi.fn(),
  saveAmbient: vi.fn(),
  saveUpdate: vi.fn(),
}));

import { useConfigStore } from "./config";

const sampleConfig = { parental: { pinSet: false, lockedGroups: [] } } as unknown as PublicConfig;

describe("useConfigStore.load", () => {
  beforeEach(() => {
    fetchConfig.mockReset();
    useConfigStore.setState({ config: null, error: false });
  });

  it("stores the config and clears the error on success", async () => {
    fetchConfig.mockResolvedValue(sampleConfig);
    const returned = await useConfigStore.getState().load();
    expect(returned).toEqual(sampleConfig);
    expect(useConfigStore.getState().config).toEqual(sampleConfig);
    expect(useConfigStore.getState().error).toBe(false);
  });

  it("raises the error flag and keeps config null when the shell is unreachable", async () => {
    fetchConfig.mockResolvedValue(null);
    const returned = await useConfigStore.getState().load();
    expect(returned).toBeNull();
    expect(useConfigStore.getState().config).toBeNull();
    expect(useConfigStore.getState().error).toBe(true);
  });

  it("recovers the error flag on a later successful load", async () => {
    fetchConfig.mockResolvedValueOnce(null).mockResolvedValueOnce(sampleConfig);
    await useConfigStore.getState().load();
    expect(useConfigStore.getState().error).toBe(true);
    await useConfigStore.getState().load();
    expect(useConfigStore.getState().error).toBe(false);
    expect(useConfigStore.getState().config).toEqual(sampleConfig);
  });
});
