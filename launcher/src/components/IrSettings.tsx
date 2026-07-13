import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { IrAction, IrBackend } from "@sdk/config";
import { useI18n } from "../lib/i18n";
import { useConfigStore } from "../stores/config";
import { sendIr, fetchIrStatus, type IrStatus } from "../lib/ir";
import { FocusButton } from "./FocusButton";
import { Osk } from "./Osk";

// Settings → Peripherals: network IR blaster for TV volume/mute (shell ir.js).
// Two backends: an ESPHome IR transceiver driven directly over its native API
// (e.g. the Seeed XIAO Smart IR Mate), or Home Assistant scripts (which covers
// Broadlink & friends). Each row edits one field via the OSK and saves
// immediately - the shell reconnects on save. Secrets (encryption key / HA
// token) are write-only: the row shows "••••" and an empty OSK submit keeps
// the stored value. Clearing the host/URL clears that backend = integration off.

function Check() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-[2.2vh] h-[2.2vh] shrink-0 text-accent"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

const BACKENDS: IrBackend[] = ["esphome", "homeassistant"];
const ACTIONS: IrAction[] = ["volume_up", "volume_down", "mute"];
type EsField = "host" | "port" | "encryptionKey" | "select" | "button";
type HaField = "url" | "token";
// label keys spelled out literally so the locale dead-key scan sees them
const ES_FIELDS: { id: EsField; label: string }[] = [
  { id: "host", label: "ir.host" },
  { id: "port", label: "ir.port" },
  { id: "encryptionKey", label: "ir.encryptionKey" },
  { id: "select", label: "ir.selectEntity" },
  { id: "button", label: "ir.buttonEntity" },
];
const HA_FIELDS: { id: HaField; label: string }[] = [
  { id: "url", label: "ir.haUrl" },
  { id: "token", label: "ir.haToken" },
];
const ESPHOME_DEFAULT_PORT = 6053;

type Editing = { kind: "es"; field: EsField } | { kind: "ha"; field: HaField } | { kind: "action"; action: IrAction };

