import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { useEntryAnim } from "../lib/useEntryAnim";
import { power, sleepTimer, type PowerAction } from "../lib/power";
import { FocusButton } from "./FocusButton";

// Power menu overlay (from Home): Sleep (display off via CEC, box stays on),
// Restart, Shut down. Restart/Shut down confirm first (recovering a powered-off
// box needs physical access). Back closes / cancels.
export function PowerMenu({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "power", isFocusBoundary: true });
  const entryAnim = useEntryAnim();
  const [confirm, setConfirm] = useState<PowerAction | null>(null);
  // sleep timer: cycles Off -> 30 -> 60 -> 90 min; the shell owns the countdown
  const TIMER_STEPS = [0, 30, 60, 90];
  const [timerAt, setTimerAt] = useState<number | null>(null);
  useEffect(() => {
    sleepTimer().then(setTimerAt);
  }, []);
  const timerLeftMin = timerAt ? Math.max(1, Math.round((timerAt - Date.now()) / 60000)) : 0;
  const cycleTimer = async () => {
    // pick the next step above what's currently left (or off after the top)
    const next = TIMER_STEPS.find((m) => m > timerLeftMin) ?? 0;
    setTimerAt(await sleepTimer(next));
  };

  useEffect(() => {
    setFocus(confirm ? "power-yes" : "power-sleep");
  }, [confirm]);
  useBackspace(() => (confirm ? setConfirm(null) : onClose()));

  const item = "w-full px-[3vw] py-[2vh] rounded-[1.2vh] bg-white/5 text-[2.4vh] font-semibold text-left flex flex-col";

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        style={entryAnim}
        className="fixed inset-0 z-[65] bg-black/85 flex flex-col items-center justify-center gap-[1.4vh] px-[4vw]"
      >
        <div className="text-[2.6vh] font-bold text-fg-dim mb-[1vh]">{t("power.title")}</div>
        <div className="w-[29.2vw] flex flex-col gap-[1.2vh]">
          {/* key= mirrors focusKey: useFocusable registers its key mount-only, so a
              FocusButton instance reused across the confirm flip keeps the stale key
              and the whole overlay goes focus-dead. Keys force a remount. */}
          {confirm ? (
            <>
              <div className="text-[2.6vh] font-semibold text-center mb-[1vh]">
                {t(confirm === "reboot" ? "power.confirmRestart" : "power.confirmShutdown")}
              </div>
              <FocusButton
                key="power-yes"
                focusKey="power-yes"
                onEnter={() => {
                  power(confirm);
                  onClose();
                }}
                className={item + " items-center bg-[#b3261e]/30"}
              >
                {t("power.yes")}
              </FocusButton>
              <FocusButton
                key="power-cancel"
                focusKey="power-cancel"
                onEnter={() => setConfirm(null)}
                className={item + " items-center"}
              >
                {t("power.cancel")}
              </FocusButton>
            </>
          ) : (
            <>
              <FocusButton
                key="power-sleep"
                focusKey="power-sleep"
                onEnter={() => {
                  power("sleep");
                  onClose();
                }}
                className={item}
              >
                <span>{t("power.sleep")}</span>
                <span className="text-[1.7vh] font-normal text-fg-dim">{t("power.sleepHint")}</span>
              </FocusButton>
              <FocusButton key="power-timer" focusKey="power-timer" onEnter={cycleTimer} className={item}>
                <span className="flex items-center justify-between w-full">
                  <span>{t("power.sleepTimer")}</span>
                  <span className={["text-[2vh]", timerAt ? "text-accent" : "text-fg-dim"].join(" ")}>
                    {timerAt ? t("power.sleepTimerIn", { min: String(timerLeftMin) }) : t("display.off")}
                  </span>
                </span>
                <span className="text-[1.7vh] font-normal text-fg-dim">{t("power.sleepTimerHint")}</span>
              </FocusButton>
              <FocusButton
                key="power-restart"
                focusKey="power-restart"
                onEnter={() => setConfirm("reboot")}
                className={item}
              >
                <span>{t("power.restart")}</span>
              </FocusButton>
              <FocusButton
                key="power-shutdown"
                focusKey="power-shutdown"
                onEnter={() => setConfirm("poweroff")}
                className={item}
              >
                <span>{t("power.shutdown")}</span>
                <span className="text-[1.7vh] font-normal text-fg-dim">{t("power.shutdownHint")}</span>
              </FocusButton>
              <FocusButton
                key="power-close"
                focusKey="power-close"
                onEnter={onClose}
                className={item + " items-center"}
              >
                {t("power.cancel")}
              </FocusButton>
            </>
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}
