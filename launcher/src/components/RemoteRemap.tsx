import { useEffect, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { RemoteAction, RemoteDeviceConfig, RemotePower } from "@sdk/config";
import { useI18n } from "../lib/i18n";
import { useConfigStore } from "../stores/config";
import {
  REMOTE_ACTIONS,
  fetchRemoteDevices,
  fetchLearned,
  learnRemote,
  learnRemoteOff,
  type ConnectedRemote,
} from "../lib/remote";
import { fetchApps } from "../lib/api";
import { fetchProgrammableRemotes } from "../lib/firetvir";
import { FocusButton } from "./FocusButton";
import { FiretvIrSettings } from "./FiretvIrSettings";

// Per-device button remap (Settings -> Peripherals). Lists the connected remotes;
// pressing one expands its actions (drill-down), and picking an action then
// pressing a button on THAT remote binds it. Handled entirely by the shell-side
// bridge (remote_input_bridge.py), which captures & swallows the pressed button,
// so remapping one remote never affects another and nothing navigates while
// learning. Standard buttons keep working; this only overrides the taught ones.

const keyBase = (id: string) => "remote-" + id.replace(/[^a-z0-9]/gi, "").slice(0, 24);

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={"w-[2.4vh] h-[2.4vh] shrink-0 opacity-60 transition-transform " + (open ? "rotate-90" : "")}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-[2.2vh] h-[2.2vh] shrink-0 text-accent"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

const POWER_OPTS: RemotePower[] = ["tv", "tv_and_box", "ignore"];

export function RemoteRemap() {
  const { t, loc } = useI18n();
  const config = useConfigStore((s) => s.config);
  const setRemote = useConfigStore((s) => s.setRemote);
  const setRemotePower = useConfigStore((s) => s.setRemotePower);
  const saved = config?.remote?.devices || {};
  const power: RemotePower = config?.remote?.power || "tv";

  // null = first poll still in flight (renders nothing), [] = really no remotes -
  // so the "none connected" copy can't flash before the list arrives
  const [devices, setDevices] = useState<ConnectedRemote[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [learning, setLearning] = useState<{ id: string; action: RemoteAction } | null>(null);
  const learningRef = useRef(learning);
  learningRef.current = learning;
  // Button test: device id under test + the keys captured so far. Shares the
  // bridge's single learn slot with the remap flow, so the two are mutually
  // exclusive (each entry point checks the other's state).
  const [testing, setTesting] = useState<string | null>(null);
  const testingRef = useRef(testing);
  testingRef.current = testing;
  const [testKeys, setTestKeys] = useState<{ name: string; code: number; ts: number }[]>([]);
  // MACs of connected remotes that are programmable Fire TV / Alexa remotes
  // (expose the keymap GATT service). Only these show the "TV IR" sub-panel, so
  // a non-Fire-TV remote's remap menu stays clean. `irOpen` = which device's
  // IR panel is expanded (lazy: the heavy flow mounts only when opened).
  const [ftirMacs, setFtirMacs] = useState<string[]>([]);
  const [irOpen, setIrOpen] = useState<string | null>(null);
  useEffect(() => {
    fetchProgrammableRemotes().then(setFtirMacs);
  }, []);
  // Installed, ready apps become dynamic "app:<id>" launch actions (a remote's
  // dedicated app button -> any tile). Loaded once; installs are rare here.
  const [apps, setApps] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetchApps().then((list) =>
      setApps(list.filter((a) => a.status === "ready").map((a) => ({ id: a.id, name: loc(a.name) }))),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const allActions: RemoteAction[] = [...REMOTE_ACTIONS, ...apps.map((a) => `app:${a.id}` as RemoteAction)];
  const actionLabel = (a: RemoteAction): string =>
    a.startsWith("app:")
      ? t("remote.action.app", { name: apps.find((x) => "app:" + x.id === a)?.name || a.slice(4) })
      : t("remote.action." + a);

  // Poll connected remotes (hotplug + the shell merges in the saved keymap).
  // Pause polling while learning/testing so the list doesn't churn mid-capture.
  useEffect(() => {
    let alive = true;
    const tick = () => fetchRemoteDevices().then((d) => alive && setDevices(d));
    tick();
    const iv = setInterval(() => !learningRef.current && !testingRef.current && tick(), 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  // Learn: tell the bridge to capture the next button on this device, poll for it.
  useEffect(() => {
    if (!learning) return;
    const { id, action } = learning;
    let done = false;
    void learnRemote(id);
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(to);
      void learnRemoteOff();
      setLearning(null);
      setTimeout(() => setFocus(keyBase(id) + "-" + action), 0);
    };
    const poll = setInterval(async () => {
      const lb = await fetchLearned();
      if (!done && lb && lb.id === id) {
        await save(id, action, lb.code);
        finish();
      }
    }, 400);
    const to = setTimeout(finish, 8000); // no button -> auto-cancel (no keyboard on a remote)
    return () => {
      done = true;
      clearInterval(poll);
      clearTimeout(to);
      void learnRemoteOff();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learning]);

  // Button test: keep re-arming learn on the device and show every captured
  // key. The tested remote is swallowed while armed, so the primary exit is an
  // idle timeout (the Stop button needs another remote/keyboard to reach).
  useEffect(() => {
    if (!testing) return;
    const id = testing;
    let seen = "";
    let idleTimer = setTimeout(() => setTesting(null), 12000);
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setTesting(null), 12000);
    };
    setTestKeys([]);
    void learnRemote(id);
    const poll = setInterval(async () => {
      const lb = await fetchLearned();
      if (!lb || lb.id !== id) return;
      const key = lb.ts + ":" + lb.code;
      if (key === seen) return; // still the previous capture
      seen = key;
      setTestKeys((ks) => [...ks, { name: lb.name, code: lb.code, ts: lb.ts }].slice(-10));
      armIdle();
      void learnRemote(id); // re-arm for the next press
    }, 250);
    return () => {
      clearInterval(poll);
      clearTimeout(idleTimer);
      void learnRemoteOff();
      setTimeout(() => setFocus(keyBase(id) + "-test"), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testing]);

  const cloneSaved = (): Record<string, RemoteDeviceConfig> => {
    const out: Record<string, RemoteDeviceConfig> = {};
    for (const [k, v] of Object.entries(saved)) out[k] = { name: v.name, keymap: { ...v.keymap } };
    return out;
  };
  const save = async (id: string, action: RemoteAction, code: number) => {
    const name = (devices ?? []).find((d) => d.id === id)?.name || saved[id]?.name || id;
    const next = cloneSaved();
    const dev = next[id] || (next[id] = { name, keymap: {} });
    dev.name = name;
    dev.keymap = { ...dev.keymap, [action]: [code] };
    await setRemote(next);
  };
  const clearAction = async (id: string, action: RemoteAction) => {
    const next = cloneSaved();
    if (next[id]) {
      delete next[id].keymap[action];
      if (!Object.keys(next[id].keymap).length) delete next[id];
    }
    await setRemote(next);
    setTimeout(() => setFocus(keyBase(id) + "-" + action), 0);
  };
  const toggle = (id: string) => {
    if (learning) return;
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next) setTimeout(() => setFocus(keyBase(id) + "-" + REMOTE_ACTIONS[0]), 0);
  };

  return (
    <div className="mt-[4vh]">
      <div className="text-[2.4vh] font-semibold mb-[0.6vh]">{t("remote.title")}</div>
      <div className="text-[1.8vh] text-fg-dim mb-[1.4vh] max-w-[64vw]">{t("remote.hint")}</div>
      {devices !== null && !devices.length && <div className="text-[1.9vh] text-fg-dim">{t("remote.none")}</div>}
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {(devices ?? []).map((d) => {
          const km = d.keymap || {};
          const custom = Object.keys(km).length;
          const open = expanded === d.id;
          return (
            <div key={d.id}>
              <FocusButton
                focusKey={keyBase(d.id) + "-dev"}
                onEnter={() => toggle(d.id)}
                className="px-[2vw] py-[1.6vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
              >
                <span className="text-[2.1vh] flex-1 text-left truncate">{d.name}</span>
                {custom > 0 && (
                  <span className="text-[1.7vh] text-accent shrink-0">{t("remote.customCount", { n: custom })}</span>
                )}
                <Chevron open={open} />
              </FocusButton>
              {open && testing === d.id && (
                <div className="mt-[0.8vh] mb-[1.4vh] pl-[2vw]">
                  <div className="text-[1.8vh] text-fg-dim mb-[1vh] max-w-[60vw]">{t("remote.testHint")}</div>
                  <div className="flex flex-wrap gap-[0.8vh] mb-[1.2vh] max-w-[60vw]">
                    {testKeys.length === 0 && <span className="text-[1.9vh] text-fg-dim">{t("remote.testNone")}</span>}
                    {testKeys.map((k, i) => (
                      <span
                        key={k.ts + "-" + k.code + "-" + i}
                        className="px-[1.2vw] py-[0.7vh] rounded-[1vh] bg-white/10 text-[1.8vh] tabular-nums"
                      >
                        {k.name} ({k.code})
                      </span>
                    ))}
                  </div>
                  <FocusButton
                    focusKey={keyBase(d.id) + "-teststop"}
                    onEnter={() => setTesting(null)}
                    className="px-[1.6vw] py-[1.2vh] rounded-[1.1vh] bg-white/5 text-[1.8vh] font-semibold inline-flex"
                  >
                    {t("remote.testStop")}
                  </FocusButton>
                </div>
              )}
              {open && testing !== d.id && (
                <div className="flex flex-col gap-[0.8vh] mt-[0.8vh] mb-[1.4vh] pl-[2vw]">
                  <FocusButton
                    focusKey={keyBase(d.id) + "-test"}
                    onEnter={() => !learning && !testing && setTesting(d.id)}
                    className="px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
                  >
                    <span className="text-[2vh] flex-1 text-left truncate">{t("remote.test")}</span>
                    <span className="text-[1.7vh] text-fg-dim shrink-0">{t("remote.testBadge")}</span>
                  </FocusButton>
                  {allActions.map((a) => {
                    const bound = (km[a] || []).length > 0;
                    const isLearning = learning?.id === d.id && learning?.action === a;
                    return (
                      <div key={a} className="flex items-center gap-[1vw]">
                        <FocusButton
                          focusKey={keyBase(d.id) + "-" + a}
                          onEnter={() => !learning && !testing && setLearning({ id: d.id, action: a })}
                          className="flex-1 px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
                        >
                          <span className="text-[2vh] flex-1 text-left truncate">{actionLabel(a)}</span>
                          {isLearning ? (
                            <span className="text-[1.8vh] text-accent shrink-0">{t("remote.press")}</span>
                          ) : bound ? (
                            <span className="text-[1.7vh] text-accent shrink-0">{t("remote.custom")}</span>
                          ) : (
                            <span className="text-[1.7vh] text-fg-dim shrink-0">{t("remote.default")}</span>
                          )}
                        </FocusButton>
                        {bound && !isLearning && (
                          <FocusButton
                            focusKey={keyBase(d.id) + "-clear-" + a}
                            onEnter={() => clearAction(d.id, a)}
                            className="px-[1.4vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 text-[1.7vh] font-semibold shrink-0"
                          >
                            {t("remote.clear")}
                          </FocusButton>
                        )}
                      </div>
                    );
                  })}

                  {/* Fire TV / Alexa remote: teach its OWN IR blaster the TV's
                      volume/mute/power. Shown ONLY for remotes that expose the
                      keymap service, so other remotes don't see it. */}
                  {ftirMacs.includes(d.id.toLowerCase()) && (
                    <div className="mt-[0.6vh]">
                      <FocusButton
                        focusKey={keyBase(d.id) + "-firetvir"}
                        onEnter={() => setIrOpen(irOpen === d.id ? null : d.id)}
                        className="px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
                      >
                        <span className="text-[2vh] flex-1 text-left truncate">{t("firetvir.entry")}</span>
                        <Chevron open={irOpen === d.id} />
                      </FocusButton>
                      {irOpen === d.id && (
                        <div className="pl-[1.5vw]">
                          <FiretvIrSettings device={{ id: d.id, name: d.name }} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Power button policy (global, not per-device). The bridge always
          intercepts KEY_POWER so it can never power off the box unintentionally. */}
      <div className="mt-[3.5vh]">
        <div className="text-[2.1vh] font-semibold mb-[0.8vh]">{t("remote.powerTitle")}</div>
        <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
          {POWER_OPTS.map((v) => (
            <FocusButton
              key={v}
              focusKey={"remote-power-" + v}
              onEnter={() => setRemotePower(v)}
              className="px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
            >
              <span className="text-[2vh] flex-1 text-left truncate">{t("remote.power." + v)}</span>
              {power === v && <Check />}
            </FocusButton>
          ))}
        </div>
        {power === "tv_and_box" && (
          <div className="text-[1.7vh] text-warn mt-[0.9vh] max-w-[64vw]">{t("remote.powerWarn")}</div>
        )}
      </div>
    </div>
  );
}
