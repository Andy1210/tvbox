import { useEffect, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { RemoteAction, RemoteDeviceConfig } from "@sdk/config";
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
import { FocusButton } from "./FocusButton";

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

export function RemoteRemap() {
  const { t } = useI18n();
  const config = useConfigStore((s) => s.config);
  const setRemote = useConfigStore((s) => s.setRemote);
  const saved = config?.remote?.devices || {};

  const [devices, setDevices] = useState<ConnectedRemote[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [learning, setLearning] = useState<{ id: string; action: RemoteAction } | null>(null);
  const learningRef = useRef(learning);
  learningRef.current = learning;

  // Poll connected remotes (hotplug + the shell merges in the saved keymap).
  // Pause polling while learning so the list doesn't churn mid-capture.
  useEffect(() => {
    let alive = true;
    const tick = () => fetchRemoteDevices().then((d) => alive && setDevices(d));
    tick();
    const iv = setInterval(() => !learningRef.current && tick(), 3000);
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

  const cloneSaved = (): Record<string, RemoteDeviceConfig> => {
    const out: Record<string, RemoteDeviceConfig> = {};
    for (const [k, v] of Object.entries(saved)) out[k] = { name: v.name, keymap: { ...v.keymap } };
    return out;
  };
  const save = async (id: string, action: RemoteAction, code: number) => {
    const name = devices.find((d) => d.id === id)?.name || saved[id]?.name || id;
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
      {!devices.length && <div className="text-[1.9vh] text-fg-dim">{t("remote.none")}</div>}
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {devices.map((d) => {
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
                  <span className="text-[1.7vh] text-[#39c0d6] shrink-0">{t("remote.customCount", { n: custom })}</span>
                )}
                <Chevron open={open} />
              </FocusButton>
              {open && (
                <div className="flex flex-col gap-[0.8vh] mt-[0.8vh] mb-[1.4vh] pl-[2vw]">
                  {REMOTE_ACTIONS.map((a) => {
                    const bound = (km[a] || []).length > 0;
                    const isLearning = learning?.id === d.id && learning?.action === a;
                    return (
                      <div key={a} className="flex items-center gap-[1vw]">
                        <FocusButton
                          focusKey={keyBase(d.id) + "-" + a}
                          onEnter={() => !learning && setLearning({ id: d.id, action: a })}
                          className="flex-1 px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
                        >
                          <span className="text-[2vh] flex-1 text-left truncate">{t("remote.action." + a)}</span>
                          {isLearning ? (
                            <span className="text-[1.8vh] text-[#39c0d6] shrink-0">{t("remote.press")}</span>
                          ) : bound ? (
                            <span className="text-[1.7vh] text-[#39c0d6] shrink-0">{t("remote.custom")}</span>
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
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
