import { useState } from "react";
import { useI18n } from "../../lib/i18n";
import { useConfigStore } from "../../stores/config";
import { SettingsPage } from "../SettingsPage";
import { Group, Note, TextRow } from "../Rows";
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
  const [msg, setMsg] = useState("");

  const save = async (patch: Parameters<typeof setMqtt>[0]) => {
    setMsg("");
    try {
      await setMqtt({
        host: mqtt?.host ?? "",
        port: mqtt?.port ?? null,
        username: mqtt?.username ?? "",
        password: "", // keep the stored one unless this patch carries a new one
        deviceId: mqtt?.deviceId ?? "",
        ...patch,
      });
    } catch {
      setMsg(t("mqtt.saveFailed"));
    }
  };

  return (
    <SettingsPage id="mqtt" title={t("mqtt.title")} subtitle={t("mqtt.hint")} onBack={nav.pop} animate="push">
      {msg && <Note tone="warn">{msg}</Note>}
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
          emptyLabel={t("mqtt.portDefault")}
          // An empty entry means "the default", which the shell represents as null -
          // not as the number 1883, so a future default change reaches old boxes.
          onSubmit={(v) => void save({ port: v.trim() ? Number(v.trim()) : null })}
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
    </SettingsPage>
  );
}
