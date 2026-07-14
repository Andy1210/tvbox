import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { RemoteAction, RemoteDeviceConfig, RemotePower } from "@sdk/config";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { useEntryAnim } from "../lib/useEntryAnim";
import { useConfigStore } from "../stores/config";
import {
  REMOTE_ACTIONS,
  fetchRemoteDevices,
  fetchLearned,
  learnRemote,
  learnRemoteOff,
  resetRemote,
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

// While a modal is up, swallow auto-repeated Enter/Space keydowns (capture
// phase, before spatial-nav sees them): the OK press that OPENED the modal is
// still physically held for a moment, and Chromium synthesizes repeats for
// held keys - without this a slightly long press would immediately "press"
// the modal's default (Cancel) button. Arrows repeat as usual.
function useSwallowEnterRepeats() {
  useEffect(() => {
    const block = (ev: KeyboardEvent) => {
      if (ev.repeat && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, []);
}

// Learn mode as a real MODAL: the page behind stays mounted (no reflow, the
// focused row survives) and the focus boundary keeps D-pad focus inside, so a
// press from another remote can never wander onto e.g. the Bluetooth scan row
// mid-learn. Cancel needs that OTHER remote (or Back) - every press on the
// remote being taught is captured by the bridge - and the parent's 10s timeout
// stays as the single-remote fallback.
function LearnOverlay({ action, remote, onCancel }: { action: string; remote: string; onCancel: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "remote-learn-overlay", isFocusBoundary: true });
  const entryAnim = useEntryAnim();
  useEffect(() => {
    setTimeout(() => setFocus("remote-learn-cancel"), 0);
  }, []);
  useSwallowEnterRepeats();
  useBackspace(onCancel);
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        style={entryAnim}
        className="fixed inset-0 z-[55] bg-black/90 flex flex-col items-center justify-center text-center gap-[1.6vh] px-[6vw]"
      >
        <div className="text-[2.8vh] font-bold">{t("remote.learnTitle", { action })}</div>
        <div className="text-[2.1vh] text-fg-dim max-w-[56vw]">{t("remote.learnBody", { remote })}</div>
        <div className="text-[1.8vh] text-warn max-w-[56vw]">{t("remote.learnWarn")}</div>
        <FocusButton
          focusKey="remote-learn-cancel"
          onEnter={onCancel}
          className="px-[2.4vw] py-[1.4vh] rounded-[1.1vh] bg-white/5 text-[2vh] font-semibold mt-[1.2vh]"
        >
          {t("remote.cancel")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}

// Reassign-confirm as the same kind of modal (it interrupts a learn, so it must
// be equally impossible to lose focus-wise).
function ReassignOverlay({
  from,
  to,
  onConfirm,
  onCancel,
}: {
  from: string;
  to: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "remote-reassign-overlay", isFocusBoundary: true });
  const entryAnim = useEntryAnim();
  useEffect(() => {
    // default to CANCEL: right after a capture the taught remote may still
    // send a stray Enter-ish press, and that must not silently confirm
    setTimeout(() => setFocus("remote-reassign-no"), 0);
  }, []);
  useSwallowEnterRepeats();
  useBackspace(onCancel);
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        style={entryAnim}
        className="fixed inset-0 z-[55] bg-black/90 flex flex-col items-center justify-center text-center gap-[1.6vh] px-[6vw]"
      >
        <div className="text-[2.8vh] font-bold">{t("remote.reassignTitle")}</div>
        <div className="text-[2.1vh] text-fg-dim max-w-[56vw]">{t("remote.reassignBody", { from, to })}</div>
        <div className="flex gap-[1vw] mt-[1.2vh]">
          <FocusButton
            focusKey="remote-reassign-yes"
            onEnter={onConfirm}
            className="px-[2.4vw] py-[1.4vh] rounded-[1.1vh] bg-accent text-[#06090d] text-[2vh] font-semibold"
          >
            {t("remote.reassignConfirm")}
          </FocusButton>
          <FocusButton
            focusKey="remote-reassign-no"
            onEnter={onCancel}
            className="px-[2.4vw] py-[1.4vh] rounded-[1.1vh] bg-white/5 text-[2vh] font-semibold"
          >
            {t("remote.cancel")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

export function RemoteRemap() {
  const { t, loc } = useI18n();
  const config = useConfigStore((s) => s.config);
  const setRemote = useConfigStore((s) => s.setRemote);
  const setRemotePower = useConfigStore((s) => s.setRemotePower);
  const load = useConfigStore((s) => s.load);
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
  // A learned button that's already bound to another action -> confirm reassign.
  const [conflict, setConflict] = useState<{
    id: string;
    action: RemoteAction;
    code: number;
    from: RemoteAction;
  } | null>(null);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
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

  // Poll connected remotes (hotplug; only presence + names are used from it,
  // the rendered keymap comes from the config store which updates instantly).
  // Pause polling while learning/testing/confirming so the row a modal will
  // restore focus to can't unmount under it (BT sleep mid-dialog).
  useEffect(() => {
    let alive = true;
    const tick = () => fetchRemoteDevices().then((d) => alive && setDevices(d));
    tick();
    const iv = setInterval(() => !learningRef.current && !testingRef.current && !conflictRef.current && tick(), 3000);
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
    // Only accept a capture at least this fresh - a leftover remote-learned.json
    // from a prior session must never be misread as this press (the bridge ts is
    // whole-second int(time.time()), so floor now to the same unit).
    const armedAt = Math.floor(Date.now() / 1000);
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
      if (!done && lb && lb.id === id && lb.ts >= armedAt) {
        const from = conflictOf(id, action, lb.code);
        if (from) {
          // already bound elsewhere - confirm before stealing it
          done = true;
          clearInterval(poll);
          clearTimeout(to);
          void learnRemoteOff();
          setLearning(null);
          setConflict({ id, action, code: lb.code, from });
        } else {
          await save(id, action, lb.code);
          finish();
        }
      }
    }, 250);
    const to = setTimeout(finish, 10000); // no button -> auto-cancel (no keyboard on a remote)
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
      if (!lb) {
        // the re-arm deleted the learned file: reset the dedupe, so the next
        // capture registers even when it repeats the same whole-second ts and
        // code (a double-tap of one button inside one second)
        seen = "";
        return;
      }
      if (lb.id !== id) return;
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
  }, [testing]);

  // Belt-and-braces: auto-dismiss the reassign dialog after 20s (with focus
  // restored) so a lost dialog can never trap the screen.
  useEffect(() => {
    if (!conflict) return;
    const c = conflict;
    const to = setTimeout(() => {
      setConflict(null);
      setTimeout(() => setFocus(keyBase(c.id) + "-" + c.action), 0);
    }, 20000);
    return () => clearTimeout(to);
  }, [conflict]);

  // Cancel a learn from the modal (Back or the Cancel button - pressed with a
  // DIFFERENT remote; the learned one is swallowed by the bridge). The learn
  // effect's cleanup sends learn-off to the bridge.
  const cancelLearn = () => {
    if (!learning) return;
    const { id, action } = learning;
    setLearning(null);
    setTimeout(() => setFocus(keyBase(id) + "-" + action), 0);
  };

  const cloneSaved = (): Record<string, RemoteDeviceConfig> => {
    const out: Record<string, RemoteDeviceConfig> = {};
    // spread keeps the non-keymap fields (irPassthrough) - a save/clear on any
    // remote must not strip another remote's flags
    for (const [k, v] of Object.entries(saved)) out[k] = { ...v, keymap: { ...v.keymap } };
    return out;
  };
  // Which OTHER action on this device this code is already bound to (or null).
  const conflictOf = (id: string, action: RemoteAction, code: number): RemoteAction | null => {
    const km = saved[id]?.keymap || {};
    for (const [a, codes] of Object.entries(km)) {
      if (a !== action && Array.isArray(codes) && codes.includes(code)) return a as RemoteAction;
    }
    return null;
  };
  const save = async (id: string, action: RemoteAction, code: number) => {
    const name = (devices ?? []).find((d) => d.id === id)?.name || saved[id]?.name || id;
    const next = cloneSaved();
    const dev = next[id] || (next[id] = { name, keymap: {} });
    dev.name = name;
    // Clean reassign: a physical button drives ONE action, so drop this code
    // from any other action before binding it here (else the bridge sees the
    // code mapped twice and picks arbitrarily).
    const km: Record<string, number[]> = {};
    for (const [a, codes] of Object.entries(dev.keymap)) {
      const kept = (codes || []).filter((c) => c !== code);
      if (kept.length) km[a] = kept;
    }
    km[action] = [code];
    dev.keymap = km;
    await setRemote(next);
  };
  const resetDevice = async (id: string) => {
    // through the shell endpoint, which keeps irPassthrough (a client-side
    // delete of the entry would drop it and double every volume step on a
    // programmed Fire TV remote); reload the store to pick up the result
    await resetRemote(id);
    await load();
    setTimeout(() => setFocus(keyBase(id) + "-dev"), 0);
  };
  const clearAction = async (id: string, action: RemoteAction) => {
    const next = cloneSaved();
    if (next[id]) {
      delete next[id].keymap[action];
      // drop the emptied entry only if it carries nothing else (irPassthrough)
      if (!Object.keys(next[id].keymap).length && !next[id].irPassthrough) delete next[id];
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

  const learnRemoteName = learning
    ? (devices ?? []).find((d) => d.id === learning.id)?.name || saved[learning.id]?.name || learning.id
    : "";
  const closeConflict = () => {
    const c = conflict;
    if (!c) return;
    setConflict(null);
    setTimeout(() => setFocus(keyBase(c.id) + "-" + c.action), 0);
  };

  return (
    <div className="mt-[4vh]">
      <div className="text-[2.4vh] font-semibold mb-[0.6vh]">{t("remote.title")}</div>
      <div className="text-[1.8vh] text-fg-dim mb-[1.4vh] max-w-[64vw]">{t("remote.hint")}</div>
      {devices !== null && !devices.length && <div className="text-[1.9vh] text-fg-dim">{t("remote.none")}</div>}
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {(devices ?? []).map((d) => {
          // keymap comes from the config store, NOT the polled device list: a
          // save/clear updates the store instantly, while the poll (paused
          // during learn, 3s otherwise) would show the change 1-3s late
          const km = saved[d.id]?.keymap || {};
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
                    // during a learn the row stays mounted under the modal
                    // overlay, so focus returns to it when the modal closes
                    return (
                      <div key={a} className="flex items-center gap-[1vw]">
                        <FocusButton
                          focusKey={keyBase(d.id) + "-" + a}
                          onEnter={() => !learning && !testing && setLearning({ id: d.id, action: a })}
                          className="flex-1 px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
                        >
                          <span className="text-[2vh] flex-1 text-left truncate">{actionLabel(a)}</span>
                          {bound ? (
                            <span className="text-[1.7vh] text-accent shrink-0">{t("remote.custom")}</span>
                          ) : (
                            <span className="text-[1.7vh] text-fg-dim shrink-0">{t("remote.default")}</span>
                          )}
                        </FocusButton>
                        {bound && (
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

                  {/* Reset every remap for this remote - recovery if a mapping
                      makes it hard to use. (The TV's own CEC remote is never
                      remapped, so it always works as a fallback too.) */}
                  {Object.keys(km).length > 0 && (
                    <FocusButton
                      focusKey={keyBase(d.id) + "-reset"}
                      onEnter={() => resetDevice(d.id)}
                      className="px-[2vw] py-[1.2vh] rounded-[1.1vh] bg-white/5 text-[1.8vh] text-warn font-semibold inline-flex mt-[0.4vh]"
                    >
                      {t("remote.resetDevice")}
                    </FocusButton>
                  )}

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

      {learning && (
        <LearnOverlay action={actionLabel(learning.action)} remote={learnRemoteName} onCancel={cancelLearn} />
      )}
      {conflict && (
        <ReassignOverlay
          from={actionLabel(conflict.from)}
          to={actionLabel(conflict.action)}
          onConfirm={async () => {
            const c = conflict;
            await save(c.id, c.action, c.code);
            closeConflict();
          }}
          onCancel={closeConflict}
        />
      )}
    </div>
  );
}
