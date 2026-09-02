import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { IrPage } from "./ir";
import { useConfigStore } from "../../stores/config";
import { setupRemote, setFocus, remote } from "../../test/remote";
import { SettingsNavProvider, useSettingsNav, type StackEntry } from "../nav";

// The `firetv` blaster's actions point at entries of the remote's SAVED CODE PLAN, and
// the first cut of this screen asked a person to type one (`audio:Power`) on an on-screen
// keyboard. Everything below is a way that went wrong in use rather than in a test:
// the four "TV input" rows offered the television's Power key as readily as an input, a
// rejected save reported nothing because the page reporting it had been unmounted, and a
// plan that could not be read looked exactly like a plan that did not exist.
setupRemote();

// Only the top of the stack is mounted, so a test that renders the page bare can never
// reach the picker.
function Stack({ stack }: { stack: StackEntry[] }) {
  const nav = useSettingsNav();
  useEffect(() => {
    nav.push({ id: "ir", title: "", render: () => <IrPage /> });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const top = stack[stack.length - 1];
  return top ? <div key={top.id}>{top.render()}</div> : <div>settings root</div>;
}
const Page = () => <SettingsNavProvider>{(stack) => <Stack stack={stack} />}</SettingsNavProvider>;

const MAC = "7C:ED:C6:12:E6:3C";
const RAW = { protocol: "raw", entry: { raw: [452, 449, 50, 50, 50, 151, 50], frequency: 38000 } };
const irdb = (fn: number) => ({
  protocol: "NEC1",
  entry: { irdb: { protocol: "NEC1", device: 4, subdevice: -1, function: fn } },
});

// This house's real plan: an LG with the four programmable keys plus two inputs, and a
// soundbar whose codes are raw captures.
const PLAN = {
  devices: [
    {
      id: "0ecd67cc2a8e",
      brand: "LG",
      label: "TV (NEC1 4)",
      kind: "tv",
      keys: { Power: irdb(8), Mute: irdb(9), HDMI1: irdb(206), HDMI2: irdb(204) },
    },
    { id: "c853fb071464", brand: "Samsung", label: "Sound Bars", kind: "audio", keys: { Power: RAW } },
  ],
  assign: {},
  ts: 0,
};

const config = (actions: Record<string, string>) => ({
  ir: {
    configured: true,
    backend: "firetv",
    esphome: { host: "", port: null, hasEncryptionKey: false, select: "signal_select", button: "send", actions: {} },
    homeassistant: { url: "", hasToken: false, actions: {} },
    firetv: { mac: MAC, actions },
  },
  ui: { hourFormat: "auto", navSounds: true },
});

// `plan` null = the box could not be asked; [] = there is no plan.
function stubShell(
  plan: unknown,
  opts: { saveFails?: boolean; status?: Record<string, unknown>; send?: () => Promise<unknown> } = {},
) {
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body || "{}")));
      if (opts.saveFails) return Promise.resolve(new Response("no", { status: 500 }));
      // A send that only settles when the test says so, which is the only way to
      // assert what the screen does WHILE a blast is in flight.
      if (u.includes("/ir/send") && opts.send) return opts.send();
    }
    const body = u.includes("/firetvir/plan")
      ? plan === null
        ? { ok: false } // the box could not be asked
        : { ok: true, plan }
      : u.includes("/ir/status")
        ? opts.status || {}
        : { config: config({}) };
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  });
  return posted;
}
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 30)));

