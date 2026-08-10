import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import {
  fetchAppShares,
  saveAppShares,
  scanForBoxes,
  pairWithBox,
  forgetBox,
  type AppSharesStatus,
} from "../../lib/api";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row, TextRow, ToggleRow } from "../Rows";
import { invalidateSummary } from "../summary";

// Settings -> Network -> App sharing: what this box lets another box read.
//
// This screen is deliberately about NOTHING in particular. An emulator's saves is
// the first use anyone will have for it, but the shell must not know that: the box
// is a platform, most of its apps are optional, and Settings is not the place to
// learn what "continue in the other room" means. So this page is the permission
// surface only - which app offers which of its folders, on or off, and which boxes
// have been let in. The action, and the words for it, belong to the app: it gets
// there through the `shares` capability, scoped to its own shares.
//
// The two halves of connecting are asymmetric on purpose, because only one of them
// needs a person at the TV. The box that HAS the files shows a four-digit code; the
// box that wants them sweeps the LAN for whoever is showing one. That is why there
// is nothing to type but the code - no addresses, no passwords.
const CODE_LEN = 4;
// pairing/index.js TTL_MS - how long the code on screen is worth anything.
const PAIRING_TTL_MS = 5 * 60 * 1000;

// The box's error codes are a moving set behind a dynamic locale prefix, so the
// parity test cannot catch one with no sentence behind it. translate() hands back
// the key it could not find, which reads as gibberish on a TV.
function errText(t: (k: string) => string, code: string): string {
  const key = "appshares.err." + code;
  const msg = t(key);
  return msg === key ? t("appshares.err.unknown") : msg;
}

