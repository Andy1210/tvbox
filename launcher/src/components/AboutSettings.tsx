import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { fetchSystemInfo, type SystemInfo } from "../lib/system";
import { FocusButton } from "./FocusButton";

// Diagnostics / About section of the HOME Settings screen: version, device, IP,
// WiFi signal, CPU temperature, uptime and free memory. All read-only (shell
// route GET /tvbox/api/system/info); auto-refreshes while visible so temp/mem
// stay live. Renders inside the parent Settings FocusContext (Refresh anchor).
const DASH = "-";

function fmtUptime(sec: number, u: { d: string; h: string; m: string }): string {
  const d = Math.floor(sec / 86400),
    h = Math.floor((sec % 86400) / 3600),
    m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}${u.d}`);
  if (d || h) parts.push(`${h}${u.h}`);
  parts.push(`${m}${u.m}`);
  return parts.join(" ");
}
function fmtGb(kb: number | null): string {
  return kb == null ? DASH : (kb / 1048576).toFixed(1); // kB -> GiB
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-[2vw] py-[0.7vh] text-[2vh]">
      <div className="w-[22vw] shrink-0 text-fg-dim">{label}</div>
      <div className="min-w-0 break-all tabular-nums">{value}</div>
    </div>
  );
}

export function AboutSettings() {
  const { t } = useI18n();
  const [info, setInfo] = useState<SystemInfo | null>(null);

  const refresh = () => {
    fetchSystemInfo().then((i) => {
      if (i) setInfo(i);
    });
  };
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000); // temp/mem/uptime drift while the screen is open
    return () => clearInterval(iv);
  }, []);

  const units = { d: t("about.unitD"), h: t("about.unitH"), m: t("about.unitM") };
  const device = info ? [info.model, info.hostname].filter(Boolean).join(" · ") : DASH;
  const wifi = info && info.wifi.ssid ? `${info.wifi.ssid} · ${info.wifi.signal ?? DASH}%` : DASH;
  const temp = info && info.cpuTempC != null ? `${info.cpuTempC.toFixed(1)} °C` : DASH;
  const mem = info ? `${fmtGb(info.mem.availableKb)} / ${fmtGb(info.mem.totalKb)} GB` : DASH;

  return (
    <div className="mt-[3vh]">
      <div className="flex items-center gap-[1.5vw] mb-[1.4vh]">
        <div className="text-[2.4vh] font-semibold">{t("about.title")}</div>
        <FocusButton
          focusKey="about-refresh"
          onEnter={refresh}
          className="px-[2vw] py-[1.2vh] rounded-[1vh] bg-white/5 text-[1.9vh] font-semibold"
        >
          {t("about.refresh")}
        </FocusButton>
      </div>
      <div className="max-w-[70vw]">
        <Row label={t("about.version")} value={info ? info.version || DASH : DASH} />
        <Row label={t("about.device")} value={device} />
        <Row label={t("about.ip")} value={info ? info.ip || DASH : DASH} />
        <Row label={t("about.wifi")} value={wifi} />
        <Row label={t("about.cpuTemp")} value={temp} />
        <Row label={t("about.uptime")} value={info ? fmtUptime(info.uptimeSec, units) : DASH} />
        <Row label={t("about.memory")} value={mem} />
      </div>
    </div>
  );
}
