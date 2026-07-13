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
  sets: { name: string; path: string }[];
}
export interface IrCodeset {
  ok: boolean;
  path: string;
  keys: Record<string, { functionname: string; protocol: string }>;
  protocols: string[];
  supported: Record<string, boolean> | null; // per-protocol, null if the check failed
  error?: string;
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
export function testIrKey(mac: string, path: string, key: string): Promise<ToolResult> {
  return postJson("/tvbox/api/firetvir/test", { mac, path, key }, { ok: false, error: "unreachable" });
}
export function programIr(mac: string, path: string, label: string): Promise<ToolResult> {
  return postJson("/tvbox/api/firetvir/program", { mac, path, label }, { ok: false, error: "unreachable" });
}
export function eraseIr(mac: string): Promise<ToolResult> {
  return postJson("/tvbox/api/firetvir/erase", { mac }, { ok: false, error: "unreachable" });
}
