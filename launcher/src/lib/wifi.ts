// Device WiFi control via the shell's nmcli routes. Used by the HOME Settings
// screen to show the current network + pick/connect another.
export interface WifiNet {
  ssid: string;
  signal: number;
  secured: boolean;
  active: boolean;
  known?: boolean; // has a saved NetworkManager profile → can be forgotten
}
export interface EthernetStatus {
  connected: boolean;
  ip: string;
}
export interface WifiStatus {
  connected: boolean;
  ssid: string;
  ethernet?: EthernetStatus;
  // The radio as nmcli reports it; null when there is no usable answer, which the
  // UI treats as "don't offer the switch".
  radio?: boolean | null;
}

export async function wifiStatus(): Promise<WifiStatus> {
  try {
    return await (await fetch("/tvbox/api/wifi/status", { cache: "no-store" })).json();
  } catch {
    return { connected: false, ssid: "" };
  }
}

export async function wifiList(): Promise<WifiNet[]> {
  try {
    return (await (await fetch("/tvbox/api/wifi/list", { cache: "no-store" })).json()).networks || [];
  } catch {
    return [];
  }
}

export async function wifiConnect(
  ssid: string,
  password: string,
  hidden = false,
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await (
      await fetch("/tvbox/api/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid, password, hidden }),
      })
    ).json();
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function wifiForget(ssid: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await (
      await fetch("/tvbox/api/wifi/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid }),
      })
    ).json();
  } catch {
    return { ok: false, error: "network" };
  }
}

// The radio as a lasting setting. On a box that lives on ethernet the wifi only
// costs Bluetooth airtime - the two share one antenna on this hardware - so
// turning it off is a real fix, not a power tweak. The shell refuses to turn it
// off with no wired carrier (`error: "no-ethernet"`), because the box would leave
// the LAN with no way back.
export async function wifiRadio(on: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    return await (
      await fetch("/tvbox/api/wifi/radio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on }),
      })
    ).json();
  } catch {
    return { ok: false };
  }
}
