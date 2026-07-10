import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { useConfigStore } from "../stores/config";
import { fetchUpdateStatus, checkUpdate, applyUpdate, type UpdateStatus } from "../lib/update";
import { power } from "../lib/power";
import { FocusButton } from "./FocusButton";

// Software update section of HOME → Settings → System. Two halves:
//  - tvbox itself (OTA): version, check/install, the auto-update toggle. The
//    install ends in a shell restart - the generic shell-unreachable retry
//    screen covers the gap, so no special handling here.
//  - the OS: unattended-upgrades patches in the background and NEVER reboots;
//    when /var/run/reboot-required appears we show a hint + a restart button
//    (user's call, never automatic).
const DASH = "-";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-[2vw] py-[0.7vh] text-[2vh]">
      <div className="w-[22vw] shrink-0 text-fg-dim">{label}</div>
      <div className="min-w-0 break-words tabular-nums">{value}</div>
    </div>
  );
}

export function UpdateSettings() {
  const { t, locale } = useI18n();
  const config = useConfigStore((s) => s.config);
  const setUpdate = useConfigStore((s) => s.setUpdate);
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    fetchUpdateStatus().then((s) => {
      if (s) setSt(s);
    });
  };
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 3000); // live while a download/install runs
    return () => clearInterval(iv);
  }, []);

  const working = !!st && st.state !== "idle" && st.state !== "error";
  const auto = config?.update.auto ?? true;
  const appsAuto = config?.update.appsAuto ?? true;

  const onCheck = async () => {
    setBusy(true);
    const s = await checkUpdate();
    if (s) setSt(s);
    setBusy(false);
  };
  const onInstall = async () => {
    setBusy(true);
    const s = await applyUpdate();
    if (s) setSt(s);
    setBusy(false);
  };

  // one status line for the tvbox half - the most relevant thing, in order
  const statusLine = !st
    ? DASH
    : st.state === "checking"
      ? t("update.checking")
      : st.state === "downloading"
        ? t("update.downloading")
        : st.state === "installing"
          ? t("update.installing")
          : st.state === "restarting"
            ? t("update.restarting")
            : st.state === "error"
              ? t("update.error")
              : st.available && st.latest
                ? t("update.available", { version: st.latest.version })
                : t("update.upToDate");

  const notes =
    st?.available && st.latest?.notes
      ? st.latest.notes[(locale || "en") as "en" | "hu"] || st.latest.notes.en || ""
      : "";
  const lastUpdated = st?.last
    ? new Date(st.last.at).toLocaleDateString(locale || undefined) + " (" + st.last.from + " → " + st.last.to + ")"
    : t("update.never");

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">{t("update.title")}</div>
      <div className="max-w-[70vw]">
        <Row label={t("update.current")} value={st ? st.current + (st.release ? "" : " (dev)") : DASH} />
        <Row label={t("update.lastUpdated")} value={lastUpdated} />
        <div
          className={[
            "py-[0.7vh] text-[2.1vh] font-semibold",
            st?.state === "error" ? "text-red-400" : st?.available ? "text-accent" : "",
          ].join(" ")}
        >
          {statusLine}
        </div>
        {st?.state === "error" && st.error && <div className="text-[1.7vh] text-fg-dim break-words">{st.error}</div>}
        {notes && (
          <div className="text-[1.8vh] text-fg-dim max-w-[60vw] mb-[0.6vh] whitespace-pre-line max-h-[24vh] overflow-y-auto no-scrollbar">
            {notes}
          </div>
        )}
        {st?.failed && (
          <div className="text-[1.8vh] text-warn max-w-[60vw] mb-[0.6vh]">
            {t("update.failedRollback", { version: st.failed.to })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-[1vw] mt-[1vh]">
          <FocusButton
            focusKey="update-check"
            onEnter={() => {
              if (!working && !busy) onCheck();
            }}
            className="px-[2vw] py-[1.3vh] rounded-[1vh] bg-white/5 text-[1.9vh] font-semibold"
          >
            {t("update.check")}
          </FocusButton>
          {st?.available && !working && (
            <FocusButton
              focusKey="update-install"
              onEnter={() => {
                if (!busy) onInstall();
              }}
              className="px-[2vw] py-[1.3vh] rounded-[1vh] bg-accent text-bg-1 text-[1.9vh] font-bold"
            >
              {t("update.install")}
            </FocusButton>
          )}
        </div>
        {st?.available && !working && (
          <div className="text-[1.7vh] text-fg-dim mt-[0.6vh]">{t("update.installHint")}</div>
        )}

        <FocusButton
          focusKey="update-auto"
          onEnter={() => setUpdate({ auto: !auto })}
          className="mt-[1.4vh] w-full px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="text-[2.1vh]">{t("update.auto")}</span>
          <span className={["text-[1.9vh] font-semibold", auto ? "text-accent" : "text-fg-dim"].join(" ")}>
            {auto ? t("display.on") : t("display.off")}
          </span>
        </FocusButton>
        <div className="text-[1.7vh] text-fg-dim mt-[0.5vh]">{t("update.autoHint")}</div>
        <FocusButton
          focusKey="update-apps-auto"
          onEnter={() => setUpdate({ appsAuto: !appsAuto })}
          className="mt-[1vh] px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw] w-full"
        >
          <span className="text-[2.1vh]">{t("update.appsAuto")}</span>
          <span className={["text-[1.9vh] font-semibold", appsAuto ? "text-accent" : "text-fg-dim"].join(" ")}>
            {appsAuto ? t("display.on") : t("display.off")}
          </span>
        </FocusButton>
        <div className="text-[1.7vh] text-fg-dim mt-[0.5vh]">{t("update.appsAutoHint")}</div>

        <div className="text-[2.4vh] font-semibold mt-[3vh] mb-[1vh]">{t("update.osTitle")}</div>
        <div className="text-[1.8vh] text-fg-dim max-w-[60vw]">{t("update.osAuto")}</div>
        {st?.os.rebootRequired ? (
          <>
            <div className="text-[2vh] text-warn mt-[1vh] max-w-[60vw]">{t("update.rebootNeeded")}</div>
            {st.os.packages.length > 0 && (
              <div className="text-[1.7vh] text-fg-dim mt-[0.4vh] break-words">{st.os.packages.join(", ")}</div>
            )}
            <FocusButton
              focusKey="update-reboot"
              onEnter={() => power("reboot")}
              className="mt-[1vh] px-[2vw] py-[1.3vh] rounded-[1vh] bg-white/5 text-[1.9vh] font-semibold"
            >
              {t("update.rebootNow")}
            </FocusButton>
          </>
        ) : (
          <div className="text-[1.8vh] text-fg-dim mt-[0.8vh]">{t("update.rebootNone")}</div>
        )}
      </div>
    </div>
  );
}
