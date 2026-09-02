// Launcher client for Fire TV remote IR programming (shell/firetvir.js).
// The flow in settings/pages/firetvir.tsx drives these. Codes come from the published
// index the box reads (shell/irindex.js), built from the community irdb database and
// Flipper-IRDB - both credited in About and in the flow's footer.
// The four the remote's own BUTTONS can hold, plus the ones that exist only to be
// blasted (a blast binds to no key, so it needs no scan id). Mirrors shell/irindex.js
// IR_KEYS - a key missing here is dropped from the saved plan.
export const IR_KEYS = [
  "VolumeUp",
  "VolumeDown",
  "Mute",
  "Power",
  "HDMI1",
  "HDMI2",
  "HDMI3",
  "HDMI4",
  "Input",
] as const;
// `as const` is load-bearing: without it `IrKey` below resolves to plain `string`,
// which un-checks every Partial<Record<IrKey, …>>, every assign map and every
// t("firetvir.key." + key) in the flow.
// The subset the firmware assigns a scan id to, i.e. what a keymap can hold. The shell
// drops an assignment for any other key and its Test answers "invalid key", so the
// screen that binds BUTTONS must offer only these.
export const PROGRAMMABLE_KEYS: IrKey[] = [...IR_KEYS].slice(0, 4);
export type IrKey = (typeof IR_KEYS)[number];
export type IrKind = "tv" | "audio" | "settop" | "player" | "climate" | "other";
export type IrSource = "irdb" | "flipper";

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

// One button's code: what it is called, and what the box hands the keymap builder. The
// entry is one of `{irdb:…}`, `{flipper:…}` or a raw capture - the launcher never looks
// inside, it only carries it back to the box.
export interface IrCode {
  protocol: string;
  entry: Record<string, unknown>;
}

// One device a brand offers, as the picker shows it: every codeset that sends the same
// four codes merged into a single row (scripts/ir-index/group.js).
export interface IrDevice {
  id: string;
  label: string;
  kind: IrKind;
  variant: string; // protocol + address, what tells two same-named rows apart
  count: number; // how many codesets across both databases carry this exact code
  types: string[];
  sources: IrSource[];
  protocols: string[];
  keys: Partial<Record<IrKey, IrCode>>; // the buttons it can actually drive
  usable: boolean | null; // the box's own answer; null = it could not tell
}

export interface IrBrandListing {
  brand: string;
  slug: string; // what a brand fetch is addressed by
  devices: number;
  kinds: string[];
}
export interface IrIndex {
  ok: boolean;
  revision?: string;
  generated?: string;
  notice?: string;
  brands?: IrBrandListing[];
  error?: string;
}
export interface BrandDevices {
  ok: boolean;
  brand?: string;
  slug?: string;
  devices?: IrDevice[];
  skipped?: number; // codesets with none of the four keys - nothing to program from
  error?: string;
}

// What the remote was set up to drive. Stored on the box because the keymap written to
// the remote cannot be read back - and it carries the CODES, so programming needs no
// index and no network.
export interface IrPlanDevice {
  id: string;
  brand: string;
  slug: string;
  label: string;
  kind: IrKind;
  count: number;
  sources: IrSource[];
  keys: Partial<Record<IrKey, IrCode>>;
}
export type IrAssign = Partial<Record<IrKey, { device: string; second: string | null }>>;
export interface IrSetup {
  devices: IrPlanDevice[];
  assign: IrAssign;
  // What was last written to THIS remote, per remote. The box-wide codes file cannot say
  // that: erasing one remote would clear what the screen reports about another.
  programmed: { label: string; ts: number } | null;
  ts: number;
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
// MACs (lowercase) of connected remotes that are Fire TV / Alexa remotes we can program
// (they expose the keymap GATT service). The remap UI shows the IR feature ONLY under
// these, so other remotes don't get the extra menu.
export function fetchProgrammableRemotes(): Promise<string[]> {
  return getJson<{ macs?: string[] }>("/tvbox/api/firetvir/programmable", {}).then((d) => d.macs || []);
}
export function installIrDeps(): Promise<{ ok: boolean }> {
  return postJson("/tvbox/api/firetvir/deps", {}, { ok: false });
}
export function fetchIrIndex(): Promise<IrIndex> {
  return getJson("/tvbox/api/firetvir/brands", { ok: false, error: "unreachable" });
}
export function fetchBrandDevices(slug: string): Promise<BrandDevices> {
  return getJson("/tvbox/api/firetvir/brand?slug=" + encodeURIComponent(slug), {
    ok: false,
    error: "unreachable",
  });
}
// null = the box could not be asked. NOT an empty plan: every writer sends the whole
// thing, so a caller that took a failed read for "nothing configured" would save that
// over a remote that is fully set up.
export function fetchIrSetup(mac: string): Promise<IrSetup | null> {
  return getJson<{ ok: boolean; plan?: IrSetup } | null>(
    "/tvbox/api/firetvir/plan?mac=" + encodeURIComponent(mac),
    null,
  ).then((r) => (r && r.ok && r.plan ? r.plan : null));
}
// The box answers with the plan it actually kept (it re-validates), so the screen shows
// what is stored rather than what was sent.
export function saveIrSetup(mac: string, plan: IrSetup): Promise<IrSetup | null> {
  return postJson<{ ok: boolean; plan?: IrSetup }>("/tvbox/api/firetvir/plan", { mac, plan }, { ok: false }).then(
    (r) => (r.ok && r.plan ? r.plan : null),
  );
}
// Test and program take the SAME object the plan route stores: one shape, so a test
// cannot fire something other than what a save would write. `key` narrows the test to
// one button.
export function testIrKey(mac: string, setup: IrSetup, key: IrKey): Promise<ToolResult> {
  return postJson("/tvbox/api/firetvir/test", { mac, plan: setup, key }, { ok: false, error: "unreachable" });
}
export function programIr(mac: string, setup: IrSetup, label: string): Promise<ToolResult> {
  return postJson("/tvbox/api/firetvir/program", { mac, plan: setup, label }, { ok: false, error: "unreachable" });
}
export function eraseIr(mac: string): Promise<ToolResult> {
  return postJson("/tvbox/api/firetvir/erase", { mac }, { ok: false, error: "unreachable" });
}

// The buttons a device can drive, in the order the screens list them.
export const deviceKeys = (d: { keys: Partial<Record<IrKey, IrCode>> }): IrKey[] => IR_KEYS.filter((k) => !!d.keys[k]);

// A code this box cannot generate would blast nothing, so the picker greys it out
// instead. An unknown answer (the probe could not run) counts as usable - refusing on no
// information hides codes that work.
export const deviceSupported = (d: IrDevice): boolean => d.usable !== false;

// A picked device, as the plan stores it: the codes travel with it, so what gets
// programmed is what was chosen even if the index moves on.
export function planDevice(d: IrDevice, brand: string, slug: string): IrPlanDevice {
  return {
    id: d.id,
    brand,
    slug,
    label: d.label,
    kind: d.kind,
    count: d.count,
    sources: d.sources,
    keys: d.keys,
  };
}

// A setup carrying ONE key's assignment, for the per-key test: the box blasts exactly
// what it would program for that button, second device included.
export function forKey(setup: IrSetup, key: IrKey, device?: string): IrSetup {
  const a = device ? { device, second: null } : setup.assign[key];
  return { ...setup, assign: a ? { [key]: a } : {} };
}
