// Launcher-side access to the shell's Bluetooth control (BlueZ/bluetoothctl).
// Scans, lists, and pairs/connects devices - audio (speakers/headphones) and
// input (keyboard/mouse). Absent during `vite dev`.
export interface BtDevice {
  mac: string;
  name: string;
  type: string; // audio | keyboard | mouse | gamepad | phone | computer | ""
  paired: boolean;
  connected: boolean;
  battery: number | null; // % from BlueZ BAS (HID remotes); null = not reported
}
export interface BtStatus {
  powered: boolean;
  discovering: boolean;
}
export type BtAction = "pair" | "connect" | "disconnect" | "remove";

async function getJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}
async function postJson<T>(url: string, body: unknown, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}

export function fetchBtStatus(): Promise<BtStatus> {
  return getJson<BtStatus>("/tvbox/api/bt/status", { powered: false, discovering: false });
}
export async function fetchBtDevices(): Promise<BtDevice[]> {
  return (await getJson<{ devices: BtDevice[] }>("/tvbox/api/bt/devices", { devices: [] })).devices;
}
export async function btScan(seconds = 8): Promise<BtDevice[]> {
  return (await postJson<{ devices: BtDevice[] }>("/tvbox/api/bt/scan", { seconds }, { devices: [] })).devices;
}
export function btAction(action: BtAction, mac: string): Promise<{ ok: boolean; error?: string }> {
  return postJson<{ ok: boolean; error?: string }>("/tvbox/api/bt/" + action, { mac }, { ok: false });
}
