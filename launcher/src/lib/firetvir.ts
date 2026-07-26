// Launcher client for Fire TV remote IR programming (shell/firetvir.js).
// The guided flow in FiretvIrSettings.tsx drives these; the codesets come from
// the community irdb database (credited in About + the flow's footer).
export interface FiretvIrStatus {
  toolPresent: boolean;
  venvPresent: boolean;
  depsOk: boolean;
  installing: boolean;
  installStep: string;
  installError: string;
  configured: { name: string; source: string } | null;
  suggestedBrand: string | null; // the connected TV's brand (EDID/CEC), pre-selected in the flow
}
export interface IrBrand {
  brand: string;
  // `type` is the irdb device folder ("TV", "Receiver", "Unknown_AH59-..."). The
  // base picker shows TV sets; a per-key override shows all of them, since a
  // button can drive something else entirely (a soundbar on volume).
  sets: { name: string; path: string; type: string }[];
}
export interface IrCodeset {
  ok: boolean;
  path: string;
  keys: Record<string, { functionname: string; protocol: string }>;
  protocols: string[];
  supported: Record<string, boolean> | null; // per-protocol, null if the check failed
  error?: string;
}
// What gets written to the remote: one base codeset for every key, plus
// optional per-key overrides (a different brand on a single button) and an
// optional second device on a key, so one press blasts both.
export interface IrPlan {
  base: string | null;
  keys: Record<string, { path?: string; second?: string }>;
}
export interface ToolResult {
  ok: boolean;
  code?: number;
  output?: string;
  error?: string;
}

async function getJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return fallback; // 404/500 (e.g. the demo's not-mocked routes) -> no data
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

export function fetchIrStatus(): Promise<FiretvIrStatus | null> {
  return getJson<FiretvIrStatus | null>("/tvbox/api/firetvir/status", null);
}
// MACs (lowercase) of connected remotes that are Fire TV / Alexa remotes we can
// program (they expose the keymap GATT service). The remap UI shows the IR
// feature ONLY under these, so other remotes don't get the extra menu.
export function fetchProgrammableRemotes(): Promise<string[]> {
  return getJson<{ macs?: string[] }>("/tvbox/api/firetvir/programmable", {}).then((d) => d.macs || []);
}
export function installIrDeps(): Promise<{ ok: boolean }> {
  return postJson("/tvbox/api/firetvir/deps", {}, { ok: false });
}
export function fetchIrBrands(): Promise<{ ok: boolean; brands?: IrBrand[]; error?: string }> {
  return getJson("/tvbox/api/firetvir/brands", { ok: false, error: "unreachable" });
}
export function fetchIrCodeset(path: string): Promise<IrCodeset> {
  return getJson("/tvbox/api/firetvir/codeset?path=" + encodeURIComponent(path), {
    ok: false,
    path,
    keys: {},
    protocols: [],
    supported: null,
    error: "unreachable",
  });
}
export function testIrKey(mac: string, plan: IrPlan, key: string): Promise<ToolResult> {
  return postJson("/tvbox/api/firetvir/test", { mac, plan, key }, { ok: false, error: "unreachable" });
}
export function programIr(mac: string, plan: IrPlan, label: string): Promise<ToolResult> {
  return postJson("/tvbox/api/firetvir/program", { mac, plan, label }, { ok: false, error: "unreachable" });
}
export function eraseIr(mac: string): Promise<ToolResult> {
  return postJson("/tvbox/api/firetvir/erase", { mac }, { ok: false, error: "unreachable" });
}
