import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { fetchDisplayStatus, refreshDisplayMode, type DisplayModeInfo, type DisplayStatus } from "../lib/display";
import { FocusButton } from "./FocusButton";

// 23.976 Hz stays 23.976; 60.000 shows as 60.
const hz = (r: number) => (Math.abs(r - Math.round(r)) < 0.01 ? String(Math.round(r)) : r.toFixed(3));
const label = (m: DisplayModeInfo) => `${m.width} × ${m.height} · ${hz(m.refresh)} Hz`;

// Display section: resolution is automatic (UI at up to 1080p, video claims a
// matching mode while it plays), so this is a status read plus a re-detect for the
// case where a TV pushed the output somewhere else. Renders inside the parent
// Settings FocusContext.
export function DisplaySettings() {
  const { t } = useI18n();
  const [st, setSt] = useState<DisplayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = () => fetchDisplayStatus().then((d) => d && setSt(d));
  useEffect(() => {
    load();
  }, []);

  const onRefresh = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    const r = await refreshDisplayMode();
    setBusy(false);
    if (!r.ok) setMsg(t("display.failed"));
    load();
  };

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">{t("display.title")}</div>
      <div className="flex flex-col gap-[1vh] max-w-[70vw]">
        <FocusButton
          focusKey="disp-refresh"
          onEnter={onRefresh}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="min-w-0">
            <span className="text-[2.1vh]">{t("display.resolution")}</span>
            <span className="block text-[1.7vh] text-fg-dim">{t("display.autoHint")}</span>
          </span>
          <span className="text-[1.9vh] shrink-0 tabular-nums">
            {busy ? (
              <span className="text-accent">{t("display.applying")}</span>
            ) : msg ? (
              <span className="text-fg-dim">{msg}</span>
            ) : st?.current ? (
              <span className="text-fg-dim">{label(st.current)}</span>
            ) : (
              // no output at all (TV off / wlr-randr missing) vs the status not
              // having loaded yet - don't claim "no modes" for a failed fetch
              <span className="text-fg-dim">{st ? t("display.none") : "-"}</span>
            )}
          </span>
        </FocusButton>
      </div>
    </div>
  );
}
