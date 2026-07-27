import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { FocusButton } from "./FocusButton";

// Generic "do this from your phone" screen for an action an APP declares
// (manifest `pairing: [{ kind, label }]`). Starts that pairing kind, shows the QR
// plus the short URL and code, and stops the server on close.
//
// Deliberately knows nothing about what the phone page does: the app's own plugin
// registers the provider and owns the page, so a native app like RetroArch, which
// has no screen of its own on the box, can still offer "upload games" here without
// the launcher growing any knowledge of games. The phone page shows its own
// progress and its own list, which is why there is no live counter on the TV.
export function AppPairing({ kind, title, onClose }: { kind: string; title: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "app-pairing", isFocusBoundary: true });
  const [info, setInfo] = useState<{ shortUrl: string; code: string } | null>(null);
  const [qr, setQr] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/tvbox/api/pairing/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale, kind }),
    })
      .then((r) => r.json())
      .then(async (d) => {
        if (!alive) return;
        if (!d || !d.url) {
          setFailed(true);
          return;
        }
        setInfo(d);
        try {
          setQr(await QRCode.toDataURL(d.url, { width: 480, margin: 1 }));
        } catch {
          /* the short URL and code below are enough to type by hand */
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      fetch("/tvbox/api/pairing/stop", { method: "POST" }).catch(() => {});
    };
  }, [locale, kind]);

  useEffect(() => {
    setFocus("app-pairing-done");
  }, []);
  useBackspace(onClose);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-[55] bg-black/90 flex flex-col items-center justify-center gap-[2.2vh] px-[6vw] text-center"
      >
        <div className="text-[3vh] font-bold">{title}</div>
        <div className="text-[2vh] text-fg-dim max-w-[62vw]">{t("appsettings.pairingHint")}</div>
        {failed ? (
          <div className="text-[2.2vh] text-warn">{t("appsettings.pairingFailed")}</div>
        ) : qr || info ? (
          <>
            {qr && <img src={qr} alt="QR" className="w-[30vh] h-[30vh] rounded-[1.4vh] bg-white p-[1vh]" />}
            <div className="text-[2.2vh] font-semibold tabular-nums">{info?.shortUrl}</div>
            <div className="text-[2vh] text-fg-dim">
              {t("appsettings.pairingCode")}:{" "}
              <span className="font-bold text-fg tabular-nums tracking-[0.3vw]">{info?.code}</span>
            </div>
          </>
        ) : (
          <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
        )}
        <FocusButton
          focusKey="app-pairing-done"
          onEnter={onClose}
          className="px-[3vw] py-[1.6vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold"
        >
          {t("appsettings.pairingDone")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}
