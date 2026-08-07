import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MqttPage } from "./mqtt";
import { useConfigStore } from "../../stores/config";
import { setupRemote, remote, setFocus } from "../../test/remote";

// `setMqtt` on the box REPLACES the whole mqtt section from the request body and
// deletes it outright when the host is empty - it is not a per-field merge. So a page
// that sends one field at a time destroys the rest, and the field that hurts most is
// the password: the row whose entire job is to hold a secret was the row that wiped
// it. Nothing else catches this - every save "succeeds", the UI shows no error, and
// the integration just stops working.
setupRemote();

const CONFIG = {
  mqtt: {
    configured: true,
    host: "192.168.1.10",
    port: 1884,
    username: "tvbox",
    hasPassword: true,
    deviceId: "gaming",
  },
  ui: { hourFormat: "auto", navSounds: true },
};

function stubShell() {
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
    return Promise.resolve(
      new Response(JSON.stringify({ config: CONFIG }), { headers: { "Content-Type": "application/json" } }),
    );
  });
  return posted;
}
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("the Home Assistant (MQTT) form", () => {
  beforeEach(() => {
    // The page reads the shared config store, not a fetch of its own.
    useConfigStore.setState({ config: CONFIG as never, error: false });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends the whole section on every edit, so no other field is lost", async () => {
    const posted = stubShell();
    render(<MqttPage />);
    await settle();

    // Editing the port: the row opens the keyboard, so drive the save directly
    // through the row the way a press does, then check what reached the box.
    await setFocus("mqtt:port");
    await remote.ok(); // opens the OSK
    await settle();
    // The OSK's Done key. Submitting the field unchanged is the case that used to
    // delete everything else.
    await setFocus("osk-done");
    await remote.ok();
    await settle();

    expect(posted.length).toBe(1);
    const sent = posted[0].mqtt as Record<string, unknown>;
    expect(sent.host).toBe("192.168.1.10"); // not "" - an empty host deletes the section
    expect(sent.username).toBe("tvbox");
    expect(sent.deviceId).toBe("gaming");
    expect(sent.password).toBe(""); // the shell's "keep the stored one"
  });
});
