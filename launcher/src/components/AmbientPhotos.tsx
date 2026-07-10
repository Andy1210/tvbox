import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { fetchPhotos } from "../lib/ambient";
import { FocusButton } from "./FocusButton";

// Ambient wallpaper upload: starts the "photos" phone-pairing server, shows a QR
// (+ short URL + code) to scan, and live-counts photos as they arrive (the phone
// page downscales + uploads them into ~/.tvbox/ambient/). Done/Back closes and
// stops the server. Same phone-pairing overlay shape as Backup's phone screen.
export function AmbientPhotos({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "ambient-photos", isFocusBoundary: true });
  const [info, setInfo] = useState<{ shortUrl: string; code: string } | null>(null);
  const [qr, setQr] = useState("");
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch("/tvbox/api/pairing/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale, kind: "photos" }),
    })
      .then((r) => r.json())
      .then(async (d) => {
        if (!alive || !d || !d.url) return;
        setInfo(d);
        try {
          setQr(await QRCode.toDataURL(d.url, { width: 480, margin: 1 }));
        } catch {
          /* text only */
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      fetch("/tvbox/api/pairing/stop", { method: "POST" }).catch(() => {});
    };
  }, [locale]);

  useEffect(() => {
    setFocus("ambient-photos-done");
  }, []);
  useEffect(() => {
    const tick = () => fetchPhotos().then((p) => setCount(p.length));
    tick();
    const id = setInterval(tick, 2500);
    return () => clearInterval(id);
  }, []);
  useBackspace(onClose);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-[55] bg-black/90 flex flex-col items-center justify-center gap-[2.2vh] px-[6vw] text-center"
      >
        <div className="text-[3vh] font-bold">{t("ambient.photosTitle")}</div>
        <div className="text-[2vh] text-fg-dim max-w-[62vw]">{t("ambient.photosHint")}</div>
        {qr ? (
          <>
            <img src={qr} alt="QR" className="w-[30vh] h-[30vh] rounded-[1.4vh] bg-white p-[1vh]" />
            <div className="text-[2.2vh] font-semibold tabular-nums">{info?.shortUrl}</div>
            <div className="text-[2vh] text-fg-dim">
              {t("ambient.photosCode")}:{" "}
              <span className="font-bold text-fg tabular-nums tracking-[0.3vw]">{info?.code}</span>
            </div>
          </>
        ) : (
          <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
        )}
        <div className="text-[2.1vh]">{t("ambient.photosCount", { n: count })}</div>
        <FocusButton
          focusKey="ambient-photos-done"
          onEnter={onClose}
          className="px-[3vw] py-[1.6vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold"
        >
          {t("ambient.photosDone")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}
