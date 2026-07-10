import { useEffect, useMemo, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import {
  fetchDisplayModes,
  applyDisplayMode,
  setMatchFramerate,
  type DisplayInfo,
  type DisplayMode,
} from "../lib/display";
import { FocusButton } from "./FocusButton";

const label = (m: DisplayMode) => `${m.width} × ${m.height} · ${m.refresh} Hz`;

// Full-screen resolution picker. Its own FocusContext with isFocusBoundary so
// arrow keys stay inside (can't wander onto the Settings sections behind it), and
// Back closes it. Mounted only while open, so it adds no stray focusable when closed.
function DisplayModePicker({
  modes,
  applying,
  msg,
  onApply,
  onClose,
}: {
  modes: DisplayMode[];
  applying: string | null;
  msg: string;
  onApply: (key: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "disp-picker", isFocusBoundary: true });
  const current = modes.find((m) => m.current) || null;
  useEffect(() => {
    setTimeout(() => setFocus(current ? "disp-mode-" + current.key : "disp-close"), 0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useBackspace(onClose);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-[55] bg-black/90 flex flex-col items-center justify-center gap-[1.6vh] px-[6vw]"
      >
        <div className="flex items-center gap-[1.5vw]">
          <div className="text-[2.8vh] font-bold">{t("display.choose")}</div>
          {applying ? (
            <span className="text-[1.9vh] text-[#39c0d6]">{t("display.applying")}</span>
          ) : msg ? (
            <span className="text-[1.9vh] text-fg-dim">{msg}</span>
          ) : null}
        </div>
        <div className="flex flex-col gap-[0.8vh] w-[60vw] max-w-[620px] max-h-[68vh] overflow-y-auto no-scrollbar">
          {modes.map((m) => (
            <FocusButton
              key={m.key}
              focusKey={"disp-mode-" + m.key}
              onEnter={() => onApply(m.key)}
              className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
            >
              <span className="text-[2.1vh] tabular-nums">{label(m)}</span>
              {m.current && (
                <span className="flex items-center gap-[0.6vw] text-[1.7vh] text-[#39c0d6] shrink-0">
                  <span className="w-[1.2vh] h-[1.2vh] rounded-full bg-[#39c0d6] shrink-0" />
                  {t("display.active")}
                </span>
              )}
            </FocusButton>
          ))}
          {!modes.length && <div className="text-[1.9vh] text-fg-dim">{t("display.none")}</div>}
          {/* Cancel is the last item IN the scroll list so Down from the bottom mode reaches it */}
          <FocusButton
            focusKey="disp-close"
            onEnter={onClose}
            className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/10 text-[2.1vh] font-semibold text-center"
          >
            {t("power.cancel")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

// Display section: compact inline (current resolution → picker overlay + the
// match-framerate toggle), so the long mode list doesn't push sections below it
// down the scroll. Renders inside the parent Settings FocusContext.
export function DisplaySettings() {
  const { t } = useI18n();
  const [info, setInfo] = useState<DisplayInfo | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [fps, setFps] = useState(false);
  const [msg, setMsg] = useState("");
  const [picking, setPicking] = useState(false);

  const refresh = () => {
    fetchDisplayModes().then((d) => {
      if (d) {
        setInfo(d);
        setFps(d.matchFramerate);
      }
    });
  };
  useEffect(() => {
    refresh();
  }, []);

  const modes = useMemo(() => {
    const list = info?.modes ? [...info.modes] : [];
    list.sort((a, b) => b.width * b.height - a.width * a.height || b.refresh - a.refresh);
    return list;
  }, [info]);
  const current = modes.find((m) => m.current) || null;

  const close = () => {
    setPicking(false);
    setMsg("");
    setTimeout(() => setFocus("disp-open"), 0);
  };
  const onApply = async (key: string) => {
    if (applying) return;
    setApplying(key);
    setMsg("");
    const r = await applyDisplayMode(key);
    setApplying(null);
    if (r.ok) {
      refresh();
      close();
    } else {
      setMsg(t("display.failed"));
      setTimeout(() => setFocus("disp-mode-" + key), 0);
    }
  };
  const toggleFps = async () => {
    const next = !fps;
    setFps(next);
    await setMatchFramerate(next);
  };

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">{t("display.title")}</div>
      <div className="flex flex-col gap-[1vh] max-w-[70vw]">
        <FocusButton
          focusKey="disp-open"
          onEnter={() => setPicking(true)}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="text-[2.1vh]">{t("display.resolution")}</span>
          <span className="text-[1.9vh] text-fg-dim tabular-nums">{current ? label(current) : "-"}</span>
        </FocusButton>
        <FocusButton
          focusKey="disp-fps"
          onEnter={toggleFps}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="min-w-0">
            <span className="text-[2.1vh]">{t("display.matchFramerate")}</span>
            <span className="block text-[1.7vh] text-fg-dim">{t("display.matchHint")}</span>
          </span>
          <span className={["text-[1.9vh] font-semibold shrink-0", fps ? "text-[#39c0d6]" : "text-fg-dim"].join(" ")}>
            {fps ? t("display.on") : t("display.off")}
          </span>
        </FocusButton>
      </div>
      {picking && <DisplayModePicker modes={modes} applying={applying} msg={msg} onApply={onApply} onClose={close} />}
    </div>
  );
}
