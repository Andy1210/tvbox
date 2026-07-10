import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { sendBackupContext, fetchBackupStatus } from "../lib/backup";
import { FocusButton } from "./FocusButton";

// Backup & restore section of HOME → Settings → System. One button opens a
// phone QR session (pairing kind "backup"); the phone page both downloads the
// password-encrypted .tvbackup file and uploads one to restore. Before the QR
// appears the launcher hands its localStorage to the shell (locale/app order
// travel inside the backup). A successful restore restarts the shell - we
// watch /tvbox/api/backup/status to announce it instead of dying silently.
// Mirrors AmbientPhotos (fullscreen overlay, own focus boundary, Back closes).
function BackupPhone({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "backup-phone", isFocusBoundary: true });
  const [info, setInfo] = useState<{ shortUrl: string; code: string } | null>(null);
  const [qr, setQr] = useState("");
  const [error, setError] = useState(false);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      await sendBackupContext(); // best effort - a backup without it still restores everything shell-side
      try {
        const d = await (
          await fetch("/tvbox/api/pairing/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ locale, kind: "backup" }),
          })
        ).json();
        if (!alive) return;
        if (!d || !d.url) {
          setError(true);
          return;
        }
        setInfo(d);
        try {
          setQr(await QRCode.toDataURL(d.url, { width: 480, margin: 1 }));
        } catch {
          /* text only */
        }
      } catch {
        if (alive) setError(true);
      }
    })();
    return () => {
      alive = false;
      fetch("/tvbox/api/pairing/stop", { method: "POST" }).catch(() => {});
    };
  }, [locale]);

  // a restore restarts the shell in a few seconds - tell the user why
  useEffect(() => {
    const id = setInterval(async () => {
      const s = await fetchBackupStatus();
      if (s?.restoredAt) {
        setRestored(true);
        clearInterval(id);
      }
    }, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setFocus("backup-phone-done");
  }, []);
  useBackspace(onClose);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-[55] bg-black/90 flex flex-col items-center justify-center gap-[2.2vh] px-[6vw] text-center"
      >
        <div className="text-[3vh] font-bold">{t("backup.phoneTitle")}</div>
        <div className="text-[2vh] text-fg-dim max-w-[62vw]">{t("backup.phoneHint")}</div>
        {restored ? (
          <div className="text-[2.4vh] font-semibold text-[#3fb950]">{t("backup.restored")}</div>
        ) : error ? (
          <div className="text-[2.2vh] text-red-400">{t("backup.error")}</div>
        ) : qr ? (
          <>
            <img src={qr} alt="QR" className="w-[30vh] h-[30vh] rounded-[1.4vh] bg-white p-[1vh]" />
            <div className="text-[2.2vh] font-semibold tabular-nums">{info?.shortUrl}</div>
            <div className="text-[2vh] text-fg-dim">
              {t("backup.code")}: <span className="font-bold text-fg tabular-nums tracking-[0.3vw]">{info?.code}</span>
            </div>
          </>
        ) : (
          <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
        )}
        <FocusButton
          focusKey="backup-phone-done"
          onEnter={onClose}
          className="px-[3vw] py-[1.5vh] rounded-[1.1vh] bg-white/10 text-[2.1vh] font-semibold"
        >
          {t("backup.done")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}

export function BackupSettings() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">{t("backup.title")}</div>
      <div className="max-w-[70vw]">
        <div className="text-[1.8vh] text-fg-dim max-w-[60vw] mb-[1.2vh]">{t("backup.hint")}</div>
        <FocusButton
          focusKey="backup-start"
          onEnter={() => setOpen(true)}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 text-[2.1vh] font-semibold"
        >
          {t("backup.start")}
        </FocusButton>
      </div>
      {open && (
        <BackupPhone
          onClose={() => {
            setOpen(false);
            setTimeout(() => setFocus("backup-start"), 0);
          }}
        />
      )}
    </div>
  );
}
