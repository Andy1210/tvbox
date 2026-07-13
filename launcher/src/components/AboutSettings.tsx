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
  const disk = info?.disk
    ? `${(info.disk.freeBytes / 1e9).toFixed(1)} / ${(info.disk.totalBytes / 1e9).toFixed(1)} GB`
    : DASH;

  return (
    <div className="mt-[3vh] pb-[10vh]">
      <div className="flex items-center gap-[1.5vw] mb-[1.4vh]">
        <div className="text-[2.4vh] font-semibold">{t("about.title")}</div>
        <FocusButton
          focusKey="about-refresh"
          onEnter={refresh}
          // scroll-mb: this is the section's ONLY focusable and it sits at the
          // TOP - without the margin, focusing it scrolls just far enough to
          // show the button and the diagnostic rows below stay off-screen
          className="px-[2vw] py-[1.2vh] rounded-[1vh] bg-white/5 text-[1.9vh] font-semibold scroll-mb-[46vh]"
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
        <Row label={t("about.storage")} value={disk} />
      </div>

      {/* Open-source credits. tvbox is MIT and stands on other people's work;
          say so (some of it, like the irdb IR database, asks to be credited). */}
      <div className="mt-[3.4vh] max-w-[70vw]">
        <div className="text-[2.1vh] font-semibold mb-[0.8vh]">{t("about.creditsTitle")}</div>
        <div className="text-[1.8vh] text-fg-dim mb-[1.4vh]">{t("about.creditsIntro")}</div>
        <div className="text-[1.6vh] text-fg-dim mb-[1.4vh]">{t("about.trademarks")}</div>
        <ul className="flex flex-col gap-[0.9vh]">
          {CREDITS.map((c) => (
            <li key={c.name} className="text-[1.9vh]">
              <span className="font-semibold">{c.name}</span>
              <span className="text-fg-dim"> — {c.what}</span>
              <span className="block text-[1.6vh] text-fg-dim break-all">
                {c.url} · {c.license}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Third-party projects tvbox ships or builds on. Not exhaustive of transitive
// deps, but the load-bearing ones - and everything whose license asks for a
// mention (irdb). English-only on purpose (project/license names).
const CREDITS: { name: string; what: string; url: string; license: string }[] = [
  { name: "Electron", what: "app shell", url: "electronjs.org", license: "MIT" },
  { name: "mpv", what: "video player", url: "mpv.io", license: "GPL-2.0+/LGPL" },
  { name: "libcec", what: "HDMI-CEC remote", url: "libcec.pulse-eight.com", license: "GPL-2.0" },
  { name: "python-evdev", what: "remote input bridge", url: "github.com/gvalkov/python-evdev", license: "BSD-3" },
  { name: "Bleak", what: "Bluetooth LE (remote IR programming)", url: "github.com/hbldh/bleak", license: "MIT" },
  { name: "irdb", what: "TV IR code database", url: "github.com/probonopd/irdb", license: "see repo (attribution)" },
  { name: "React · Vite · Tailwind", what: "launcher UI", url: "react.dev", license: "MIT" },
];
