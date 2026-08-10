import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { RemoteAction, RemoteDeviceConfig } from "@sdk/config";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { useEntryAnim } from "../lib/useEntryAnim";
import { useConfigStore } from "../stores/config";
import { REMOTE_ACTIONS, fetchLearned, learnRemote, learnRemoteOff, resetRemote } from "../lib/remote";
import { fetchApps } from "../lib/api";
import { FocusButton } from "./FocusButton";
import { SettingsPage } from "../settings/SettingsPage";
import { useSettingsNav } from "../settings/nav";

// ONE remote's buttons: the learn flow, the button test, and the reset.
//
// It is its own page rather than part of the remote's row because of its length -
// every navigation action plus one row per installed app is around twenty-five
// rows, and on a screen driven by a D-pad that buried everything else the remote
// offers (ringing it, its IR blaster) below a long scroll.
//
// The three things that make the flow work are unchanged and worth knowing: the
// bridge SWALLOWS every press on the remote being taught (so the modals are
// cancelled with a different remote or Back, and the learn auto-cancels after 10 s),
// a code already bound elsewhere asks before it is stolen, and the panic gesture -
// the same button eight times fast - is documented on this page because it is the
// way out when a mapping has made the remote unusable.
export const keyBase = (id: string) => "remote-" + id.replace(/[^a-z0-9]/gi, "").slice(0, 24);

