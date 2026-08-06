import { useEffect, useState } from "react";
import type { IrAction, IrBackend } from "@sdk/config";
import { useI18n } from "../../lib/i18n";
import { useConfigStore } from "../../stores/config";
import { sendIr, fetchIrStatus, type IrStatus } from "../../lib/ir";
import { SettingsPage } from "../SettingsPage";
import { ChoicePage } from "../ChoicePage";
import { Group, Note, Row, TextRow } from "../Rows";
import { useSettingsNav } from "../nav";
import { invalidateSummary } from "../summary";

// Settings -> Remotes & accessories -> TV volume: a network IR blaster for a TV
// that takes no volume over CEC (shell ir.js). Two backends - an ESPHome
// transceiver over its native API, or Home Assistant scripts, which covers
// Broadlink and friends.
//
// Every row saves immediately and the shell reconnects; secrets are write-only, so
// an empty submit keeps the stored value (TextRow already does that).
//
// The command mapping is TYPED, not picked from a list, and that is not an oversight.
// `/tvbox/api/ir/status` reports `actions` as the keys of the mapping the box already
// has (shell/ir.js), NOT the signal options the device offers - so a picker built from
// it would offer the three command names as if they were signal slots, and would
// appear the moment the first mapping was saved, locking out the typing that is the
// only way to enter a real slot name.
const ACTIONS: IrAction[] = ["volume_up", "volume_down", "mute"];

export function IrPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const config = useConfigStore((s) => s.config);
  const setIr = useConfigStore((s) => s.setIr);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<IrStatus | null>(null);
  const [tested, setTested] = useState<{ action: IrAction; ok: boolean; error?: string } | null>(null);

  const ir = config?.ir;
  const backend: IrBackend = ir?.backend || "esphome";
  const es = ir?.esphome;
  const ha = ir?.homeassistant;
  const actions = (backend === "esphome" ? es?.actions : ha?.actions) || {};

  useEffect(() => {
    let alive = true;
    void fetchIrStatus().then((s) => alive && setStatus(s));
    invalidateSummary("ir");
    return () => {
      alive = false;
    };
  }, [config?.ir, tested]);

  // Full-block saves: the shell replaces the block from what we send, except
  // secrets, where "" means "keep the stored one".
  const saveEs = async (patch: Record<string, unknown>) => {
    setFailed(false);
    try {
      await setIr({
        esphome: {
          host: es?.host ?? "",
          port: es?.port ?? null,
          encryptionKey: "",
          select: es?.select || "signal_select",
          button: es?.button || "send",
          actions: es?.actions || {},
          ...patch,
        },
      });
    } catch {
      setFailed(true);
    }
  };
  const saveHa = async (patch: Record<string, unknown>) => {
    setFailed(false);
    try {
      await setIr({ homeassistant: { url: ha?.url ?? "", token: "", actions: ha?.actions || {}, ...patch } });
    } catch {
      setFailed(true);
    }
  };
  const saveAction = (a: IrAction, value: string) => {
    const next = { ...actions, [a]: value }; // "" is dropped by the shell = unmapped
    return backend === "esphome" ? saveEs({ actions: next }) : saveHa({ actions: next });
  };

  const test = async (a: IrAction) => {
    setTested(null);
    const r = await sendIr(a);
    setTested({ action: a, ok: r.ok, error: r.error });
  };

  const pushBackendPicker = () =>
    nav.push({
      id: "ir-backend",
      title: t("ir.backendTitle"),
      render: () => (
        <ChoicePage
          id="ir-backend"
          title={t("ir.backendTitle")}
          options={(["esphome", "homeassistant"] as IrBackend[]).map((b) => ({ id: b, label: t("ir.backend." + b) }))}
          value={backend}
          onPick={(b) => {
            setFailed(false);
            setIr({ backend: b as IrBackend }).catch(() => setFailed(true));
          }}
        />
      ),
    });

  return (
    <SettingsPage id="ir" title={t("ir.title")} subtitle={t("ir.hint")} onBack={nav.pop} animate="push">
      {failed && <Note tone="warn">{t("ir.saveFailed")}</Note>}
      {status && status.connected === false && status.lastError ? (
        <Note tone="warn">{t("ir.disconnected", { error: status.lastError })}</Note>
      ) : null}
      {tested ? (
        <Note tone={tested.ok ? "ok" : "warn"}>
          {tested.ok ? t("ir.testOk") : t("ir.testFailed", { error: tested.error || "" })}
        </Note>
      ) : null}
      <Note>{t("ir.offHint")}</Note>

      <Group>
        <Row
          id="backend"
          label={t("ir.backendTitle")}
          value={t("ir.backend." + backend)}
          autoFocus
          onEnter={pushBackendPicker}
        />
      </Group>

      {backend === "esphome" ? (
        <Group title={t("ir.groupDevice")}>
          <TextRow
            id="host"
            label={t("ir.host")}
            title={t("ir.host")}
            value={es?.host}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => void saveEs({ host: v.trim() })}
          />
          <TextRow
            id="port"
            label={t("ir.port")}
            title={t("ir.port")}
            value={es?.port ? String(es.port) : ""}
            emptyLabel={t("ir.portDefault")}
            onSubmit={(v) => {
              const n = /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : NaN;
              void saveEs({ port: n >= 1 && n <= 65535 ? n : null }); // blank or junk = the default
            }}
          />
          <TextRow
            id="key"
            label={t("ir.encryptionKey")}
            title={t("ir.encryptionKey")}
            secret
            hasSecret={!!es?.hasEncryptionKey}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => v && void saveEs({ encryptionKey: v })}
          />
          <TextRow
            id="select"
            label={t("ir.selectEntity")}
            title={t("ir.selectEntity")}
            value={es?.select}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => void saveEs({ select: v.trim() })}
          />
          <TextRow
            id="button"
            label={t("ir.buttonEntity")}
            title={t("ir.buttonEntity")}
            value={es?.button}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => void saveEs({ button: v.trim() })}
          />
        </Group>
      ) : (
        <Group title={t("ir.groupDevice")}>
          <TextRow
            id="haurl"
            label={t("ir.haUrl")}
            title={t("ir.haUrl")}
            value={ha?.url}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => void saveHa({ url: v.trim() })}
          />
          <TextRow
            id="hatoken"
            label={t("ir.haToken")}
            title={t("ir.haToken")}
            secret
            hasSecret={!!ha?.hasToken}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => v && void saveHa({ token: v })}
          />
        </Group>
      )}

      <Group
        title={t("ir.actionsTitle")}
        hint={backend === "esphome" ? t("ir.actionsHintEsphome") : t("ir.actionsHintHa")}
      >
        {ACTIONS.map((a) => (
          <TextRow
            key={a}
            id={"map-" + a}
            label={t("ir.action." + a)}
            title={t("ir.action." + a)}
            value={actions[a]}
            emptyLabel={t("ir.notSet")}
            onSubmit={(v) => void saveAction(a, v.trim())}
          />
        ))}
      </Group>

      <Group title={t("ir.groupTest")}>
        {ACTIONS.map((a) => (
          <Row
            key={a}
            id={"test-" + a}
            label={t("ir.test") + " · " + t("ir.action." + a)}
            trailing="none"
            disabled={!actions[a]}
            onEnter={() => void test(a)}
          />
        ))}
      </Group>
    </SettingsPage>
  );
}
