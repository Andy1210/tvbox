import { describe, it, expect, vi, afterEach } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { FiretvIrPage } from "./firetvir";
import { toIrPlan, type IrSetup } from "../../lib/firetvir";
import { setupRemote, setFocus, remote } from "../../test/remote";
import { SettingsNavProvider, useSettingsNav, type StackEntry } from "../nav";

// The screen is a stack of pushed pages and only the top one is mounted, so a test
// that renders the page bare can never reach the picker. This is the composition
// Settings.tsx does; "settings root" showing means the stack was emptied, which is
// how a pop too many becomes visible.
function Stack({ stack }: { stack: StackEntry[] }) {
  const nav = useSettingsNav();
  useEffect(() => {
    nav.push({
      id: "ftir",
      title: "",
      render: () => <FiretvIrPage device={{ id: "aa:bb:cc:dd:ee:ff", name: "Fire TV Remote" }} />,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const top = stack[stack.length - 1];
  return top ? <div key={top.id}>{top.render()}</div> : <div>settings root</div>;
}
const Page = () => <SettingsNavProvider>{(stack) => <Stack stack={stack} />}</SettingsNavProvider>;

setupRemote();

// Samsung as the box really merges it: one TV code that dozens of remote model
// numbers share, a soundbar with volume but no power, and an air conditioner whose
// IR format this box cannot generate.
const SAMSUNG = [
  {
    id: "aaaaaaaaaaaa",
    path: "codes/Samsung/TV/7,7.csv",
    label: "TV",
    kind: "tv",
    count: 27,
    types: ["TV"],
    keys: ["VolumeUp", "VolumeDown", "Mute", "Power"],
    protocols: ["NECx2"],
    variant: "NECx2 7,7",
    supported: { NECx2: true },
  },
  {
    id: "bbbbbbbbbbbb",
    path: "codes/Samsung/Unknown_AH59-01527F/67,83.csv",
    label: "AH59-01527F",
    kind: "other",
    count: 1,
    types: ["AH59-01527F"],
    keys: ["VolumeUp", "VolumeDown", "Mute"],
    protocols: ["NECx2"],
    variant: "NECx2 67,83",
    supported: { NECx2: true },
  },
  {
    id: "cccccccccccc",
    path: "codes/Samsung/Air Conditioner/1,8.csv",
    label: "Air Conditioner",
    kind: "climate",
    count: 2,
    types: ["Air Conditioner"],
    keys: ["Power"],
    protocols: ["Samsung20"],
    variant: "Samsung20 1,8",
    supported: { Samsung20: false },
  },
];

// The box's own copy of the plan: a POST replaces it and the next GET returns it,
// which is what the pages agree through (each level re-reads on mount).
function stubShell(initial?: IrSetup, planDelayMs = 0) {
  const state = { plan: initial || ({ devices: [], assign: {}, programmed: null, ts: 0 } as IrSetup) };
  const posted: Record<string, unknown>[] = [];
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      if (url.includes("/firetvir/plan")) {
        state.plan = body.plan as IrSetup;
        return json({ ok: true, plan: state.plan });
      }
      return json({ ok: true });
    }
    if (url.includes("/firetvir/status"))
      return json({ depsOk: true, installing: false, configured: null, suggestedBrand: "Samsung" });
    if (url.includes("/firetvir/plan")) {
      const answer = json({ ok: true, plan: state.plan });
      return planDelayMs ? new Promise((r) => setTimeout(() => r(answer), planDelayMs)) : answer;
    }
    if (url.includes("/firetvir/brands"))
      return json({ ok: true, brands: [{ brand: "Samsung", sets: [{ name: "7,7", path: "x", type: "TV" }] }] });
    if (url.includes("/firetvir/brand")) return json({ ok: true, state: "ok", devices: SAMSUNG, skipped: 4 });
    return json({});
  });
  return { state, posted };
}
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 20)));

const setup = (devices: IrSetup["devices"], assign: IrSetup["assign"]): IrSetup => ({
  devices,
  assign,
  programmed: null,
  ts: 1,
});
const TV = {
  id: "aaaaaaaaaaaa",
  brand: "Samsung",
  label: "TV",
  kind: "tv" as const,
  path: "codes/Samsung/TV/7,7.csv",
  keys: ["VolumeUp", "VolumeDown", "Mute", "Power"] as IrSetup["devices"][0]["keys"],
  protocol: "NECx2",
  count: 27,
};

