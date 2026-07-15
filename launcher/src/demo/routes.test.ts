import { handleApi } from "./routes";
import type { PublicConfig } from "../lib/config";
import type { AppManifest } from "../lib/types";

const get = (path: string) => handleApi("GET", path, new URLSearchParams(), undefined);

// Every read endpoint the launcher calls on its own (mount effects, settings
// panels). A missing mock means a broken screen in the published demo.
const GET_ENDPOINTS = [
  "/tvbox/api/config",
  "/tvbox/api/apps",
  "/tvbox/api/store/list",
  "/tvbox/api/wifi/status",
  "/tvbox/api/wifi/list",
  "/tvbox/api/bt/status",
  "/tvbox/api/bt/devices",
  "/tvbox/api/audio/sinks",
  "/tvbox/api/display/modes",
  "/tvbox/api/system/info",
  "/tvbox/api/system/region",
  "/tvbox/api/update/status",
  "/tvbox/api/ambient/weather",
  "/tvbox/api/ambient/photos",
  "/tvbox/api/backup/status",
  "/tvbox/api/backup/pending-localstorage",
];

describe("demo shell API", () => {
  it("answers every endpoint the launcher reads", async () => {
    for (const path of GET_ENDPOINTS) {
      expect(await get(path), path).toBeDefined();
    }
  });

  it("serves a configured box (no onboarding in the demo)", async () => {
    const config = (await get("/tvbox/api/config")) as PublicConfig;
    expect(config.iptv.configured).toBe(true);
  });

  it("lists renderable app tiles", async () => {
    const apps = (await get("/tvbox/api/apps")) as AppManifest[];
    expect(apps.length).toBeGreaterThanOrEqual(4);
    for (const a of apps) expect(a.icon, a.id).toContain("<svg");
  });

  it("points the pairing QR at the hosted phone page and holds the screen open", async () => {
    const post = (path: string, body?: unknown) => handleApi("POST", path, new URLSearchParams(), body);
    const started = (await post("/tvbox/api/pairing/start", { kind: "iptv", locale: "hu" })) as { url: string };
    expect(started.url).toContain("pair/?kind=iptv&lang=hu&c=");
    // while the iptv pairing runs, the box must NOT look configured - that is
    // what keeps the pairing QR on screen instead of self-dismissing
    let config = (await get("/tvbox/api/config")) as PublicConfig;
    expect(config.iptv.configured).toBe(false);
    await post("/tvbox/api/pairing/stop");
    config = (await get("/tvbox/api/config")) as PublicConfig;
    expect(config.iptv.configured).toBe(true);
  });
});