export function IrSettings() {
  const { t } = useI18n();
  const config = useConfigStore((s) => s.config);
  const setIr = useConfigStore((s) => s.setIr);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<IrStatus | null>(null);
  const [testResult, setTestResult] = useState<{ action: IrAction; ok: boolean; error?: string } | null>(null);

  const ir = config?.ir;
  const backend: IrBackend = ir?.backend || "esphome";
  const es = ir?.esphome;
  const ha = ir?.homeassistant;
  const actions = (backend === "esphome" ? es?.actions : ha?.actions) || {};

  // Backend health for the footer line (the esphome client reconnects on its
  // own; this just reflects it). Refreshed after every save/test.
  useEffect(() => {
    let alive = true;
    fetchIrStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, [config?.ir, testResult]);

  // Full-block saves, mirroring MqttSettings: the shell replaces the block from
  // what we send, except secrets, where "" means "keep the stored one".
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
  const saveBackend = async (b: IrBackend) => {
    setFailed(false);
    try {
      await setIr({ backend: b });
    } catch {
      setFailed(true);
    }
  };
  const saveAction = (a: IrAction, value: string) => {
    const next = { ...actions, [a]: value }; // "" is dropped by the shell = unmapped
    return backend === "esphome" ? saveEs({ actions: next }) : saveHa({ actions: next });
  };

  const test = async (a: IrAction) => {
    setTestResult(null);
    const r = await sendIr(a);
    setTestResult({ action: a, ok: r.ok, error: r.error });
  };

  // What the OSK starts from (saved value; secrets always start blank).
  const initial = (ed: Editing): string => {
    if (ed.kind === "action") return actions[ed.action] || "";
    if (ed.kind === "es") {
      if (!es || ed.field === "encryptionKey") return "";
      if (ed.field === "port") return es.port ? String(es.port) : "";
      return es[ed.field] || "";
    }
    if (!ha || ed.field === "token") return "";
    return ha[ed.field] || "";
  };
  const focusKeyOf = (ed: Editing) => "ir-" + (ed.kind === "action" ? "action-" + ed.action : ed.field);

  if (editing) {
    const ed = editing;
    const close = () => {
      setEditing(null);
      setTimeout(() => setFocus(focusKeyOf(ed)), 0);
    };
    const title =
      ed.kind === "action"
        ? t("ir.action." + ed.action)
        : t((ed.kind === "es" ? ES_FIELDS : HA_FIELDS).find((f) => f.id === ed.field)!.label);
    return (
      <Osk
        key={focusKeyOf(ed)}
        title={title}
        initial={initial(ed)}
        onDone={(v) => {
          close();
          const val = v.trim();
          if (ed.kind === "action") {
            void saveAction(ed.action, val);
          } else if (ed.kind === "es") {
            if (ed.field === "port") {
              const port = /^\d{1,5}$/.test(val) ? Number(val) : NaN;
              void saveEs({ port: port >= 1 && port <= 65535 ? port : null }); // blank/junk = default
            } else if (ed.field === "encryptionKey") {
              if (val) void saveEs({ encryptionKey: val }); // empty keeps the stored key
            } else {
              void saveEs({ [ed.field]: val });
            }
          } else if (ed.field === "token") {
            if (val) void saveHa({ token: val }); // empty keeps the stored token
          } else {
            void saveHa({ [ed.field]: val });
          }
        }}
        onCancel={close}
      />
    );
  }

  const esDisplay = (f: EsField): string => {
    if (!es || !es.host) return "";
    if (f === "encryptionKey") return es.hasEncryptionKey ? "••••" : "";
    if (f === "port") return String(es.port || ESPHOME_DEFAULT_PORT);
    return es[f] || "";
  };
  const haDisplay = (f: HaField): string => {
    if (!ha || !ha.url) return "";
    if (f === "token") return ha.hasToken ? "••••" : "";
    return ha[f] || "";
  };

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[0.6vh]">
        {t("ir.title")}
        <span className={["text-[1.9vh] ml-[1.2vw]", ir?.configured ? "text-accent" : "text-fg-dim"].join(" ")}>
          {ir?.configured ? t("ir.configured") : t("ir.notConfigured")}
        </span>
      </div>
      <div className="text-[1.9vh] text-fg-dim mb-[0.4vh] max-w-[70vw]">{t("ir.hint")}</div>
      <div className="text-[1.7vh] text-fg-dim mb-[1.4vh] max-w-[70vw]">{t("ir.offHint")}</div>
      {failed && <div className="text-[1.9vh] text-warn mb-[1vh] max-w-[70vw]">{t("ir.saveFailed")}</div>}

      <div className="text-[2.1vh] font-semibold mb-[0.8vh]">{t("ir.backendTitle")}</div>
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw] mb-[1.6vh]">
        {BACKENDS.map((b) => (
          <FocusButton
            key={b}
            focusKey={"ir-backend-" + b}
            onEnter={() => saveBackend(b)}
            className="px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
          >
            <span className="text-[2vh] flex-1 text-left truncate">{t("ir.backend." + b)}</span>
            {backend === b && <Check />}
          </FocusButton>
        ))}
      </div>

      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {backend === "esphome"
          ? ES_FIELDS.map((f) => (
              <FocusButton
                key={f.id}
                focusKey={"ir-" + f.id}
                onEnter={() => setEditing({ kind: "es", field: f.id })}
                className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
              >
                <span className="text-[2.1vh]">{t(f.label)}</span>
                <span className="text-[1.9vh] text-fg-dim tabular-nums truncate">{esDisplay(f.id) || "-"}</span>
              </FocusButton>
            ))
          : HA_FIELDS.map((f) => (
              <FocusButton
                key={f.id}
                focusKey={"ir-" + f.id}
                onEnter={() => setEditing({ kind: "ha", field: f.id })}
                className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
              >
                <span className="text-[2.1vh]">{t(f.label)}</span>
                <span className="text-[1.9vh] text-fg-dim truncate">{haDisplay(f.id) || "-"}</span>
              </FocusButton>
            ))}
      </div>

      <div className="text-[2.1vh] font-semibold mt-[2vh] mb-[0.4vh]">{t("ir.actionsTitle")}</div>
      <div className="text-[1.7vh] text-fg-dim mb-[0.8vh] max-w-[70vw]">
        {backend === "esphome" ? t("ir.actionsHintEsphome") : t("ir.actionsHintHa")}
      </div>
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {ACTIONS.map((a) => (
          <div key={a} className="flex items-center gap-[1vw]">
            <FocusButton
              focusKey={"ir-action-" + a}
              onEnter={() => setEditing({ kind: "action", action: a })}
              className="flex-1 px-[2vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw] min-w-0"
            >
              <span className="text-[2vh]">{t("ir.action." + a)}</span>
              <span className="text-[1.9vh] text-fg-dim truncate">{actions[a] || t("ir.notSet")}</span>
            </FocusButton>
            {!!actions[a] && ir?.configured && (
              <FocusButton
                focusKey={"ir-test-" + a}
                onEnter={() => test(a)}
                className="px-[1.4vw] py-[1.3vh] rounded-[1.1vh] bg-white/5 text-[1.7vh] font-semibold shrink-0"
              >
                {t("ir.test")}
              </FocusButton>
            )}
          </div>
        ))}
      </div>

      {testResult && (
        <div className={["text-[1.8vh] mt-[1vh] max-w-[70vw]", testResult.ok ? "text-accent" : "text-warn"].join(" ")}>
          {testResult.ok ? t("ir.testOk") : t("ir.testFailed", { error: testResult.error || "?" })}
        </div>
      )}
      {ir?.configured && status?.connected === false && (
        <div className="text-[1.8vh] text-warn mt-[1vh] max-w-[70vw]">
          {t("ir.disconnected", { error: status.lastError || "?" })}
        </div>
      )}
    </div>
  );
}