describe("the Fire TV IR screen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("picking a code returns to the device list, not three screens deep in the picker", async () => {
    const { state } = stubShell();
    render(<Page />);
    await settle();

    await setFocus("ftir:add");
    await remote.ok(); // brand picker
    await settle();
    await setFocus("ftir-brand:suggested"); // the TV the box is plugged into
    await remote.ok();
    await settle();
    expect(screen.getByText("AH59-01527F")).toBeTruthy();

    await setFocus("ftir-sets:dev-aaaaaaaaaaaa");
    await remote.ok();
    await settle();

    // Back on the main page - not on the codeset list, and not past it either.
    expect(screen.getByText("Save to the remote")).toBeTruthy();
    expect(screen.queryByText("settings root")).toBeNull();
    expect(state.plan.devices.map((d) => d.label)).toEqual(["TV"]);
  });

  it("a new device claims only the buttons nobody has", async () => {
    // The TV already drives all four. Adding the soundbar for volume must not take
    // the power button off the TV with it.
    const { state } = stubShell(
      setup([TV], {
        VolumeUp: { device: TV.id, second: null },
        VolumeDown: { device: TV.id, second: null },
        Mute: { device: TV.id, second: null },
        Power: { device: TV.id, second: null },
      }),
    );
    render(<Page />);
    await settle();

    await setFocus("ftir:key-VolumeUp");
    await remote.ok();
    await settle();
    await setFocus("ftir-key:add"); // add a device FOR this button
    await remote.ok();
    await settle();
    await setFocus("ftir-brand:suggested");
    await remote.ok();
    await settle();
    await setFocus("ftir-sets:dev-bbbbbbbbbbbb"); // the soundbar
    await remote.ok();
    await settle();

    expect(state.plan.assign.VolumeUp?.device).toBe("bbbbbbbbbbbb");
    expect(state.plan.assign.Power?.device).toBe(TV.id);
    expect(state.plan.assign.VolumeDown?.device).toBe(TV.id);
    expect(state.plan.devices).toHaveLength(2);
  });

  it("hides codes that cannot drive the button being assigned", async () => {
    stubShell(setup([TV], { Power: { device: TV.id, second: null } }));
    render(<Page />);
    await settle();

    await setFocus("ftir:key-VolumeUp");
    await remote.ok();
    await settle();
    await setFocus("ftir-key:add");
    await remote.ok();
    await settle();
    await setFocus("ftir-brand:suggested");
    await remote.ok();
    await settle();

    expect(screen.getByText("AH59-01527F")).toBeTruthy();
    // Power-only, so it can never drive volume - and the filter is on by default.
    expect(screen.queryByText("Air Conditioner")).toBeNull();
  });

  it("offers a code whose IR format the box cannot generate as unpressable", async () => {
    const { state } = stubShell();
    render(<Page />);
    await settle();
    await setFocus("ftir:add");
    await remote.ok();
    await settle();
    await setFocus("ftir-brand:suggested");
    await remote.ok();
    await settle();

    // No key filter here (adding a device, not assigning a button), so the air
    // conditioner is listed - but pressing it must do nothing.
    const row = screen.getByText("Air Conditioner").closest("[data-sfocus]");
    expect(row).toBeNull(); // a disabled row carries no focus key at all
    await act(async () => {
      screen.getByText("Air Conditioner").click();
    });
    await settle();
    expect(state.plan.devices).toHaveLength(0);
  });

  it("a button's page opens on the device it is assigned to, not on 'not set'", async () => {
    // Found on the box: SettingsPage places the focus on the first row that exists
    // and keeps it there, so a page that renders its list before the box has
    // answered opens on "not set" for a button that IS assigned.
    stubShell(setup([TV], { VolumeUp: { device: TV.id, second: null } }), 40);
    render(<Page />);
    await settle();
    await settle(); // the main page's own read of the plan, which is delayed too
    await setFocus("ftir:key-VolumeUp");
    await remote.ok();
    // Deliberately BEFORE the plan lands: nothing may be focusable yet.
    expect(document.querySelectorAll("[data-sfocus]")).toHaveLength(0);
    await settle();
    await settle();
    expect(document.querySelector("[data-sautofocus]")?.getAttribute("data-sfocus")).toBe("ftir-key:pick-" + TV.id);
  });

  it("the type filter survives being used - it is not a page that unmounts the list", async () => {
    // The trap settings/nav.tsx documents: a pushed picker unmounts the level below,
    // so its setState lands on a dead component and the remount restores the default.
    // The filter is a left/right row for exactly that reason.
    stubShell();
    render(<Page />);
    await settle();
    await setFocus("ftir:add");
    await remote.ok();
    await settle();
    await setFocus("ftir-brand:suggested");
    await remote.ok();
    await settle();

    expect(screen.queryByText("Air Conditioner")).toBeTruthy();
    await setFocus("ftir-sets:kind");
    await remote.right(); // all -> TV
    await settle();
    // By row rather than by text: "TV" is now also the filter's own value.
    expect(document.querySelector('[data-sfocus="ftir-sets:dev-aaaaaaaaaaaa"]')).toBeTruthy();
    expect(screen.queryByText("Air Conditioner")).toBeNull();
    expect(screen.queryByText("AH59-01527F")).toBeNull();
    // ...and it is still filtered a moment later, with no round trip to undo it.
    await settle();
    expect(screen.queryByText("Air Conditioner")).toBeNull();
  });

  it("a plan the box would not hand over is never written over", async () => {
    // The picker sends the WHOLE plan. If a failed read looked like an empty one,
    // picking a code here would erase every device the remote already drives.
    const { state, posted } = stubShell(setup([TV], { Power: { device: TV.id, second: null } }));
    render(<Page />);
    await settle();
    await setFocus("ftir:add");
    await remote.ok();
    await settle();
    await setFocus("ftir-brand:suggested");
    await remote.ok();
    await settle();

    // The box goes away exactly while the picker is open - it can sit here for
    // minutes while codesets download.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("shell restarting")));
    await setFocus("ftir-sets:dev-aaaaaaaaaaaa");
    await remote.ok();
    await settle();

    expect(posted.filter((b) => "plan" in b)).toHaveLength(0);
    expect(state.plan.devices.map((d) => d.id)).toEqual([TV.id]);
    expect(screen.getByText(/didn't save|Couldn't read/)).toBeTruthy();
  });

  it("does not claim a brand has nothing while its codesets are still downloading", async () => {
    // The box answers `loading` with total 0 until it has counted them, and that is
    // not the same as a brand with no codes - a user who reads it as one presses Back.
    const { state } = stubShell();
    let answers = 0;
    const real = globalThis.fetch as typeof fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (String(url).includes("/firetvir/brand?") && answers++ < 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, state: "loading", done: 0, total: 0 }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return real(url, init);
    });
    render(<Page />);
    await settle();
    await setFocus("ftir:add");
    await remote.ok();
    await settle();
    await setFocus("ftir-brand:suggested");
    await remote.ok();
    await settle();

    expect(screen.queryByText("Nothing here with that button.")).toBeNull();
    expect(state.plan.devices).toHaveLength(0);
  });

  it("picking through the letter index comes back to the device list in one step", async () => {
    // brand -> letter -> codes is three pushes, which is what popTo exists for; the
    // suggestion route only ever goes two deep.
    const { state } = stubShell();
    render(<Page />);
    await settle();
    await setFocus("ftir:add");
    await remote.ok();
    await settle();
    await setFocus("ftir-brand:letter-S");
    await remote.ok();
    await settle();
    await setFocus("ftir-letter:brand-Samsung");
    await remote.ok();
    await settle();
    await setFocus("ftir-sets:dev-aaaaaaaaaaaa");
    await remote.ok();
    await settle();

    expect(screen.getByText("Save to the remote")).toBeTruthy();
    expect(screen.queryByText("settings root")).toBeNull();
    expect(state.plan.devices).toHaveLength(1);
  });

  it("a button assigned to nothing is left out of the plan rather than inheriting", () => {
    const plan = toIrPlan(
      setup([TV], { VolumeUp: { device: TV.id, second: null }, Power: { device: "gone", second: null } }),
    );
    expect(plan.base).toBeNull();
    expect(plan.keys.VolumeUp).toEqual({ path: TV.path });
    expect(plan.keys.Power).toBeUndefined();
  });

  it("a second device rides along on the same key", () => {
    const bar = {
      ...TV,
      id: "bbbbbbbbbbbb",
      label: "AH59-01527F",
      path: "codes/Samsung/Unknown_AH59-01527F/67,83.csv",
    };
    const plan = toIrPlan(setup([TV, bar], { Power: { device: TV.id, second: bar.id } }));
    expect(plan.keys.Power).toEqual({ path: TV.path, second: bar.path });
  });
});
