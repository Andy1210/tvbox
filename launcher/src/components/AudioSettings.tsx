import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useFocusableItem } from "../lib/useFocusableItem";
import { fetchSinks, setDefaultSink, setSinkVolume, type AudioState } from "../lib/audio";
import { FocusButton } from "./FocusButton";

// Audio section of the HOME Settings screen: pick the output sink (a manual
// override of the HDMI auto-detect, persisted) and set the default sink's
// volume. Renders inside the parent Settings FocusContext.
const VOL_STEP = 0.05;

// Volume as a single full-width row: Left/Right adjust while it's focused, Up/Down
// navigate away. A full-width nav-stop (not two small −/＋ buttons that vertical
// navigation skips past to the right-aligned rows below).
function VolumeRow({ volume, muted, onBump }: { volume: number; muted: boolean; onBump: (d: number) => void }) {
  const { t } = useI18n();
  const { ref, focused } = useFocusableItem<HTMLDivElement>(
    {
      focusKey: "audio-vol",
      onEnterPress: () => {},
      onArrowPress: (dir) => {
        if (dir === "left") {
          onBump(-VOL_STEP);
          return false;
        } // false = handled, don't navigate
        if (dir === "right") {
          onBump(VOL_STEP);
          return false;
        }
        return true; // up/down: let navigation proceed
      },
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      className={[
        "px-[2vw] py-[1.5vh] rounded-[1.1vh] flex items-center justify-between gap-[1.5vw] transition-[transform,background-color,color] duration-150",
        focused ? "!bg-white !text-[#06090d] scale-[1.02]" : "bg-white/5",
      ].join(" ")}
    >
      <span className="text-[2.1vh]">{t("audio.volume")}</span>
      <span className="flex items-center gap-[1.2vw] text-[2.2vh] font-semibold tabular-nums">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-[2.2vh] h-[2.2vh] opacity-60"
          aria-hidden
        >
          <path d="M15 6l-6 6 6 6" />
        </svg>
        <span className="w-[7vw] text-center">{muted ? t("audio.muted") : Math.round(volume * 100) + "%"}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-[2.2vh] h-[2.2vh] opacity-60"
          aria-hidden
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
    </div>
  );
}

export function AudioSettings() {
  const { t } = useI18n();
  const [state, setState] = useState<AudioState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    fetchSinks().then((s) => {
      if (s) setState(s);
    });
  };
  useEffect(() => {
    refresh();
  }, []);

  const pick = async (sink: string, focusKey: string) => {
    if (busy) return;
    setBusy(true);
    await setDefaultSink(sink);
    setBusy(false);
    setTimeout(() => setFocus(focusKey), 0);
    refresh();
  };

  const def = state?.sinks.find((s) => s.isDefault) || null;
  const bumpVolume = async (delta: number) => {
    if (!def || def.volume == null || busy) return;
    const v = Math.max(0, Math.min(1, def.volume + delta));
    setState((s) => s && { ...s, sinks: s.sinks.map((x) => (x.id === def.id ? { ...x, volume: v } : x)) }); // optimistic
    await setSinkVolume(def.id, v);
  };

  const sinks = state?.sinks || [];
  const autoSelected = !state?.override;

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">{t("audio.title")}</div>
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        <FocusButton
          focusKey="audio-auto"
          onEnter={() => pick("", "audio-auto")}
          className={[
            "px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]",
            autoSelected ? "ring-[0.25vh] ring-white/40" : "",
          ].join(" ")}
        >
          <span className="min-w-0">
            <span className="text-[2.1vh]">{t("audio.auto")}</span>
            <span className="block text-[1.7vh] text-fg-dim">{t("audio.autoHint")}</span>
          </span>
        </FocusButton>
        {sinks.map((s) => (
          <FocusButton
            key={s.id}
            focusKey={"audio-sink-" + s.id}
            onEnter={() => pick(s.name, "audio-sink-" + s.id)}
            className={[
              "px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]",
              state?.override === s.name ? "ring-[0.25vh] ring-white/40" : "",
            ].join(" ")}
          >
            <span className="text-[2.1vh] truncate">{s.description || s.name}</span>
            {s.isDefault && (
              <span className="flex items-center gap-[0.6vw] text-[1.7vh] text-accent shrink-0">
                <span className="w-[1.2vh] h-[1.2vh] rounded-full bg-accent shrink-0" />
                {t("audio.default")}
              </span>
            )}
          </FocusButton>
        ))}
        {!sinks.length && <div className="text-[1.9vh] text-fg-dim">{t("audio.none")}</div>}
      </div>

      {def && def.volume != null && (
        <div className="mt-[1.4vh] max-w-[70vw]">
          <VolumeRow volume={def.volume} muted={def.muted} onBump={bumpVolume} />
        </div>
      )}
    </div>
  );
}
