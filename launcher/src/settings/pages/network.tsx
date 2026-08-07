import { useI18n } from "../../lib/i18n";
import { wifiStatus } from "../../lib/wifi";
import { fetchFileServer, fetchShares } from "../../lib/api";
import { useConfigStore } from "../../stores/config";
import { SettingsPage } from "../SettingsPage";
import { Group, Row } from "../Rows";
import { useSettingsNav } from "../nav";
import { useSummary } from "../summary";
import { WifiPage } from "./wifi";
import { FileServerPage } from "./fileserver";
import { SharesPage } from "./shares";
import { MqttPage } from "./mqtt";

// The category that used to be the worst of the dump: three unrelated screens -
// the Wi-Fi scanner, the WebDAV file server and the MQTT bridge - stacked in one
// scroll. Each is now a page, and this level answers the only question worth
// answering at a glance: what is each of them set to right now.
export function NetworkPane() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const wifi = useSummary("wifi", wifiStatus);
  const fs = useSummary("fileserver", fetchFileServer);
  const shares = useSummary("shares", fetchShares);
  const mqtt = useConfigStore((s) => s.config?.mqtt);

  const wifiValue = !wifi
    ? undefined
    : wifi.connected
      ? wifi.ssid
      : wifi.ethernet?.connected
        ? t("wifi.ethernet")
        : t("wifi.notConnected");

  return (
    <SettingsPage id="net" focusPolicy="rail">
      <Group>
        <Row
          id="wifi"
          label={t("settings.wifi")}
          hint={t("network.wifiHint")}
          value={wifiValue}
          onEnter={() => nav.push({ id: "wifi", title: t("settings.wifi"), render: () => <WifiPage /> })}
        />
        <Row
          id="fileserver"
          label={t("fileserver.title")}
          hint={t("network.fileserverHint")}
          value={fs ? (fs.running ? t("fileserver.running") : t("fileserver.stopped")) : undefined}
          onEnter={() => nav.push({ id: "fileserver", title: t("fileserver.title"), render: () => <FileServerPage /> })}
        />
        <Row
          id="shares"
          label={t("shares.title")}
          hint={t("network.sharesHint")}
          value={shares?.shares ? (shares.shares.length ? String(shares.shares.length) : t("shares.none")) : undefined}
          onEnter={() => nav.push({ id: "shares", title: t("shares.title"), render: () => <SharesPage /> })}
        />
        <Row
          id="mqtt"
          label={t("mqtt.title")}
          hint={t("network.mqttHint")}
          value={mqtt ? (mqtt.configured ? t("mqtt.configured") : t("mqtt.notConfigured")) : undefined}
          onEnter={() => nav.push({ id: "mqtt", title: t("mqtt.title"), render: () => <MqttPage /> })}
        />
      </Group>
    </SettingsPage>
  );
}
