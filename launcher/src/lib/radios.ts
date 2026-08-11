// The box's OWN wifi and Bluetooth as a lasting setting, i.e. the boot config.
//
// Not the same thing as the wifi radio switch in lib/wifi.ts: that one parks the
// radio until the next boot, this one turns it off in `config.txt` so it does not
// come back at all - which is what frees the shared antenna for a USB dongle, and
// what an owner who simply wants a radio off is asking for.
export interface RadioState {
  /** "on" | "off", or null when the boot config could not be read. */
  wifi: "on" | "off" | null;
  bt: "on" | "off" | null;
  /** False when the boot config is unreadable - the UI then offers nothing. */
  readable: boolean;
  /** The root unit that applies a change. Absent on a box that only ever updated
   * over the air: root files arrive with provision, never with an OTA release. */
  helper: boolean;
  ethernet?: { connected: boolean; ip: string };
}

export async function radioState(): Promise<RadioState> {
  try {
    return await (await fetch("/tvbox/api/radios", { cache: "no-store" })).json();
  } catch {
    return { wifi: null, bt: null, readable: false, helper: false };
  }
}

export async function setBuiltinRadio(
  radio: "wifi" | "bt",
  on: boolean,
): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    return await (
      await fetch("/tvbox/api/radios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ radio, on }),
      })
    ).json();
  } catch {
    return { ok: false, error: "apply-failed" };
  }
}
