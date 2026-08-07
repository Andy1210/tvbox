import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchMirroring, startMirroring, stopMirroring, type MirrorStatus } from "../../lib/api";
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

export function MirroringPage() {
  const { t } = useI18n();
  const [st, setSt] = useState<MirrorStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const toggle = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    const armed = !!st?.armed;
    const r = armed ? await stopMirroring() : await startMirroring();
    busy.current = false;
    // The box refuses for one reason worth reading - its radio is carrying its
    // own network - so the sentence it sends is shown rather than a generic
    // failure. Someone holding only a remote cannot go and look in a log.
    if (!r.ok) setError(r.error || t("mirroring.err.unknown"));
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
  const status = streaming ? t("mirroring.streaming") : armed ? t("mirroring.waiting") : t("mirroring.off");

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
        />
        {armed && st?.name ? <InfoRow label={t("mirroring.lookFor")} value={st.name} /> : null}
      </Group>
      {error ? <Note tone="warn">{error}</Note> : null}
      <Note>{armed ? t("mirroring.armedNote") : t("mirroring.note")}</Note>
    </SettingsPage>
  );
}
