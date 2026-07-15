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
