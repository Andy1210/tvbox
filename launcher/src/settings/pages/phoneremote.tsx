import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../../lib/i18n";
import { useBackspace } from "../../lib/useBackspace";
import {
  armPhoneRemote,
  disarmPhoneRemote,
  fetchPhoneRemote,
  forgetPhone,
  setPhoneRemoteEnabled,
  type PairedPhone,
} from "../../lib/phoneremote";
import { FocusButton } from "../../components/FocusButton";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row, rowKey, usePageId } from "../Rows";
import { invalidateSummary } from "../summary";

// Settings -> Remotes and devices -> Phone as a remote.
//
// The one page in Settings that opens a door: everything else here changes what
// the box does, and this decides whether something outside the box may press its
// buttons. So it says what it is turning on, in those terms, and every paired
// phone is a row that can be removed - a permission you cannot see is one you
// cannot withdraw.
//
// Turning it off forgets the phones as well. Leaving them would mean a list that
// silently comes back to life the next time the switch is flipped, which is not
// what "off" reads as.

// While the QR is up, the box is waiting for a phone: the list is polled so the
// screen reacts to the pairing rather than to the next press.
const POLL_MS = 1500;

function PairOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({
    focusKey: "pr-pair",
    focusable: false,
    isFocusBoundary: true,
    saveLastFocusedChild: true,
  });
  const [info, setInfo] = useState<{ shortUrl: string; code: string } | null>(null);
  const [qr, setQr] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void armPhoneRemote().then(async (d) => {
      if (!alive) return;
      if (!d.ok || !d.url) return setFailed(true);
      setInfo({ shortUrl: d.shortUrl || "", code: d.code || "" });
      try {
        setQr(await QRCode.toDataURL(d.url, { width: 480, margin: 1 }));
      } catch {
        /* the address and the code are still on screen */
      }
    });
    // The code is good for five minutes, but leaving this screen is an answer
    // sooner than that: a code nobody is looking at should not still work.
    return () => {
      alive = false;
      void disarmPhoneRemote();
    };
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setFocus("pr-pair-done"), 0);
    return () => clearTimeout(id);
  }, []);
  useBackspace(onClose);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-[55] bg-black/90 flex flex-col items-center justify-center gap-[2.2vh] px-[6vw] text-center"
      >
        <div className="text-[3vh] font-bold">{t("phoneRemote.pairTitle")}</div>
        <div className="text-[2vh] text-fg-dim max-w-[62vw]">{t("phoneRemote.pairHint")}</div>
        {failed ? (
          <div className="text-[2.2vh] text-warn">{t("phoneRemote.pairFailed")}</div>
        ) : qr ? (
          <>
            <img src={qr} alt="QR" className="w-[30vh] h-[30vh] rounded-[1.4vh] bg-white p-[1vh]" />
            <div className="text-[2.2vh] font-semibold tabular-nums">{info?.shortUrl}</div>
            <div className="text-[2vh] text-fg-dim">
              {t("phoneRemote.code")}:{" "}
              <span className="font-bold text-fg tabular-nums tracking-[0.3vw]">{info?.code}</span>
            </div>
          </>
        ) : (
          <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
        )}
        <FocusButton
          focusKey="pr-pair-done"
          onEnter={onClose}
          className="px-[3vw] py-[1.6vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold"
        >
          {t("phoneRemote.done")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}

// A time a person reads, not a timestamp. "Never" is a real answer here: a phone
// that paired and was never used again is exactly the row worth removing.
function seenText(t: (k: string, v?: Record<string, string | number>) => string, at: number | null): string {
  if (!at) return t("phoneRemote.neverUsed");
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 2) return t("phoneRemote.seenNow");
  if (mins < 60) return t("phoneRemote.seenMinutes", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("phoneRemote.seenHours", { n: hours });
  return t("phoneRemote.seenDays", { n: Math.floor(hours / 24) });
}