// While a modal is up, swallow auto-repeated Enter/Space keydowns (capture phase,
// before spatial-nav sees them): the OK press that OPENED the modal is still
// physically held for a moment, and Chromium synthesizes repeats for held keys -
// without this a slightly long press would immediately "press" the modal's default
// button. Arrows repeat as usual.
export function useSwallowEnterRepeats() {
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

// Learn mode as a real MODAL: the page behind stays mounted (no reflow, the focused
// row survives) and the focus boundary keeps D-pad focus inside, so a press from
// another remote can never wander onto a row behind it mid-learn. Cancel needs that
// OTHER remote (or Back) - every press on the remote being taught is captured by
// the bridge - and the parent's 10s timeout stays as the single-remote fallback.
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

// A yes/no the user cannot lose focus-wise, for the two presses here that cannot be
// undone by pressing the same thing again: reassigning a button that is already
// bound, and resetting the whole keymap.
//
// Three things are deliberate and were each learned from a real press. It is a
// FOCUS BOUNDARY, so a press from another remote mid-learn cannot wander onto a row
// behind it. It defaults to CANCEL, because the press that opened it may still be
// arriving (a taught remote sends its own stray events, and a held OK repeats). And
// `destructive` colours the confirm as a warning rather than as the accent, so the
// bright, safe-looking button is never the one that throws work away.
function ConfirmOverlay({
  title,
  body,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "remote-confirm-overlay", isFocusBoundary: true });
  const entryAnim = useEntryAnim();
  useEffect(() => {
    setTimeout(() => setFocus("remote-confirm-no"), 0);
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
        <div className="text-[2.8vh] font-bold">{title}</div>
        <div className="text-[2.1vh] text-fg-dim max-w-[56vw]">{body}</div>
        <div className="flex gap-[1vw] mt-[1.2vh]">
          <FocusButton
            focusKey="remote-confirm-yes"
            onEnter={onConfirm}
            className={
              "px-[2.4vw] py-[1.4vh] rounded-[1.1vh] text-[#06090d] text-[2vh] font-semibold " +
              (destructive ? "bg-warn" : "bg-accent")
            }
          >
            {confirmLabel}
          </FocusButton>
          <FocusButton
            focusKey="remote-confirm-no"
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

export function RemoteKeymapPage({ device }: { device: { id: string; name: string } }) {
  const { t, loc } = useI18n();
  const nav = useSettingsNav();
  const config = useConfigStore((s) => s.config);
  const setRemote = useConfigStore((s) => s.setRemote);
  const load = useConfigStore((s) => s.load);
  const saved = config?.remote?.devices || {};
  const id = device.id;
  // The keymap comes from the config store, NOT from the polled device list: a
  // save or a clear updates the store instantly.
  const km = saved[id]?.keymap || {};

  const [learning, setLearning] = useState<RemoteAction | null>(null);
  const [testing, setTesting] = useState(false);
  const [testKeys, setTestKeys] = useState<{ name: string; code: number; ts: number }[]>([]);
  const [conflict, setConflict] = useState<{ action: RemoteAction; code: number; from: RemoteAction } | null>(null);
  const [resetting, setResetting] = useState(false);

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

  const cloneSaved = (): Record<string, RemoteDeviceConfig> => {
    const out: Record<string, RemoteDeviceConfig> = {};
    // spread keeps the non-keymap fields (irPassthrough) - a save/clear on any
    // remote must not strip another remote's flags
    for (const [k, v] of Object.entries(saved)) out[k] = { ...v, keymap: { ...v.keymap } };
    return out;
  };
  // Which OTHER action on this device this code is already bound to (or null).
  const conflictOf = (action: RemoteAction, code: number): RemoteAction | null => {
    for (const [a, codes] of Object.entries(km)) {
      if (a !== action && Array.isArray(codes) && codes.includes(code)) return a as RemoteAction;
    }
    return null;
  };
  const save = async (action: RemoteAction, code: number) => {
    const name = device.name || saved[id]?.name || id;
    const next = cloneSaved();
    const dev = next[id] || (next[id] = { name, keymap: {} });
    dev.name = name;
    // Clean reassign: a physical button drives ONE action, so drop this code from
    // any other action before binding it here (else the bridge sees the code mapped
    // twice and picks arbitrarily).
    const map: Record<string, number[]> = {};
    for (const [a, codes] of Object.entries(dev.keymap)) {
      const kept = (codes || []).filter((c) => c !== code);
      if (kept.length) map[a] = kept;
    }
    map[action] = [code];
    dev.keymap = map;
    await setRemote(next);
  };
  const clearAction = async (action: RemoteAction) => {
    const next = cloneSaved();
    if (next[id]) {
      delete next[id].keymap[action];
      // drop the emptied entry only if it carries nothing else (irPassthrough)
      if (!Object.keys(next[id].keymap).length && !next[id].irPassthrough) delete next[id];
    }
    await setRemote(next);
    setTimeout(() => setFocus(keyBase(id) + "-" + action), 0);
  };
  const resetDevice = async () => {
    // through the shell endpoint, which keeps irPassthrough (a client-side delete of
    // the entry would drop it and double every volume step on a programmed Fire TV
    // remote); reload the store to pick up the result
    await resetRemote(id);
    await load();
    setTimeout(() => setFocus(keyBase(id) + "-" + REMOTE_ACTIONS[0]), 0);
  };

  // Learn: tell the bridge to capture the next button on this device, poll for it.
  useEffect(() => {
    if (!learning) return;
    const action = learning;
    let done = false;
    // Only accept a capture at least this fresh - a leftover remote-learned.json from
    // a prior session must never be misread as this press (the bridge ts is
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
        const from = conflictOf(action, lb.code);
        if (from) {
          // already bound elsewhere - confirm before stealing it
          done = true;
          clearInterval(poll);
          clearTimeout(to);
          void learnRemoteOff();
          setLearning(null);
          setConflict({ action, code: lb.code, from });
        } else {
          await save(action, lb.code);
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

  // Button test: keep re-arming learn on the device and show every captured key. The
  // tested remote is swallowed while armed, so the primary exit is an idle timeout
  // (the Stop button needs another remote/keyboard to reach).
  useEffect(() => {
    if (!testing) return;
    let seen = "";
    let idleTimer = setTimeout(() => setTesting(false), 12000);
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setTesting(false), 12000);
    };
    setTestKeys([]);
    void learnRemote(id);
    const poll = setInterval(async () => {
      const lb = await fetchLearned();
      if (!lb) {
        // the re-arm deleted the learned file: reset the dedupe, so the next capture
        // registers even when it repeats the same whole-second ts and code (a
        // double-tap of one button inside one second)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testing]);

  // Belt-and-braces: auto-dismiss the reassign dialog after 20s (with focus
  // restored) so a lost dialog can never trap the screen.
  useEffect(() => {
    if (!conflict) return;
    const c = conflict;
    const to = setTimeout(() => {
      setConflict(null);
      setTimeout(() => setFocus(keyBase(id) + "-" + c.action), 0);
    }, 20000);
    return () => clearTimeout(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflict]);

  // Back must not leave mid-learn: the bridge is still swallowing this remote's
  // presses, so the modal is what has to close first.
  const learningRef = useRef<RemoteAction | null>(null);
  learningRef.current = learning;
  const back = () => {
    if (learningRef.current || testing) return;
    nav.pop();
  };

  const cancelLearn = () => {
    if (!learning) return;
    const action = learning;
    setLearning(null);
    setTimeout(() => setFocus(keyBase(id) + "-" + action), 0);
  };
  const closeConflict = () => {
    const c = conflict;
    if (!c) return;
    setConflict(null);
    setTimeout(() => setFocus(keyBase(id) + "-" + c.action), 0);
  };

  return (
    <SettingsPage
      id="remote-keys"
      title={device.name}
      subtitle={t("remote.hint")}
      onBack={back}
      animate="push"
      focusPolicy="legacy"
    >
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {testing ? (
          <div className="mb-[1.4vh]">
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
              focusKey={keyBase(id) + "-teststop"}
              onEnter={() => setTesting(false)}
              className="px-[1.6vw] py-[1.2vh] rounded-[1.1vh] bg-white/5 text-[1.8vh] font-semibold inline-flex"
            >
              {t("remote.testStop")}
            </FocusButton>
          </div>
        ) : (
          <>
            <FocusButton
              focusKey={keyBase(id) + "-test"}
              onEnter={() => !learning && setTesting(true)}
              className="px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
            >
              <span className="text-[2vh] flex-1 text-left truncate">{t("remote.test")}</span>
              <span className="text-[1.7vh] text-fg-dim shrink-0">{t("remote.testBadge")}</span>
            </FocusButton>
            {allActions.map((a) => {
              const bound = (km[a] || []).length > 0;
              // during a learn the row stays mounted under the modal overlay, so
              // focus returns to it when the modal closes
              return (
                <div key={a} className="flex items-center gap-[1vw]">
                  <FocusButton
                    focusKey={keyBase(id) + "-" + a}
                    onEnter={() => !learning && setLearning(a)}
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
                      focusKey={keyBase(id) + "-clear-" + a}
                      onEnter={() => clearAction(a)}
                      className="px-[1.4vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 text-[1.7vh] font-semibold shrink-0"
                    >
                      {t("remote.clear")}
                    </FocusButton>
                  )}
                </div>
              );
            })}

            {/* Reset every remap for this remote - recovery if a mapping makes it
                hard to use. (The TV's own CEC remote is never remapped, so it always
                works as a fallback too.) The hint below is the panic gesture's ONLY
                on-screen documentation: the user must read it while things still
                work, so it lives right where mappings are made. */}
            {Object.keys(km).length > 0 && (
              <>
                <FocusButton
                  focusKey={keyBase(id) + "-reset"}
                  onEnter={() => setResetting(true)}
                  className="px-[2vw] py-[1.2vh] rounded-[1.1vh] bg-white/5 text-[1.8vh] text-warn font-semibold inline-flex mt-[0.4vh]"
                >
                  {t("remote.resetDevice")}
                </FocusButton>
                <div className="text-[1.7vh] text-fg-dim max-w-[60vw]">{t("remote.panicHint")}</div>
              </>
            )}
          </>
        )}
      </div>

      {learning && <LearnOverlay action={actionLabel(learning)} remote={device.name} onCancel={cancelLearn} />}
      {conflict && (
        <ConfirmOverlay
          title={t("remote.reassignTitle")}
          body={t("remote.reassignBody", { from: actionLabel(conflict.from), to: actionLabel(conflict.action) })}
          confirmLabel={t("remote.reassignConfirm")}
          onConfirm={async () => {
            const c = conflict;
            await save(c.action, c.code);
            closeConflict();
          }}
          onCancel={closeConflict}
        />
      )}
      {resetting && (
        <ConfirmOverlay
          title={t("remote.resetTitle")}
          body={t("remote.resetBody", { remote: device.name, n: Object.keys(km).length })}
          confirmLabel={t("remote.resetConfirm")}
          destructive
          onConfirm={() => {
            setResetting(false);
            void resetDevice();
          }}
          onCancel={() => {
            setResetting(false);
            // Back on the row that asked, not at the top of the list.
            setTimeout(() => setFocus(keyBase(id) + "-reset"), 0);
          }}
        />
      )}
    </SettingsPage>
  );
}
