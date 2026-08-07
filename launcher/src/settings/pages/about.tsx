import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchSystemInfo, type SystemInfo } from "../../lib/system";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row } from "../Rows";
import { useSettingsNav } from "../nav";

// Settings -> About. Read-only facts about the box, plus the open-source credits.
//
// The credits page is the reason SettingsPage has a no-focusable fallback at all:
// it is longer than the screen and there is nothing on it to press, so the arrows
// scroll the page instead of hunting for a focusable that is not there. Everything
// else in Settings has rows; this one deliberately does not.
const DASH = "-";
const INFO_REFRESH_MS = 5000;

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
const fmtGb = (kb: number | null): string => (kb == null ? DASH : (kb / 1048576).toFixed(1)); // kB -> GiB

// `what` is an i18n key (aboutCredits.*), resolved at render so the descriptions
// localize; name/url/license are proper nouns kept verbatim.
const CREDITS: { name: string; what: string; url: string; license: string }[] = [
  { name: "Electron", what: "aboutCredits.electron", url: "electronjs.org", license: "MIT" },
  { name: "mpv", what: "aboutCredits.mpv", url: "mpv.io", license: "GPL-2.0+/LGPL" },
  { name: "libcec", what: "aboutCredits.libcec", url: "libcec.pulse-eight.com", license: "GPL-2.0" },
  { name: "python-evdev", what: "aboutCredits.evdev", url: "github.com/gvalkov/python-evdev", license: "BSD-3" },
  { name: "Bleak", what: "aboutCredits.bleak", url: "github.com/hbldh/bleak", license: "MIT" },
  { name: "React", what: "aboutCredits.react", url: "react.dev", license: "MIT" },
  { name: "Vite", what: "aboutCredits.vite", url: "vite.dev", license: "MIT" },
  { name: "Tailwind CSS", what: "aboutCredits.tailwind", url: "tailwindcss.com", license: "MIT" },
];

function CreditsPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  return (
    <SettingsPage id="credits" title={t("about.creditsTitle")} onBack={nav.pop} animate="push">
      <Note>{t("about.creditsIntro")}</Note>
      <Note>{t("about.trademarks")}</Note>
      <ul className="flex flex-col gap-[1.1vh] max-w-[56vw]">
        {CREDITS.map((c) => (
          <li key={c.name} className="text-[2vh]">
            <span className="font-semibold">{c.name}</span>
            <span className="text-fg-dim"> - {t(c.what)}</span>
            <span className="block text-[1.7vh] text-fg-dim break-all">
              {c.url} · {c.license}
            </span>
          </li>
        ))}
      </ul>
      {/* Required verbatim by irdb LICENSE.md clause 2, so the key holds the same
          English text in both locales - but it is still a launcher string, and those
          go through t() and exist in both files. */}
      <p className="text-[1.7vh] text-fg-dim mt-[2vh] max-w-[56vw] break-words">{t("about.irdbNotice")}</p>
    </SettingsPage>
  );
}

export function AboutPane() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(() => void fetchSystemInfo().then((i) => i && alive.current && setInfo(i)), []);

  useEffect(() => {
    alive.current = true;
    refresh();
    // Temperature, memory and uptime drift while the screen is open. Only while it
    // is open: this pane is not mounted anywhere else.
    const iv = setInterval(refresh, INFO_REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(iv);
    };
  }, [refresh]);

  const units = { d: t("about.unitD"), h: t("about.unitH"), m: t("about.unitM") };
  const device = info ? [info.model, info.hostname].filter(Boolean).join(" · ") : DASH;
  const wifi = info && info.wifi.ssid ? `${info.wifi.ssid} · ${info.wifi.signal ?? DASH}%` : DASH;
  const temp = info && info.cpuTempC != null ? `${info.cpuTempC.toFixed(1)} °C` : DASH;
  const mem = info ? `${fmtGb(info.mem.availableKb)} / ${fmtGb(info.mem.totalKb)} GB` : DASH;
  const disk = info?.disk
    ? `${(info.disk.freeBytes / 1e9).toFixed(1)} / ${(info.disk.totalBytes / 1e9).toFixed(1)} GB`
    : DASH;

  return (
    <SettingsPage id="about" focusPolicy="rail">
      <Group title={t("about.groupDevice")}>
        {/* It refreshes itself every few seconds, but a row to press is also the one
            focusable near the TOP of this page - without it the D-pad's only target is
            the credits row at the very bottom. */}
        <Row id="refresh" label={t("about.refresh")} trailing="none" onEnter={refresh} />
        <InfoRow label={t("about.version")} value={info?.version || DASH} />
        <InfoRow label={t("about.device")} value={device} />
        <InfoRow label={t("about.uptime")} value={info ? fmtUptime(info.uptimeSec, units) : DASH} />
      </Group>
      <Group title={t("about.groupNetwork")}>
        <InfoRow label={t("about.ip")} value={info?.ip || DASH} />
        <InfoRow label={t("about.wifi")} value={wifi} />
      </Group>
      <Group title={t("about.groupHealth")}>
        <InfoRow label={t("about.cpuTemp")} value={temp} />
        <InfoRow label={t("about.memory")} value={mem} />
        <InfoRow label={t("about.storage")} value={disk} />
      </Group>
      <Group>
        <Row
          id="credits"
          label={t("about.creditsTitle")}
          hint={t("about.creditsIntro")}
          onEnter={() => nav.push({ id: "credits", title: t("about.creditsTitle"), render: () => <CreditsPage /> })}
        />
      </Group>
    </SettingsPage>
  );
}