export function PhoneRemotePage() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [phones, setPhones] = useState<PairedPhone[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "unsupported" | "error">("loading");
  const [pairing, setPairing] = useState(false);
  const busy = useRef(false);
  const page = usePageId();

  const load = useCallback(async () => {
    const r = await fetchPhoneRemote();
    setStatus(r.kind);
    if (r.kind !== "ok") return;
    setEnabled(r.state.enabled);
    setPhones(r.state.phones);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Only while the QR is up. Nothing else here changes without a press, and a
  // settings page that polls for no reason is one more thing running behind a
  // film.
  useEffect(() => {
    if (!pairing) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [pairing, load]);

  const toggle = async () => {
    if (busy.current) return;
    busy.current = true;
    const want = !enabled;
    const r = await setPhoneRemoteEnabled(want);
    busy.current = false;
    if (r.ok) {
      setEnabled(want);
      setPhones(r.phones || []);
      invalidateSummary("phoneremote"); // the row on the page behind this shows it too
    }
  };

  const forget = async (id: string) => {
    if (busy.current) return;
    busy.current = true;
    const r = await forgetPhone(id);
    busy.current = false;
    if (r.ok) {
      setPhones(r.phones || []);
      invalidateSummary("phoneremote"); // the row behind this one counts them
    }
  };

  // A box whose shell has no such route is told so; anything else is a retry,
  // because a blip must never read as "your box is too old".
  if (status === "unsupported") {
    return (
      <Group>
        <Note tone="warn">{t("phoneRemote.unsupported")}</Note>
      </Group>
    );
  }
  if (status === "error") {
    return (
      <Group>
        <Row id="retry" label={t("phoneRemote.retry")} onEnter={() => void load()} autoFocus trailing="none" />
        <Note tone="warn">{t("phoneRemote.unreachable")}</Note>
      </Group>
    );
  }

  const list = phones || [];
  return (
    <>
      <Group>
        <Row
          id="enable"
          label={t("phoneRemote.enable")}
          hint={t("phoneRemote.enableHint")}
          value={enabled ? t("phoneRemote.on") : t("phoneRemote.off")}
          onEnter={() => void toggle()}
          autoFocus
          trailing="none"
        />
        {enabled ? (
          <Row
            id="pair"
            label={t("phoneRemote.pair")}
            hint={t("phoneRemote.pairRowHint")}
            onEnter={() => setPairing(true)}
            trailing="none"
          />
        ) : null}
      </Group>

      {enabled && list.length ? (
        <Group title={t("phoneRemote.paired")}>
          {list.map((p) => (
            <Row
              key={p.id}
              id={"phone-" + p.id}
              label={p.name}
              hint={seenText(t, p.lastSeenAt)}
              value={t("phoneRemote.forget")}
              onEnter={() => void forget(p.id)}
              trailing="none"
            />
          ))}
        </Group>
      ) : null}
      {enabled && !list.length ? <InfoRow label={t("phoneRemote.paired")} value={t("phoneRemote.nonePaired")} /> : null}

      <Note tone={enabled ? "warn" : "dim"}>{enabled ? t("phoneRemote.onNote") : t("phoneRemote.note")}</Note>
      {pairing ? (
        <PairOverlay
          onClose={() => {
            setPairing(false);
            void load();
            // Put the cursor back on the row that opened this. The overlay's
            // focusables go in one commit with nothing left to inherit from, and
            // a page whose D-pad lands nowhere is the one state a remote cannot
            // get out of. After the unmount, hence the timeout.
            setTimeout(() => setFocus(rowKey(page, "pair")), 0);
          }}
        />
      ) : null}
    </>
  );
}

// The page as Settings pushes it, so the caller does not have to know it needs a
// title and a Back.
export function PhoneRemoteSubPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <SettingsPage id="phoneremote" title={t("phoneRemote.title")} onBack={onBack} animate="push">
      <PhoneRemotePage />
    </SettingsPage>
  );
}