export function AppSharesPage() {
  const { t, locale } = useI18n();
  const [st, setSt] = useState<AppSharesStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [code, setCode] = useState<string | null>(null); // this box's own code, while it is offering
  const [found, setFound] = useState<{ host: string }[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [picked, setPicked] = useState<string | null>(null); // the host being paired with
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const load = useCallback(async () => {
    const s = await fetchAppShares();
    setUnreachable(!s);
    if (s) setSt(s);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const shares = st?.shares || [];
  const peers = st?.peers || [];
  const saving = useRef(false);
  const onToggle = async (id: string) => {
    // One write at a time: two quick presses otherwise leave two in flight, and the
    // first answer replaces the state with a snapshot taken before the second.
    if (saving.current) return;
    saving.current = true;
    const next = shares.filter((s) => (s.id === id ? !s.on : s.on)).map((s) => s.id);
    setSt((s) => s && { ...s, shares: s.shares.map((x) => (x.id === id ? { ...x, on: !x.on } : x)) });
    invalidateSummary("appshares");
    const r = await saveAppShares(next);
    saving.current = false;
    if (!r.ok && r.error) setMsg({ tone: "warn", text: errText(t, r.error) });
    await load();
  };

  // Offering: the code goes on the screen and the other box asks for it. The
  // pairing server stops itself after five minutes, so there is nothing to undo.
  const offer = async () => {
    setMsg(null);
    try {
      const d = await (
        await fetch("/tvbox/api/pairing/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale, kind: "peer" }),
        })
      ).json();
      if (d && d.code) {
        setCode(String(d.code));
        // The pairing server stops itself after five minutes (and as soon as a box
        // has taken the token), so the code stops being true without anything
        // telling this page. Put the action back rather than leave a dead number
        // on screen that a second box can never use.
        setTimeout(() => setCode(null), PAIRING_TTL_MS);
      } else setMsg({ tone: "warn", text: t("appshares.err.unknown") });
    } catch {
      setMsg({ tone: "warn", text: t("appshares.err.unknown") });
    }
  };

  const scan = async () => {
    setScanning(true);
    setMsg(null);
    setPicked(null);
    const r = await scanForBoxes();
    setScanning(false);
    // A sweep that FAILED is not a sweep that found nothing: showing the empty
    // result would tell the user to go and start the other box, which is not the
    // problem they have.
    if (!r.ok) {
      setFound(null);
      setMsg({ tone: "warn", text: errText(t, r.error || "unknown") });
      return;
    }
    setFound(r.found || []);
  };

  const pair = async (host: string, entered: string) => {
    const digits = entered.replace(/\D/g, "").slice(0, CODE_LEN);
    if (digits.length !== CODE_LEN) return;
    const r = await pairWithBox(host, digits);
    if (r.ok) {
      setFound(null);
      setPicked(null);
      setMsg({ tone: "ok", text: t("appshares.paired").replace("{name}", r.peer?.name || host) });
      await load();
    } else {
      setMsg({ tone: "warn", text: errText(t, r.error || "unknown") });
    }
  };

  if (unreachable) {
    return (
      <SettingsPage id="appshares" title={t("appshares.title")}>
        <Group>
          <Note tone="warn">{t("appshares.unreachable")}</Note>
          <Row id="retry" label={t("appshares.retry")} trailing="none" autoFocus onEnter={() => void load()} />
        </Group>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage id="appshares" title={t("appshares.title")}>
      {msg && <Note tone={msg.tone === "ok" ? "ok" : "warn"}>{msg.text}</Note>}

      <Group title={t("appshares.offering")} hint={t("appshares.offeringHint")}>
        {shares.length === 0 && <Note>{t("appshares.nothingToOffer")}</Note>}
        {shares.map((s, i) => (
          <ToggleRow
            key={s.id}
            id={"share-" + s.id}
            label={s.appName + " - " + s.name}
            // A folder an app has not written to yet is still listed: it appears the
            // moment the app saves something, and hiding it would read as a bug.
            hint={s.present ? undefined : t("appshares.notYet")}
            on={s.on}
            onToggle={() => void onToggle(s.id)}
            onWord={t("common.on")}
            offWord={t("common.off")}
            autoFocus={i === 0}
            disabled={!st?.rclone || !s.present}
          />
        ))}
        {st && !st.rclone && <Note tone="warn">{t("appshares.noRclone")}</Note>}
        {/* Where the other half went. Without this the page reads as unfinished:
            it can switch sharing on and name the boxes, and then appears to do
            nothing with either. */}
        {shares.length > 0 && <Note>{t("appshares.inApp")}</Note>}
        {code ? (
          <InfoRow label={t("appshares.codeLabel")} value={code} />
        ) : (
          <Row
            id="offer"
            label={t("appshares.offer")}
            hint={t("appshares.offerHint")}
            trailing="none"
            disabled={!st?.running}
            onEnter={() => void offer()}
          />
        )}
      </Group>

      <Group title={t("appshares.boxes")} hint={t("appshares.boxesHint")}>
        {peers.map((p) => (
          <Row
            key={p.id}
            id={"peer-" + p.id}
            label={p.name}
            hint={p.host}
            value={t("appshares.forget")}
            trailing="none"
            onEnter={async () => {
              await forgetBox(p.id);
              await load();
            }}
          />
        ))}
        <Row
          id="scan"
          label={scanning ? t("appshares.scanning") : t("appshares.scan")}
          hint={t("appshares.scanHint")}
          trailing="none"
          disabled={scanning}
          onEnter={() => void scan()}
        />
        {found && found.length === 0 && <Note>{t("appshares.noneFound")}</Note>}
        {found?.map((f) =>
          picked === f.host ? (
            <TextRow
              key={f.host}
              id={"code-" + f.host}
              label={t("appshares.enterCode")}
              hint={f.host}
              title={t("appshares.enterCode")}
              onSubmit={(text) => void pair(f.host, text)}
              autoFocus
            />
          ) : (
            <Row
              key={f.host}
              id={"found-" + f.host}
              label={t("appshares.foundBox")}
              hint={f.host}
              trailing="none"
              onEnter={() => setPicked(f.host)}
            />
          ),
        )}
      </Group>
    </SettingsPage>
  );
}
