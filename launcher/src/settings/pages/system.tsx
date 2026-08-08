import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, AVAILABLE_LOCALES } from "../../lib/i18n";
import { useConfigStore } from "../../stores/config";
import { fetchSystemInfo, setHostname } from "../../lib/system";
import { fetchRegion, type RegionInfo } from "../../lib/region";
import { fetchUpdateStatus, checkUpdate, applyUpdate, type UpdateStatus } from "../../lib/update";
import { power } from "../../lib/power";
import { PinPad } from "@sdk/PinPad";
import { PinGate } from "@sdk/PinGate";
import { TimezonePicker } from "../../components/TimezonePicker";
import { KeymapPicker, keymapLabel } from "../../components/KeymapPicker";
import { BackupSettings } from "../../components/BackupSettings";
import { DevToolsPage } from "./devtools";
import { SettingsPage } from "../SettingsPage";
import { ChoicePage } from "../ChoicePage";
import { Group, InfoRow, Note, Row, TextRow, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";
import { useSummary, invalidateSummary } from "../summary";

// Settings -> System. This is where the old "General" category went: the language,
// the region, the box's name. They belong next to updates and the backup because
// they are all things about the BOX rather than about what it is showing.
const UPDATE_POLL_MS = 3000;
const DASH = "-";

// Survive the pane remounting when the rail moves: what the box was renamed to, and
// whether it refused to apply it until the next update. Both are about THIS box for
// the rest of the session, not about this mount.
let renamedTo: string | null = null;
let hostnameDeferred = false;

// One RFC-1123 label: letters, digits, hyphen, no leading or trailing hyphen, <=63.
// Hyphens are trimmed AFTER truncating (like the firstboot sanitiser), so a cut at
// 63 cannot leave a trailing hyphen that the shell's validator would reject.
const cleanHostname = (v: string) =>
  v
    .replace(/[^A-Za-z0-9-]/g, "")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");

function LanguagePage() {
  const { t, locale, setLocale } = useI18n();
  return (
    <ChoicePage
      id="language"
      title={t("settings.language")}
      options={AVAILABLE_LOCALES.map((l) => ({ id: l.id, label: l.name }))}
      value={locale || ""}
      onPick={setLocale}
    />
  );
}

// The timezone and keymap pickers are their own long, searchable lists with their own
// focus handling, so they keep their components and only gain the page frame. Policy
// "legacy": their focusables are not marked rows, so the page becomes a focus
// container and the focus is put on that, and spatial navigation descends into it.
function PickerPage({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  return (
    <SettingsPage id={id} title={title} onBack={nav.pop} animate="push" focusPolicy="legacy">
      {/* The keyboardless fallback, and it is load-bearing: both pickers focus their
          own list only after the box answers with the zone or layout list, and RETURN
          on a failed read. Without a control that exists from the first frame, a picker
          whose read fails has nothing focusable at all. Deliberately first, so it is
          what the container's descent lands on until the list arrives. */}
      <Group>
        <Row id="cancel" label={t("power.cancel")} trailing="none" onEnter={nav.pop} />
      </Group>
      <div className="h-[58vh]">{children}</div>
    </SettingsPage>
  );
}

function RegionPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [info, setInfo] = useState<RegionInfo | null>(null);
  const hourFormat = useConfigStore((s) => s.config?.ui.hourFormat) || "auto";
  const setUi = useConfigStore((s) => s.setUi);

  const load = useCallback(() => {
    invalidateSummary("region");
    void fetchRegion().then((r) => r && setInfo(r));
  }, []);
  useEffect(load, [load]);

  const hourLabel = (v: string) =>
    v === "12" ? t("region.hourFormat_12") : v === "24" ? t("region.hourFormat_24") : t("region.hourFormat_auto");

  return (
    <SettingsPage id="region" title={t("region.regionTitle")} onBack={nav.pop} animate="push">
      <Group>
        <Row
          id="tz"
          label={t("region.timezone")}
          value={info?.timezone || DASH}
          autoFocus
          onEnter={() =>
            nav.push({
              id: "tz",
              title: t("region.timezone"),
              render: () => (
                <PickerPage id="tz" title={t("region.timezone")}>
                  {/* No onChange: this page is unmounted while the picker is up, so the
                      callback would write to nothing. The value is re-read on remount. */}
                  <TimezonePicker autoFocus />
                </PickerPage>
              ),
            })
          }
        />
        <Row
          id="km"
          label={t("region.keyboard")}
          value={info?.keymap ? keymapLabel(t, info.keymap) : DASH}
          onEnter={() =>
            nav.push({
              id: "km",
              title: t("region.keyboard"),
              render: () => (
                <PickerPage id="km" title={t("region.keyboard")}>
                  <KeymapPicker autoFocus />
                </PickerPage>
              ),
            })
          }
        />
        <Row
          id="hour"
          label={t("region.hourFormat")}
          value={hourLabel(hourFormat)}
          onEnter={() =>
            nav.push({
              id: "hour",
              title: t("region.hourFormat"),
              render: () => (
                <ChoicePage
                  id="hour"
                  title={t("region.hourFormat")}
                  options={["auto", "12", "24"].map((v) => ({ id: v, label: hourLabel(v) }))}
                  value={hourFormat}
                  onPick={(v) => setUi({ hourFormat: v as "auto" | "12" | "24" })}
                />
              ),
            })
          }
        />
      </Group>
    </SettingsPage>
  );
}

// The box has ONE central PIN (stored salted + hashed by the shell); every app
// checks it through the SDK, so setting it here covers an app's locked content too.
// This page manages the PIN itself - what gets locked lives in each app's settings.
function ParentalPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const pinSet = useConfigStore((s) => !!s.config?.parental.pinSet);
  const requirePin = useConfigStore((s) => !!s.config?.parental.requirePin);
  const saveParental = useConfigStore((s) => s.setParental);
  const [step, setStep] = useState<null | "verify-change" | "verify-clear" | "new" | "confirm">(null);
  const [firstPin, setFirstPin] = useState("");
  const [confirmError, setConfirmError] = useState<string | undefined>();
  const [msg, setMsg] = useState("");

  const done = (message: string) => {
    setStep(null);
    setFirstPin("");
    setConfirmError(undefined);
    setMsg(message);
  };

  if (step === "verify-change") return <PinGate onSuccess={() => setStep("new")} onCancel={() => done("")} />;
  if (step === "verify-clear")
    return (
      <PinGate
        onSuccess={async () => {
          await saveParental({ pin: "" });
          done(t("parental.cleared"));
        }}
        onCancel={() => done("")}
      />
    );
  if (step === "new")
    return (
      <PinPad
        title={t("parental.newPin")}
        onCancel={() => done("")}
        onSubmit={(pin: string) => {
          setFirstPin(pin);
          setConfirmError(undefined);
          setStep("confirm");
        }}
      />
    );
  if (step === "confirm")
    return (
      <PinPad
        title={t("parental.confirmPin")}
        error={confirmError}
        onCancel={() => done("")}
        onSubmit={async (pin: string) => {
          if (pin !== firstPin) {
            setConfirmError(t("parental.mismatch"));
            return;
          }
          await saveParental({ pin });
          done(t("parental.saved"));
        }}
      />
    );

  return (
    <SettingsPage
      id="parental"
      title={t("parental.title")}
      subtitle={t("parental.hint")}
      onBack={nav.pop}
      animate="push"
    >
      {msg && <Note tone="ok">{msg}</Note>}
      {!pinSet ? (
        <Group>
          <Row id="set" label={t("parental.set")} trailing="none" autoFocus onEnter={() => setStep("new")} />
        </Group>
      ) : (
        <>
          <Group>
            <ToggleRow
              id="require"
              label={t("parental.require")}
              hint={t("parental.requireHint")}
              on={requirePin}
              onToggle={() => void saveParental({ requirePin: !requirePin })}
              onWord={t("common.on")}
              offWord={t("common.off")}
            />
          </Group>
          <Group>
            {/* The flow returns here by remounting this page, so whatever is marked is
                where the next OK press lands. It must not be the child lock: coming back
                from a cancelled PIN change and pressing OK would switch it off. */}
            <Row
              id="change"
              label={t("parental.change")}
              trailing="none"
              autoFocus
              onEnter={() => setStep("verify-change")}
            />
            <Row id="clear" label={t("parental.clear")} trailing="none" onEnter={() => setStep("verify-clear")} />
          </Group>
        </>
      )}
    </SettingsPage>
  );
}

