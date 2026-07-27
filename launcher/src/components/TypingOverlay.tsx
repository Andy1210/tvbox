import { useEffect, useRef, useState } from "react";
import { getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import QRCode from "qrcode";
import { Osk } from "@sdk/Osk";
import { useI18n } from "../lib/i18n";
import { cancelTyping, fetchTypingStatus, submitTyping, type TypingStatus } from "../lib/textinput";

// Typing into an app that has no keyboard. The shell backgrounds the app and pushes
// `dest: "typing"` when a text field takes focus there; this screen offers both ways
// in and the shell types the result into the app as real keystrokes:
//
//   - the remote: our on-screen keyboard (the same one Settings uses)
//   - a phone: scan the QR, type in a normal browser field, submit
//
// The phone path exists because a password on a D-pad keyboard is miserable (and a
// phone's password manager can fill it). It goes over the LAN in the clear, so a
// password-like field says so out loud.
export function TypingOverlay() {
  const { t } = useI18n();
  const [st, setSt] = useState<TypingStatus | null>(null);
  const [qr, setQr] = useState("");
  // Where the launcher's focus was before the keyboard took it. The OSK is a focus
  // boundary and focuses its own key; without putting the focus back, unmounting it
  // leaves spatial-nav pointing at an element that no longer exists - and then the
  // remote moves nothing at all on HOME. ("home-settings" is the safety net for a
  // key that has since gone away.)
  const focusBefore = useRef<string | null>(null);

  const close = () => {
    setSt(null);
    const back = focusBefore.current;
    focusBefore.current = null;
    // After the unmount, so the OSK's focusable is gone before we aim elsewhere.
    setTimeout(() => setFocus(back || "home-settings"), 0);
  };

  // The shell pushes "typing" to open and "home" to close (it closes the session
  // itself when the phone submits, so the screen must follow the shell, not guess).
  // Any OTHER push is someone else's business - closing (and restoring focus) then
  // would yank the focus out of e.g. the Settings view the push just opened.
  useEffect(() => {
    const off = window.tvbox?.onNav?.((n) => {
      if (n.dest === "typing") {
        focusBefore.current = getCurrentFocusKey() || null;
        fetchTypingStatus().then((s) => s?.active && setSt(s));
      } else if (focusBefore.current !== null) {
        close();
      }
    });
    return off;
  }, []);

  useEffect(() => {
    if (!st?.url) {
      setQr("");
      return;
    }
    let alive = true;
    QRCode.toDataURL(st.url, { width: 420, margin: 1 }).then((d) => alive && setQr(d));
    return () => {
      alive = false;
    };
  }, [st?.url]);

  if (!st?.active) return null;

  const done = async (value: string) => {
    close();
    await submitTyping(value);
  };
  const cancel = async () => {
    close();
    await cancelTyping();
  };

  return (
    <>
      <Osk title={st.label || t("typing.title")} onDone={done} onCancel={cancel} />
      {/* Info only - no focusable elements, so the OSK keeps every arrow key. */}
      <div className="fixed right-[3vw] top-1/2 -translate-y-1/2 z-[55] w-[24vw] flex flex-col items-center gap-[1.2vh] px-[1.5vw] py-[2vh] rounded-[1.4vh] bg-white/5">
        <div className="text-[2vh] font-semibold text-center">{t("typing.phoneTitle")}</div>
        {qr ? (
          <img src={qr} alt={t("typing.qrAlt")} className="w-[15vw] h-[15vw] rounded-[1vh] bg-white p-[0.8vh]" />
        ) : (
          <div className="w-[15vw] h-[15vw] rounded-[1vh] bg-white/10" />
        )}
        <div className="text-[1.7vh] text-fg-dim text-center break-all">{st.url}</div>
        <div className="text-[2.6vh] font-bold tabular-nums tracking-[0.3vw]">{st.code}</div>
        {st.password && <div className="text-[1.6vh] text-center text-amber-300/90">{t("typing.secretHint")}</div>}
      </div>
    </>
  );
}
