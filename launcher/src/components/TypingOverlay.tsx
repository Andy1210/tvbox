import { useEffect, useRef, useState } from "react";
import { getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import QRCode from "qrcode";
import { Osk } from "@sdk/Osk";
import { useI18n } from "../lib/i18n";
import { armPhoneTyping, cancelTyping, fetchTypingStatus, submitTyping, type TypingStatus } from "../lib/textinput";

// Typing into an app that has no keyboard. The shell backgrounds the app and pushes
// `dest: "typing"` when a text field takes focus there; this screen offers both ways
// in and the shell types the result into the app as real keystrokes:
//
//   - the remote: our on-screen keyboard (the same one Settings uses)
//   - a phone: press "phone" on the keyboard, scan the QR, type in a normal browser
//
// The phone path exists because a password on a D-pad keyboard is miserable (and a
// phone's password manager can fill it). It is armed only on request: starting the
// pairing session opens a LAN server and mints a code, which must be the user's
// decision rather than a side effect of a page focusing a field. It also travels the
// LAN unencrypted, so a password-like field says so out loud.
//
// WHO is asking comes from the manifest (appName); the field's own label is text the
// PAGE authored, so it is shown as a quote from the app, never as the shell's own
// question - otherwise a page could label a field "Parental PIN" and have our trusted
// keyboard collect it.
export function TypingOverlay() {
  const { t } = useI18n();
  const [st, setSt] = useState<TypingStatus | null>(null);
  const [qr, setQr] = useState("");
  const [phone, setPhone] = useState<{ url?: string; code?: string } | null>(null);
  // Where the launcher's focus was before the keyboard took it. The OSK is a focus
  // boundary and focuses its own key; without putting the focus back, unmounting it
  // leaves spatial-nav pointing at an element that no longer exists - and then the
  // remote moves nothing at all on HOME. ("home-settings" is the safety net for a
  // key that has since gone away.)
  const focusBefore = useRef<string | null>(null);
  // Bumped on every open/close, so a status fetch that lands after the session ended
  // can't re-open a screen the shell no longer has (the user would type into nothing).
  const generation = useRef(0);

  // restoreFocus=false when something ELSE is taking over the screen (a nav push to
  // Settings): that view focuses itself, and our queued restore would land after it and
  // park the focus on a key that no longer exists - leaving the D-pad dead.
  const close = (restoreFocus = true) => {
    generation.current++;
    setSt(null);
    setPhone(null);
    setQr("");
    const back = focusBefore.current;
    focusBefore.current = null;
    if (restoreFocus) setTimeout(() => setFocus(back || "home-settings"), 0);
  };

  // The shell pushes "typing" to open and "home" to close (it closes the session
  // itself when the phone submits, so the screen must follow the shell, not guess).
  // Any OTHER push is someone else's business - closing (and restoring focus) then
  // would yank the focus out of e.g. the Settings view the push just opened.
  useEffect(() => {
    const off = window.tvbox?.onNav?.((n) => {
      if (n.dest === "typing") {
        focusBefore.current = getCurrentFocusKey() || null;
        const mine = ++generation.current;
        fetchTypingStatus().then((s) => {
          if (mine === generation.current && s?.active) setSt(s);
        });
      } else if (focusBefore.current !== null) {
        close(n.dest === "home"); // a view switch focuses itself; Home doesn't
      }
    });
    return off;
  }, []);

  useEffect(() => {
    if (!phone?.url) {
      setQr("");
      return;
    }
    let alive = true;
    QRCode.toDataURL(phone.url, { width: 420, margin: 1 })
      .then((d) => alive && setQr(d))
      .catch(() => {}); // no QR is a survivable outcome: the URL + code are on screen
    return () => {
      alive = false;
    };
  }, [phone?.url]);

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
      <Osk
        title={t("typing.title")}
        onDone={done}
        onCancel={cancel}
        extra={{ label: t("typing.phoneKey"), onPress: () => armPhoneTyping().then(setPhone) }}
      />
      {/* Info only - no focusable elements, so the OSK keeps every arrow key. */}
      <div className="fixed right-[3vw] top-1/2 -translate-y-1/2 z-[55] w-[24vw] flex flex-col items-center gap-[1.2vh] px-[1.5vw] py-[2vh] rounded-[1.4vh] bg-white/5">
        <div className="text-[1.9vh] text-fg-dim text-center">{t("typing.asking")}</div>
        <div className="text-[2.2vh] font-semibold text-center">{st.appName || st.app}</div>
        {st.label && (
          <div className="text-[1.7vh] text-fg-dim text-center italic break-words">
            {"\u201C" + st.label + "\u201D"}
          </div>
        )}
        {st.password && <div className="text-[1.6vh] text-center text-amber-300/90">{t("typing.secretHint")}</div>}
        <div className="w-full h-[0.1vh] bg-white/10 my-[0.4vh]" />
        {qr ? (
          <>
            <img src={qr} alt={t("typing.qrAlt")} className="w-[13vw] h-[13vw] rounded-[1vh] bg-white p-[0.8vh]" />
            <div className="text-[1.6vh] text-fg-dim text-center break-all">{phone?.url}</div>
            <div className="text-[2.4vh] font-bold tabular-nums tracking-[0.3vw]">{phone?.code}</div>
          </>
        ) : (
          <div className="text-[1.7vh] text-fg-dim text-center">{t("typing.phoneHint")}</div>
        )}
      </div>
    </>
  );
}
