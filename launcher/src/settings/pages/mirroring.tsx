import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchMirroring, startMirroring, stopMirroring, type MirrorStatus } from "../../lib/api";
import { wifiStatus, type WifiStatus } from "../../lib/wifi";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row } from "../Rows";
import { invalidateSummary } from "../summary";

// Settings -> Network -> Screen mirroring: show a phone's screen on the TV.
//
// There is no on/off setting behind this page, and that is the design rather
// than an omission. Being a Wi-Fi Display sink means holding the whole radio and
// keeping a WPS push button open, and a push button admits whoever presses it -
// including a neighbour in range. So mirroring is something you switch on for as
// long as you are using it, like choosing an input on a TV, and the box gives
// the radio back on its own if nobody arrives.
//
// The page polls while it is open because none of this is stored state: the
// answer to "is it mirroring" lives in a running group, and a phone can appear
// or vanish without anyone touching the remote.
const POLL_MS = 2000;

// The box answers with a code, never a sentence: it is a shell script, and a
// sentence from one would reach a Hungarian TV in English. `mirroring.err.` is a
// dynamic locale prefix, so the parity test cannot catch a code with nothing
// behind it - translate() hands back the key it could not find, which on a TV
// reads as gibberish, so fall back to the generic one. Same shape as the file
// server's errText, for the same reason.
function errText(t: (k: string) => string, code: string): string {
  const key = "mirroring.err." + code;
  const msg = t(key);
  return msg === key ? t("mirroring.err.unknown") : msg;
}

export function MirroringPage() {
  const { t } = useI18n();
  const [st, setSt] = useState<MirrorStatus | null>(null);
  const [net, setNet] = useState<WifiStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Arming takes five to eight seconds: the radio is handed over, a group owner
  // is created and DHCP comes up. Without this the row says "Off" for all of it
  // and there is no way to tell whether the press even registered - the one
  // thing a remote must never leave in doubt.
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    const s = await fetchMirroring();
    setUnreachable(!s);
    if (s) setSt(s);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Whether mirroring will cost this box its network is knowable before anyone
  // presses anything, and it is the one thing worth saying in advance: a phone
  // connects to the radio directly, so a box with no cable goes offline for the
  // length of the session. It comes back on the same connection afterwards, which
  // is why this is a warning and not a refusal.
  useEffect(() => {
    void wifiStatus().then(setNet);
  }, []);
  const willGoOffline = !!net?.connected && !net?.ethernet?.connected;

  const toggle = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    const armed = !!st?.armed;
    setPending(armed ? "stop" : "start");
    const r = armed ? await stopMirroring() : await startMirroring();
    busy.current = false;
    setPending(null);
    if (!r.ok) setError(errText(t, r.error || "unknown"));
    invalidateSummary("mirroring");
    void load();
  };

  if (unreachable) {
    return (
      <SettingsPage id="mirroring">
        <Group>
          <Row id="retry" label={t("mirroring.retry")} onEnter={() => void load()} autoFocus trailing="none" />
        </Group>
      </SettingsPage>
    );
  }

  const armed = !!st?.armed;
  const streaming = !!st?.streaming;
  const status = pending
    ? t(pending === "start" ? "mirroring.starting" : "mirroring.stopping")
    : streaming
      ? t("mirroring.streaming")
      : armed
        ? t("mirroring.waiting")
        : t("mirroring.off");

  return (
    <SettingsPage id="mirroring">
      <Group>
        <Row
          id="toggle"
          label={armed ? t("mirroring.stop") : t("mirroring.start")}
          hint={armed ? t("mirroring.stopHint") : t("mirroring.startHint")}
          value={status}
          onEnter={() => void toggle()}
          autoFocus
          trailing="none"
          disabled={!!pending}
        />
        {armed && st?.name ? <InfoRow label={t("mirroring.lookFor")} value={st.name} /> : null}
      </Group>
      {error ? <Note tone="warn">{error}</Note> : null}
      {willGoOffline && !armed ? <Note tone="warn">{t("mirroring.offlineWarning")}</Note> : null}
      {armed && willGoOffline ? <Note tone="warn">{t("mirroring.offlineNow")}</Note> : null}
      <Note>{armed ? t("mirroring.armedNote") : t("mirroring.note")}</Note>
    </SettingsPage>
  );
}
