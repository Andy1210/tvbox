import { useState } from "react";
import { useArmedConfirm } from "../../lib/armedConfirm";
import { useI18n } from "../../lib/i18n";
import { useConfigStore } from "../../stores/config";
import { SettingsPage } from "../SettingsPage";
import { Group, Note, Row, TextRow, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";

// Settings -> Network -> Home Assistant: the MQTT bridge (now-playing sensor,
// remote commands, notifications).
//
// `setMqtt` REPLACES the whole section from what it is sent - it is not a per-field
// merge - and its first act is "no host, no section". So every row here has to send
// the complete block with one field changed, or editing the port would delete the
// broker and editing the password would delete the password. (Measured: a lone
// `{port}` patch leaves `mqtt` undefined.) `password: ""` is the shell's "keep the
// stored one", which is also what TextRow submits for an untouched secret, so the
// secret survives every save and there is no explicit save button to press.
export function MqttPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const mqtt = useConfigStore((s) => s.config?.mqtt);
  const setMqtt = useConfigStore((s) => s.setMqtt);
  const load = useConfigStore((s) => s.load);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  // Forgetting is one press away from Home Assistant losing the device, so the
  // first press only arms it and a second, separate press does it.
  const confirm = useArmedConfirm();
  const [forgetting, setForgetting] = useState(false);

  const forget = async () => {
    // The row stays focusable while this runs, so the cursor does not jump away
    // from the line saying what is happening; presses meanwhile do nothing.
    if (forgetting || !confirm.press("forget")) return;
    setForgetting(true);
    setMsg(null);
    let ok = false;
    try {
      const res = await fetch("/tvbox/api/mqtt/forget", { method: "POST" });
      ok = !!((await res.json()) as { ok?: boolean }).ok;
    } catch {
      ok = false;
    }
    setForgetting(false);
    if (!ok) return setMsg({ text: t("mqtt.forgetFailed") });
    setMsg({ text: t("mqtt.forgotten"), ok: true });
    // The box has dropped the section. Drop it here too before reloading, so a
    // failed reload cannot leave the old broker in the form, where the next edit
    // would send it straight back.
    useConfigStore.setState((st) =>
      st.config
        ? {
            config: {
              ...st.config,
              mqtt: {
                ...st.config.mqtt,
                configured: false,
                host: "",
                port: null,
                username: "",
                hasPassword: false,
                tls: false,
              },
            },
          }
        : {},
    );
    await load();
  };

  const save = async (patch: Parameters<typeof setMqtt>[0]) => {
    setMsg(null);
    try {
      await setMqtt({
        host: mqtt?.host ?? "",
        port: mqtt?.port ?? null,
        username: mqtt?.username ?? "",
        password: "", // keep the stored one unless this patch carries a new one
        tls: mqtt?.tls ?? false,
        deviceId: mqtt?.deviceId ?? "",
        ...patch,
      });
    } catch {
      setMsg({ text: t("mqtt.saveFailed") });
    }
  };

  return (
    <SettingsPage id="mqtt" title={t("mqtt.title")} subtitle={t("mqtt.hint")} onBack={nav.pop} animate="push">
      {msg && <Note tone={msg.ok ? "ok" : "warn"}>{msg.text}</Note>}
      <Note>{t("mqtt.offHint")}</Note>
      <Group title={t("mqtt.groupBroker")}>
        <TextRow
          id="host"
          label={t("mqtt.host")}
          title={t("mqtt.host")}
          value={mqtt?.host}
          emptyLabel={t("common.notSet")}
          onSubmit={(v) => void save({ host: v.trim() })}
          autoFocus
        />
        <TextRow
          id="port"
          label={t("mqtt.port")}
          title={t("mqtt.port")}
          value={mqtt?.port ? String(mqtt.port) : ""}
          emptyLabel={mqtt?.tls ? t("mqtt.portDefaultTls") : t("mqtt.portDefault")}
          // Digits only and in range: Number() would take "0x1f" and "1e3". An empty or
          // unusable entry means "the default", which the shell represents as null -
          // not as the number 1883, so a future default change reaches old boxes.
          onSubmit={(v) => {
            const n = /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : NaN;
            void save({ port: n >= 1 && n <= 65535 ? n : null });
          }}
        />
        <ToggleRow
          id="tls"
          label={t("mqtt.tls")}
          hint={t("mqtt.tlsHint")}
          on={!!mqtt?.tls}
          onToggle={() => void save({ tls: !mqtt?.tls })}
          onWord={t("common.on")}
          offWord={t("common.off")}
        />
      </Group>
      <Group title={t("mqtt.groupAuth")}>
        <TextRow
          id="username"
          label={t("mqtt.username")}
          title={t("mqtt.username")}
          value={mqtt?.username}
          emptyLabel={t("common.notSet")}
          onSubmit={(v) => void save({ username: v.trim() })}
        />
        <TextRow
          id="password"
          label={t("mqtt.password")}
          title={t("mqtt.password")}
          secret
          hasSecret={!!mqtt?.hasPassword}
          emptyLabel={t("common.notSet")}
          onSubmit={(v) => v && void save({ password: v })}
        />
      </Group>
      <Group title={t("mqtt.groupIdentity")} hint={t("mqtt.deviceIdHint")}>
        <TextRow
          id="deviceId"
          label={t("mqtt.deviceId")}
          title={t("mqtt.deviceId")}
          value={mqtt?.deviceId}
          emptyLabel={t("common.notSet")}
          onSubmit={(v) => void save({ deviceId: v.trim() })}
        />
      </Group>
      {mqtt?.configured && (
        <Group title={t("mqtt.groupForget")} hint={t("mqtt.forgetHint")}>
          <Row
            id="forget"
            label={
              forgetting ? t("mqtt.forgetting") : confirm.armed === "forget" ? t("mqtt.forgetSure") : t("mqtt.forget")
            }
            trailing="none"
            warn={confirm.armed === "forget" || forgetting}
            onEnter={() => void forget()}
          />
        </Group>
      )}
    </SettingsPage>
  );
}
