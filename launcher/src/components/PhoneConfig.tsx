import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { useConfigStore } from "../stores/config";

interface Pairing {
  url: string;
  shortUrl: string;
  code: string;
}

// Phone pairing screen: asks the shell to start the LAN config server, shows a
// QR (+ short URL + code) for the phone, and polls until the box reports it's
// configured - then closes. Remote Back cancels (and stops the server).
export function PhoneConfig({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t, locale } = useI18n();
  const [info, setInfo] = useState<Pairing | null>(null);
  const [qr, setQr] = useState<string>("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/tvbox/api/pairing/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale }),
    })
      .then((r) => r.json())
      .then(async (d) => {
        if (!alive) return;
        if (!d || !d.url) {
          setError(true);
          return;
        }
        setInfo(d);
        try {
          setQr(await QRCode.toDataURL(d.url, { width: 480, margin: 1 }));
        } catch {
          /* show text only */
        }
      })
      .catch(() => setError(true));
    return () => {
      alive = false;
      fetch("/tvbox/api/pairing/stop", { method: "POST" }).catch(() => {});
    };
  }, [locale]);

  // poll the config store until the box reports configured
  const load = useConfigStore((s) => s.load);
  useEffect(() => {
    const id = setInterval(async () => {
      const c = await load();
      if (c?.iptv.configured) {
        clearInterval(id);
        onDone();
      } // null = shell hiccup; keep polling
    }, 2000);
    return () => clearInterval(id);
  }, [onDone, load]);

  useBackspace(onCancel);

  return (
    <div className="h-full flex flex-col items-center justify-center gap-[2.5vh] px-[6vw] text-center">
      <div className="text-[3vh] font-bold">{t("livetv.phoneSetupTitle")}</div>
      <div className="text-[2vh] text-fg-dim max-w-[62vw]">{t("livetv.phoneSetupHint")}</div>
      {error ? (
        <div className="text-[2.2vh] text-red-400">{t("livetv.error")}</div>
      ) : qr ? (
        <>
          <img src={qr} alt="QR" className="w-[32vh] h-[32vh] rounded-[1.4vh] bg-white p-[1vh]" />
          <div className="text-[2.4vh] font-semibold tabular-nums">{info?.shortUrl}</div>
          <div className="text-[2vh] text-fg-dim">
            {t("livetv.phoneSetupCode")}:{" "}
            <span className="font-bold text-fg tabular-nums tracking-[0.3vw]">{info?.code}</span>
          </div>
        </>
      ) : (
        <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
      )}
    </div>
  );
}