function UpdatePage() {
  const { t, locale } = useI18n();
  const nav = useSettingsNav();
  const config = useConfigStore((s) => s.config);
  const setUpdate = useConfigStore((s) => s.setUpdate);
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const refresh = () => {
      invalidateSummary("update");
      void fetchUpdateStatus().then((s) => s && alive.current && setSt(s));
    };
    refresh();
    // Live while a download or install runs, and only while this page is open - it
    // used to tick for as long as anyone was anywhere in the System category.
    const iv = setInterval(refresh, UPDATE_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(iv);
    };
  }, []);

  const working = !!st && st.state !== "idle" && st.state !== "error";
  const auto = config?.update.auto ?? true;
  const appsAuto = config?.update.appsAuto ?? true;

  // The most relevant thing, in order.
  const statusLine = !st
    ? DASH
    : st.state === "checking"
      ? t("update.checking")
      : st.state === "downloading"
        ? t("update.downloading")
        : st.state === "installing"
          ? t("update.installing")
          : st.state === "restarting"
            ? t("update.restarting")
            : st.state === "error"
              ? t("update.error")
              : st.available && st.latest
                ? t("update.available", { version: st.latest.version })
                : st.unmet?.length && st.latest
                  ? t("update.needsReprovision", { version: st.latest.version })
                  : t("update.upToDate");

  const notes =
    st?.available && st.latest?.notes
      ? st.latest.notes[(locale || "en") as "en" | "hu"] || st.latest.notes.en || ""
      : "";
  const lastUpdated = st?.last
    ? new Date(st.last.at).toLocaleDateString(locale || undefined) + " (" + st.last.from + " → " + st.last.to + ")"
    : t("update.never");

  return (
    <SettingsPage id="update" title={t("update.title")} onBack={nav.pop} animate="push">
      <Note tone={st?.state === "error" ? "warn" : st?.available ? "accent" : "dim"}>{statusLine}</Note>
      {st?.state === "error" && st.error ? <Note>{st.error}</Note> : null}
      {st?.failed && <Note tone="warn">{t("update.failedRollback", { version: st.failed.to })}</Note>}
      {notes && (
        // Release notes are written as lines and can be long: without pre-line they
        // collapse into a paragraph, and without a cap they push the rows off screen.
        <p className="text-[1.8vh] text-fg-dim leading-snug mb-[1.6vh] px-[0.4vw] max-w-[52vw] whitespace-pre-line max-h-[24vh] overflow-y-auto no-scrollbar">
          {notes}
        </p>
      )}

      <Group>
        <InfoRow label={t("update.current")} value={st ? st.current + (st.release ? "" : " (dev)") : DASH} />
        <InfoRow label={t("update.lastUpdated")} value={lastUpdated} />
        <Row
          id="check"
          label={t("update.check")}
          trailing="none"
          autoFocus
          disabled={working || busy}
          onEnter={async () => {
            setBusy(true);
            const s = await checkUpdate();
            if (!alive.current) return;
            if (s) setSt(s);
            setBusy(false);
          }}
        />
        {st?.available && !working && (
          <Row
            id="install"
            label={t("update.install")}
            hint={t("update.installHint")}
            trailing="none"
            disabled={busy}
            onEnter={async () => {
              setBusy(true);
              const s = await applyUpdate();
              if (!alive.current) return;
              if (s) setSt(s);
              setBusy(false);
            }}
          />
        )}
      </Group>

      <Group title={t("update.groupAuto")}>
        <ToggleRow
          id="auto"
          label={t("update.auto")}
          hint={t("update.autoHint")}
          on={auto}
          onToggle={() => void setUpdate({ auto: !auto })}
          onWord={t("common.on")}
          offWord={t("common.off")}
        />
        <ToggleRow
          id="apps-auto"
          label={t("update.appsAuto")}
          hint={t("update.appsAutoHint")}
          on={appsAuto}
          onToggle={() => void setUpdate({ appsAuto: !appsAuto })}
          onWord={t("common.on")}
          offWord={t("common.off")}
        />
      </Group>

      {/* The OS patches itself and NEVER reboots on its own; a restart is offered
          when the kernel asks for one, and it stays the user's call. */}
      {st?.os.rebootRequired && st.os.packages.length ? <Note>{st.os.packages.join(", ")}</Note> : null}
      <Group title={t("update.osTitle")} hint={t("update.osAuto")}>
        {st?.os.rebootRequired ? (
          <>
            <Row
              id="reboot"
              label={t("update.rebootNow")}
              hint={t("update.rebootNeeded")}
              trailing="none"
              onEnter={() => void power("reboot")}
            />
          </>
        ) : (
          <InfoRow label={t("update.rebootNone")} value="" />
        )}
      </Group>
    </SettingsPage>
  );
}

function BackupPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  return (
    <SettingsPage id="backup" title={t("backup.title")} onBack={nav.pop} animate="push" focusPolicy="legacy">
      <BackupSettings />
    </SettingsPage>
  );
}

export function SystemPane() {
  const { t, locale } = useI18n();
  const nav = useSettingsNav();
  const info = useSummary("sysinfo", fetchSystemInfo);
  const region = useSummary("region", fetchRegion);
  const update = useSummary("update", fetchUpdateStatus);
  const pinSet = useConfigStore((s) => !!s.config?.parental.pinSet);
  // Seeded from the module-level flag (see renamedTo / hostnameDeferred above), which
  // is what survives this pane remounting on every move of the rail.
  const [deferred, setDeferred] = useState(hostnameDeferred);
  const hostname = renamedTo ?? info?.hostname ?? "";
  const langLabel = AVAILABLE_LOCALES.find((l) => l.id === locale)?.name || locale || DASH;

  return (
    <SettingsPage id="system" focusPolicy="rail">
      {deferred && <Note tone="warn">{t("hostname.later")}</Note>}
      <Group>
        <TextRow
          id="hostname"
          label={t("hostname.title")}
          hint={t("hostname.hint")}
          title={t("hostname.title")}
          value={hostname}
          emptyLabel={DASH}
          onSubmit={async (v) => {
            const next = cleanHostname(v);
            if (!next || next === hostname) return;
            renamedTo = next; // reflect immediately, even if the box refuses the write
            const ok = await setHostname(next);
            hostnameDeferred = !ok;
            setDeferred(!ok);
            // Only after the write: invalidating first lets a remount in the gap
            // re-read the OLD name and put it back on screen.
            invalidateSummary("sysinfo");
          }}
        />
        <Row
          id="language"
          label={t("settings.language")}
          value={langLabel}
          onEnter={() => nav.push({ id: "language", title: t("settings.language"), render: () => <LanguagePage /> })}
        />
        <Row
          id="region"
          label={t("region.regionTitle")}
          hint={t("region.regionHint")}
          value={region?.timezone}
          onEnter={() => nav.push({ id: "region", title: t("region.regionTitle"), render: () => <RegionPage /> })}
        />
      </Group>

      <Group>
        <Row
          id="parental"
          label={t("parental.title")}
          hint={t("parental.hint")}
          value={pinSet ? t("parental.pinSet") : t("parental.pinNotSet")}
          onEnter={() => nav.push({ id: "parental", title: t("parental.title"), render: () => <ParentalPage /> })}
        />
      </Group>

      <Group>
        <Row
          id="update"
          label={t("update.title")}
          hint={t("system.updateHint")}
          // `available` is false for a release whose requirements the box cannot meet,
          // so "up to date" would be wrong exactly when there IS something waiting.
          value={
            !update
              ? undefined
              : update.available
                ? t("update.availableShort")
                : update.unmet?.length
                  ? t("update.needsSetup")
                  : t("update.upToDate")
          }
          onEnter={() => nav.push({ id: "update", title: t("update.title"), render: () => <UpdatePage /> })}
        />
        <Row
          id="backup"
          label={t("backup.title")}
          hint={t("system.backupHint")}
          onEnter={() => nav.push({ id: "backup", title: t("backup.title"), render: () => <BackupPage /> })}
        />
      </Group>
      {/* Last, and its own group: nothing behind this door is for someone
          watching television. */}
      <Group>
        <Row
          id="dev"
          label={t("system.devTools")}
          hint={t("system.devToolsHint")}
          onEnter={() =>
            nav.push({ id: "dev", title: t("dev.title"), render: () => <DevToolsPage onBack={nav.pop} /> })
          }
        />
      </Group>
    </SettingsPage>
  );
}