describe("the IR blaster's firetv targets", () => {
  beforeEach(() =>
    useConfigStore.setState({ config: config({ soundbar_power: "audio:Power" }) as never, error: false }),
  );
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a mapped target in words, not as the token it stores", async () => {
    stubShell(PLAN);
    render(<Page />);
    await settle();
    // `audio:Power` is what the box needs; it is not what anybody should have to read.
    expect(screen.getByText("Power · Audio")).toBeTruthy();
    expect(screen.queryByText("audio:Power")).toBeNull();
  });

  // ---- what the screen says about the link ------------------------------------------
  // It used to render "A jeladó nem elérhető: " plus the shell's raw ENGLISH sentence.
  // Two mistakes in one line: a sleeping remote is not an unreachable blaster - it is
  // one button press away - and the only actionable half was untranslated.
  it("shows a failure as its translated cause, with no English on the screen", async () => {
    stubShell(PLAN, {
      status: {
        configured: true,
        backend: "firetv",
        connected: false,
        actions: ["soundbar_power"],
        lastError: "the remote did not answer - press a button on it to wake it, then retry",
        cause: "asleep",
      },
    });
    render(<Page />);
    await settle();
    // The cause, as the locale writes it - not the shell's own sentence, which is what
    // a voice assistant reads out and has no business on a screen.
    expect(screen.getByText(/Press a button on the remote to wake it/)).toBeTruthy();
    expect(screen.queryByText(/press a button on it to wake it, then retry/)).toBeNull();
    expect(screen.queryByText(/not reachable/)).toBeNull();
  });

  it("a link that is merely down gets no warning at all", async () => {
    // It is the resting state of a healthy box: the remote sleeps between presses and
    // the link is opened by the next blast. A warning here fires after every reboot on
    // a box with nothing wrong with it.
    stubShell(PLAN, {
      status: {
        configured: true,
        backend: "firetv",
        connected: false,
        actions: [],
        lastError: "",
        cause: null,
        service: { link: false, held: false, failed: false },
      },
    });
    render(<Page />);
    await settle();
    expect(screen.queryByText(/link/i)).toBeNull();
  });

  it("a service that will not start IS a fault, and says so", async () => {
    stubShell(PLAN, {
      status: {
        configured: true,
        backend: "firetv",
        connected: false,
        actions: [],
        lastError: "",
        cause: null,
        service: { link: null, held: false, failed: true },
      },
    });
    render(<Page />);
    await settle();
    expect(screen.getByText(/IR service will not start/)).toBeTruthy();
  });

  // A disabled row loses its focus key, so the cursor jumped to the top of the page and
  // the next OK opened the blaster-type picker - which unmounts this page and throws the
  // test result away.
  it("keeps the tested row focusable and says so when a second test is pressed", async () => {
    // A disabled row loses its focus key, so the cursor jumped to the top of the page
    // and the next OK opened the blaster-type picker - which unmounts this page and
    // throws the result away. With the row enabled, a press that did nothing at all was
    // the new dead button, so the second one has to say something.
    let settleSend: ((v: unknown) => void) | null = null;
    const posted = stubShell(PLAN, {
      send: () =>
        new Promise((res) => {
          settleSend = () =>
            res(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
        }),
    });
    render(<Page />);
    await settle();

    await setFocus("ir:test-soundbar_power");
    await remote.ok();
    await settle();
    // In flight: the row says so, and it is still the focusable row it was.
    const busyRow = screen.getByText(/Sending… · Soundbar power/);
    expect(busyRow.closest("[data-sfocus]")).toBeTruthy();
    expect(posted.filter((x) => "action" in x).length).toBe(1);

    // A second press, on the same row: no second blast, and the screen says why.
    await remote.ok();
    await settle();
    expect(posted.filter((x) => "action" in x).length).toBe(1);
    expect(screen.getByText(/A test is already running/)).toBeTruthy();

    (settleSend as unknown as () => void)();
    await settle();
    // ...and the outcome lands on the row that was pressed, not only in a note a
    // screen and a half above it.
    expect(screen.getAllByText(/Sent\./).length).toBeGreaterThan(1);
  });

  it("offers an input row only the keys that ARE inputs", async () => {
    stubShell(PLAN);
    render(<Page />);
    await settle();

    await setFocus("ir:map-input_hdmi2");
    await remote.ok();
    await settle();

    expect(screen.getByText("HDMI 2 · TV")).toBeTruthy();
    expect(screen.getByText("HDMI 1 · TV")).toBeTruthy();
    // The television's Power key is in the same plan and must not be on offer here:
    // binding it would turn the set off while the assistant reports an input switch.
    expect(screen.queryByText("Power · TV")).toBeNull();
    expect(screen.queryByText("Power · Audio")).toBeNull();
  });

  it("offers a soundbar row nothing but AUDIO devices", async () => {
    // "not a television" was too loose: it let a soundbar action bind to a set-top
    // box's Power, which is not what anyone means by "soundbar" and which the row's
    // label does not warn about.
    const withBox = {
      ...PLAN,
      devices: [
        ...PLAN.devices,
        { id: "aabbccddeeff", brand: "Sky", label: "Set-top", kind: "settop", keys: { Power: irdb(2) } },
      ],
    };
    stubShell(withBox);
    render(<Page />);
    await settle();
    await setFocus("ir:map-soundbar_power");
    await remote.ok();
    await settle();
    expect(screen.getByText("Power · Audio")).toBeTruthy();
    expect(screen.queryByText("Power · Set-top")).toBeNull();
  });

  it("offers a TV input row nothing but the television", async () => {
    const withBox = {
      ...PLAN,
      devices: [
        ...PLAN.devices,
        { id: "aabbccddeeff", brand: "Sky", label: "Set-top", kind: "settop", keys: { HDMI1: irdb(206) } },
      ],
    };
    stubShell(withBox);
    render(<Page />);
    await settle();
    await setFocus("ir:map-input_hdmi1");
    await remote.ok();
    await settle();
    expect(screen.getByText("HDMI 1 · TV")).toBeTruthy();
    expect(screen.queryByText("HDMI 1 · Set-top")).toBeNull();
  });

  it("offers a soundbar row nothing from the television", async () => {
    stubShell(PLAN);
    render(<Page />);
    await settle();

    await setFocus("ir:map-soundbar_power");
    await remote.ok();
    await settle();

    expect(screen.getByText("Power · Audio")).toBeTruthy();
    expect(screen.queryByText("Power · TV")).toBeNull();
  });

  it("says the plan could not be READ rather than that it is missing", async () => {
    // Two different sentences, because conflating them sent somebody off to build a
    // plan they already had.
    stubShell(null);
    render(<Page />);
    await settle();
    // On every row that has nothing to offer, which is all of them.
    expect(screen.getAllByText(/could not read/i).length).toBeGreaterThan(0);

    cleanup();
    stubShell({ devices: [], assign: {}, ts: 0 });
    render(<Page />);
    await settle();
    expect(screen.getAllByText(/Build the remote's code plan first/i).length).toBeGreaterThan(0);
  });

  it("keeps a stale mapping clearable after the plan is gone", async () => {
    // The row would otherwise show a raw token and refuse to open, so the mapping could
    // never be removed from the screen.
    stubShell({ devices: [], assign: {}, ts: 0 });
    render(<Page />);
    await settle();

    await setFocus("ir:map-soundbar_power");
    await remote.ok();
    await settle();
    expect(screen.getByText("not set")).toBeTruthy();
  });

  it("only offers to test what is actually mapped", async () => {
    stubShell(PLAN);
    render(<Page />);
    await settle();
    // One mapped action, so one test row - not twelve, eleven of them dimmed.
    expect(screen.queryAllByText(/^Test · /).length).toBe(1);
  });

  it("a rejected pick leaves the picker open to say so", async () => {
    stubShell(PLAN, { saveFails: true });
    render(<Page />);
    await settle();

    await setFocus("ir:map-input_hdmi2");
    await remote.ok();
    await settle();
    await setFocus("ir-target-input_hdmi2:tv:HDMI2");
    await remote.ok();
    await settle();

    // Still on the picker (the page below it is unmounted, so a failure reported there
    // would be reported to nobody).
    expect(screen.getByText("HDMI 2 · TV")).toBeTruthy();
    expect(screen.queryByText("settings root")).toBeNull();
  });
});
