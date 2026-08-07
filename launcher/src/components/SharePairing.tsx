import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { fetchShares } from "../lib/api";
import { FocusButton } from "./FocusButton";

// Adding a network share from the phone: starts the "shares" pairing server,
// shows the QR (+ short URL + code), and watches the box's own share list so the
// TV says "done" by itself when the phone saves one.
//
// It exists because this is the worst form on the box to fill in with a remote:
// an address, a user name and a password, none of them a word anyone can guess
// from a keyboard grid. The same overlay shape as the wallpaper upload.
export function SharePairing({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "share-pairing", isFocusBoundary: true });
  const [info, setInfo] = useState<{ shortUrl: string; code: string } | null>(null);
  const [qr, setQr] = useState("");
  // How many shares the box had when this opened, so what arrives from the phone
  // can be counted. `null` until the first answer: "zero shares" and "we have not
  // asked yet" must not read the same, or the first one added counts as none.
  const [, setCount] = useState<number | null>(null);
  const [added, setAdded] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch("/tvbox/api/pairing/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale, kind: "shares" }),
    })
      .then((r) => r.json())
      .then(async (d) => {
        if (!alive || !d || !d.url) return;
        setInfo(d);
        try {
          setQr(await QRCode.toDataURL(d.url, { width: 480, margin: 1 }));
        } catch {
          /* text only - the short URL and the code are still on screen */
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      fetch("/tvbox/api/pairing/stop", { method: "POST" }).catch(() => {});
    };
  }, [locale]);

  useEffect(() => {
    setFocus("share-pairing-done");
  }, []);

  // Count what the box has, and show the difference: a share saved from the phone
  // is the only "it worked" this screen can give, and the phone is where the eyes
  // are at that moment.
  const tick = useCallback(async () => {
    const st = await fetchShares();
    if (!st) return;
    setCount((was) => {
      if (was !== null && st.shares.length > was) setAdded((n) => n + (st.shares.length - was));
      return st.shares.length;
    });
  }, []);
  useEffect(() => {
    void tick();
    const id = setInterval(() => void tick(), 2500);
    return () => clearInterval(id);
  }, [tick]);
  useBackspace(onClose);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-[55] bg-black/90 flex flex-col items-center justify-center gap-[2.2vh] px-[6vw] text-center"
      >
        <div className="text-[3vh] font-bold">{t("shares.phoneTitle")}</div>
        <div className="text-[2vh] text-fg-dim max-w-[62vw]">{t("shares.phoneHint")}</div>
        {qr ? (
          <>
            <img src={qr} alt="QR" className="w-[30vh] h-[30vh] rounded-[1.4vh] bg-white p-[1vh]" />
            <div className="text-[2.2vh] font-semibold tabular-nums">{info?.shortUrl}</div>
            <div className="text-[2vh] text-fg-dim">
              {t("shares.phoneCode")}:{" "}
              <span className="font-bold text-fg tabular-nums tracking-[0.3vw]">{info?.code}</span>
            </div>
          </>
        ) : (
          <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
        )}
        {added > 0 && <div className="text-[2.1vh]">{t("shares.phoneAdded", { n: added })}</div>}
        <FocusButton
          focusKey="share-pairing-done"
          onEnter={onClose}
          className="px-[3vw] py-[1.6vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold"
        >
          {t("shares.phoneDone")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}
