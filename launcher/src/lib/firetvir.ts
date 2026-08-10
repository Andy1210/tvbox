// Launcher client for Fire TV remote IR programming (shell/firetvir.js).
// The flow in settings/pages/firetvir.tsx drives these; the codesets come from the
// community irdb database (credited in About + the flow's footer).
export const IR_KEYS = ["VolumeUp", "VolumeDown", "Mute", "Power"] as const;
export type IrKey = (typeof IR_KEYS)[number];
export type IrKind = "tv" | "audio" | "settop" | "player" | "climate" | "other";

export interface FiretvIrStatus {
  toolPresent: boolean;
  venvPresent: boolean;
  depsOk: boolean;
  installing: boolean;
  installStep: string;
  installError: string;
  configured: { name: string; source: string } | null;
  suggestedBrand: string | null; // the connected TV's brand (EDID/CEC), offered first in the picker
}
export interface IrBrand {
  brand: string;
  // The irdb device folders under this brand. Only the COUNT is used now - what a
  // brand really offers is `IrDevice[]`, which merges these by the codes they send.
  sets: { name: string; path: string; type: string }[];
}
// One device a brand offers, as the picker shows it: every codeset that sends the
// same four codes merged into a single row (shell/firetvir.js `groupSets`).
export interface IrDevice {
  id: string;
  path: string; // the codeset it is programmed from
  label: string;
  kind: IrKind;
  count: number; // how many irdb folders carry this exact code
  types: string[];
  keys: IrKey[]; // the buttons it can actually drive
  protocols: string[];
  variant: string; // protocol + address, what tells two same-named rows apart
  supported: Record<string, boolean> | null; // per protocol; null = the check could not run
}
export interface BrandDevices {
  ok: boolean;
  state?: "loading" | "ok";
  done?: number;
  total?: number;
  devices?: IrDevice[];
  skipped?: number; // codesets with none of the four keys - nothing to program from
  // Codesets that did not come down. A short list looks exactly like a brand with
  // little in it, so the count travels with the answer and the page offers a retry.
  failed?: number;
  error?: string;
}
// What the remote was set up to drive. Stored on the box because the keymap written
// to the remote cannot be read back, so this is the only record of it.
export interface IrPlanDevice {
  id: string;
  brand: string;
  label: string;
  kind: IrKind;
  path: string;
  keys: IrKey[];
  protocol: string;
  count: number;
}
export type IrAssign = Partial<Record<IrKey, { device: string; second: string | null }>>;
export interface IrSetup {
  devices: IrPlanDevice[];
  assign: IrAssign;
  ts: number;
}
// The wire format the shell resolves into a keymap: a codeset per key, plus an
// optional second device on a key so one press blasts both.
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
// Poll while `state === "loading"`: the box is downloading that brand's codesets
// and `done`/`total` is how far it is.
export function fetchBrandDevices(brand: string): Promise<BrandDevices> {
  return getJson("/tvbox/api/firetvir/brand?name=" + encodeURIComponent(brand), {
    ok: false,
    error: "unreachable",
  });
}
// null = the box could not be asked. NOT an empty plan: every writer sends the
// whole thing, so a caller that took a failed read for "nothing configured" would
// save that over a remote that is fully set up.
export function fetchIrSetup(mac: string): Promise<IrSetup | null> {
  return getJson<{ ok: boolean; plan?: IrSetup } | null>(
    "/tvbox/api/firetvir/plan?mac=" + encodeURIComponent(mac),
    null,
  ).then((r) => (r && r.ok && r.plan ? r.plan : null));
}
// The box answers with the plan it actually kept (it re-validates), so the screen
// shows what is stored rather than what was sent.
export function saveIrSetup(mac: string, plan: IrSetup): Promise<IrSetup | null> {
  return postJson<{ ok: boolean; plan?: IrSetup }>("/tvbox/api/firetvir/plan", { mac, plan }, { ok: false }).then(
    (r) => (r.ok && r.plan ? r.plan : null),
  );
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

// The stored setup, as the shell's programmer wants it. `base` stays null on
// purpose: every key names its own codeset, so a key nobody assigned is simply
// absent instead of silently inheriting another device's codes.
export function toIrPlan(setup: IrSetup): IrPlan {
  const byId = new Map(setup.devices.map((d) => [d.id, d]));
  const keys: IrPlan["keys"] = {};
  for (const key of IR_KEYS) {
    const a = setup.assign[key];
    const dev = a && byId.get(a.device);
    if (!dev) continue;
    const second = a?.second ? byId.get(a.second) : null;
    keys[key] = second ? { path: dev.path, second: second.path } : { path: dev.path };
  }
  return { base: null, keys };
}

// A plan carrying ONE key, for the per-key test: the shell blasts exactly what it
// would program, second device included.
export function toSingleKeyPlan(setup: IrSetup, key: IrKey): IrPlan {
  const full = toIrPlan(setup);
  return { base: null, keys: full.keys[key] ? { [key]: full.keys[key] } : {} };
}

// A codeset whose protocol this box cannot generate would blast nothing, so the
// picker greys it out instead. An unknown answer (the check could not run) counts
// as usable - refusing on no information hides codes that work.
export const deviceSupported = (d: IrDevice): boolean =>
  !d.supported || d.protocols.every((p) => d.supported?.[p] !== false);
