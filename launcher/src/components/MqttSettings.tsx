import { useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useConfigStore } from "../stores/config";
import type { MqttInput } from "../lib/config";
import { FocusButton } from "./FocusButton";
import { Osk } from "./Osk";

// Settings → Network: point the box at an MQTT broker (Home Assistant's
// Mosquitto or any other). The shell bridges now-playing, remote commands and
// on-screen notifications over it (docs/mqtt-integration.md). Each row edits
// one field via the on-screen keyboard and saves immediately - the shell
// reconnects on save, so there is nothing else to apply. The password is
// write-only: the shell only reports whether one is stored (hasPassword), the
// row shows "••••" for it, and an empty OSK submit keeps the stored secret.
// Clearing the host clears the whole section = integration off.

type Field = "host" | "port" | "username" | "password" | "deviceId";
// label keys spelled out literally so the locale dead-key scan sees them
const FIELDS: { id: Field; label: string }[] = [
  { id: "host", label: "mqtt.host" },
  { id: "port", label: "mqtt.port" },
  { id: "username", label: "mqtt.username" },
  { id: "password", label: "mqtt.password" },
  { id: "deviceId", label: "mqtt.deviceId" },
];
const DEFAULT_PORT = 1883;

export function MqttSettings() {
  const { t } = useI18n();
  const config = useConfigStore((s) => s.config);
  const setMqtt = useConfigStore((s) => s.setMqtt);
  const [editing, setEditing] = useState<Field | null>(null);
  const [failed, setFailed] = useState(false);

  const m = config?.mqtt;

  // Full-state save: the shell replaces the section from what we send, except
  // the password, where "" means "keep the stored one" (config.js setMqtt).
  const save = async (patch: MqttInput) => {
    setFailed(false);
    try {
      await setMqtt({
        host: m?.host ?? "",
        port: m?.port ?? null,
        username: m?.username ?? "",
        password: "",
        deviceId: m?.deviceId ?? "",
        ...patch,
      });
    } catch {
      setFailed(true);
    }
  };

  // What the OSK starts from (saved value; password always starts blank).
  const initial = (f: Field): string => {
    if (!m || f === "password") return "";
    if (f === "port") return m.port ? String(m.port) : "";
    return m[f] || "";
  };
  // What the row shows (effective values, so the default port reads as 1883).
  const display = (f: Field): string => {
    if (!m || !m.host) return "";
    if (f === "password") return m.hasPassword ? "••••" : "";
    if (f === "port") return String(m.port || DEFAULT_PORT);
    return m[f] || "";
  };

  if (editing) {
    const f = editing;
    const close = () => {
      setEditing(null);
      setTimeout(() => setFocus("mqtt-" + f), 0);
    };
    return (
      <Osk
        key={"mqtt-" + f}
        title={t(FIELDS.find((x) => x.id === f)!.label)}
        initial={initial(f)}
        onDone={(v) => {
          close();
          const val = v.trim();
          if (f === "port") {
            const port = /^\d{1,5}$/.test(val) ? Number(val) : NaN;
            save({ port: port >= 1 && port <= 65535 ? port : null }); // blank/junk = default
          } else if (f === "password") {
            if (val) save({ password: val }); // empty keeps the stored password
          } else {
            save({ [f]: val });
          }
        }}
        onCancel={close}
      />
    );
  }

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[0.6vh]">
        {t("mqtt.title")}
        <span className={["text-[1.9vh] ml-[1.2vw]", m?.configured ? "text-accent" : "text-fg-dim"].join(" ")}>
          {m?.configured ? t("mqtt.configured") : t("mqtt.notConfigured")}
        </span>
      </div>
      <div className="text-[1.9vh] text-fg-dim mb-[0.4vh] max-w-[70vw]">{t("mqtt.hint")}</div>
      <div className="text-[1.7vh] text-fg-dim mb-[1.4vh] max-w-[70vw]">{t("mqtt.offHint")}</div>
      {failed && <div className="text-[1.9vh] text-warn mb-[1vh] max-w-[70vw]">{t("mqtt.saveFailed")}</div>}
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {FIELDS.map((f) => (
          <FocusButton
            key={f.id}
            focusKey={"mqtt-" + f.id}
            onEnter={() => setEditing(f.id)}
            className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
          >
            <span className="text-[2.1vh]">{t(f.label)}</span>
            <span className="text-[1.9vh] text-fg-dim tabular-nums truncate">{display(f.id) || "-"}</span>
          </FocusButton>
        ))}
      </div>
    </div>
  );
}
