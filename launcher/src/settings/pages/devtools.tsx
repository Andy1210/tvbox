import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { setDebugPort, shareScreen } from "../../lib/devtools";
import { fetchPhoneRemote } from "../../lib/phoneremote";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row } from "../Rows";
import { PinGate } from "@sdk/PinGate";
import { useConfigStore } from "../../stores/config";

// Settings -> System -> Developer tools.
//
// One door, because everything behind it is for someone working ON the box and
// none of it is for someone watching television. Two of the three hand out
// something real - arbitrary code in the launcher window, and a picture of
// whatever is on screen - so the door is the parental PIN when one is set, and
// every switch here says what it opens rather than what it is called.
//
// Nothing here is remembered across a reboot on purpose. The debug endpoint is a
// marker the start script consumes; the screen share carries its own clock. A
// developer aid that survives every restart is not an aid, it is a surface
// nobody remembers leaving open.
const DEBUG_PORT = 9222;
const SHARE_MINUTES = 30;

function Tools() {
  const { t } = useI18n();
  const [screenUntil, setScreenUntil] = useState(0);
  const [msg, setMsg] = useState("");
  const [supported, setSupported] = useState(true);
  const busy = useRef(false);

  const load = useCallback(async () => {
    const r = await fetchPhoneRemote();
    if (r.kind === "unsupported") return setSupported(false);
    if (r.kind === "ok") setScreenUntil(r.state.screenUntil || 0);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // The remaining window, counted down while the page is open: this is the one
  // thing here where "how long is left" is the whole point.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!screenUntil) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [screenUntil]);
  const left = Math.max(0, Math.round((screenUntil - now) / 60000));
  const sharing = screenUntil > now;

  const debug = async () => {
    if (busy.current) return;
    busy.current = true;
    setMsg(t("dev.debugStarting"));
    const r = await setDebugPort(DEBUG_PORT);
    busy.current = false;
    // No success message: the shell is about to go away and take this screen
    // with it. A failure is the only thing worth saying.
    if (!r.ok) setMsg(t("dev.debugFailed"));
  };

  const screen = async (minutes: number) => {
    if (busy.current) return;
    busy.current = true;
    const r = await shareScreen(minutes);
    busy.current = false;
    if (r.ok) {
      setScreenUntil(r.until || 0);
      setNow(Date.now());
      setMsg("");
    } else setMsg(t("dev.screenFailed"));
  };

  return (
    <>
      <Group title={t("dev.debugGroup")}>
        <Row
          id="debugport"
          label={t("dev.debugPort")}
          hint={t("dev.debugPortHint", { port: DEBUG_PORT })}
          onEnter={() => void debug()}
          autoFocus
          trailing="none"
        />
      </Group>
      <Note>{t("dev.debugNote", { port: DEBUG_PORT })}</Note>

      <Group title={t("dev.screenGroup")}>
        <Row
          id="screenshare"
          label={sharing ? t("dev.screenStop") : t("dev.screenStart", { n: SHARE_MINUTES })}
          hint={supported ? t("dev.screenHint") : t("dev.screenUnsupported")}
          value={sharing ? t("dev.screenLeft", { n: left }) : t("dev.off")}
          onEnter={() => void screen(sharing ? 0 : SHARE_MINUTES)}
          trailing="none"
          disabled={!supported}
        />
        {sharing ? <InfoRow label={t("dev.screenWatching")} value={t("dev.screenLeft", { n: left })} /> : null}
      </Group>
      <Note tone={sharing ? "warn" : "dim"}>{sharing ? t("dev.screenOnNote") : t("dev.screenNote")}</Note>

      {msg ? <Note tone="warn">{msg}</Note> : null}
    </>
  );
}

export function DevToolsPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  // The same PIN that locks app categories - and only when one EXISTS. With none
  // set, verifyPin refuses every code, so gating unconditionally would lock this
  // screen away from every box that never set a PIN. This gates what exists; it
  // is not the place to invent a lock.
  const pinSet = useConfigStore((s) => s.config?.parental?.pinSet) ?? false;
  const [allowed, setAllowed] = useState(false);
  return (
    <SettingsPage id="dev" title={t("dev.title")} onBack={onBack} animate="push">
      {allowed || !pinSet ? <Tools /> : <PinGate onSuccess={() => setAllowed(true)} onCancel={onBack} />}
    </SettingsPage>
  );
}
