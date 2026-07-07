import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { FocusButton } from "./FocusButton";
import { Osk } from "./Osk";
import { wifiStatus, wifiList, wifiConnect, type WifiNet, type WifiStatus } from "../lib/wifi";

// WiFi section of the HOME Settings screen: shows the current network + connected
// state, scans, and connects (password via the on-screen keyboard for secured
// networks). Renders its focusable rows inside the parent Settings FocusContext.
export function WifiSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<WifiStatus | null>(null);
  const [nets, setNets] = useState<WifiNet[]>([]);
  const [scanning, setScanning] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<string | null>(null); // ssid awaiting a password
  const [msg, setMsg] = useState("");

  const refresh = () => {
    wifiStatus().then(setStatus);
    setScanning(true);
    wifiList().then((n) => {
      setNets(n);
      setScanning(false);
    });
  };
  useEffect(() => {
    refresh();
  }, []);

  const doConnect = async (ssid: string, password: string) => {
    setPwFor(null);
    setConnecting(ssid);
    setMsg("");
    setTimeout(() => setFocus("wifi-rescan"), 0);
    const r = await wifiConnect(ssid, password);
    setConnecting(null);
    setMsg(r.ok ? t("wifi.connected", { ssid }) : t("wifi.failed", { ssid }));
    if (r.ok) refresh();
  };
  const onPick = (net: WifiNet) => {
    if (connecting || net.active) return;
    if (net.secured) setPwFor(net.ssid);
    else doConnect(net.ssid, "");
  };

  if (pwFor) {
    return (
      <Osk
        title={t("wifi.passwordFor", { ssid: pwFor })}
        onDone={(v) => doConnect(pwFor, v)}
        onCancel={() => {
          setPwFor(null);
          setTimeout(() => setFocus("wifi-rescan"), 0);
        }}
      />
    );
  }

  const eth = status?.ethernet;
  return (
    <div className="mt-[3vh]">
      {eth?.connected && (
        <div className="mb-[1.4vh] flex items-center gap-[1vw] text-[2.1vh]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-[2.4vh] h-[2.4vh] text-[#39c0d6]"
          >
            <rect x="3" y="9" width="18" height="10" rx="1.5" />
            <path d="M7 9V6h10v3M9 19v2M15 19v2M12 19v2" />
          </svg>
          <span className="font-semibold">{t("wifi.ethernet")}</span>
          <span className="text-fg-dim text-[1.8vh]">
            {t("wifi.ethConnected")}
            {eth.ip ? " · " + eth.ip : ""}
          </span>
        </div>
      )}
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">
        {t("settings.wifi")}
        <span className="text-fg-dim text-[1.9vh] ml-[1.2vw]">
          {status?.connected ? t("wifi.connectedTo", { ssid: status.ssid }) : t("wifi.notConnected")}
        </span>
      </div>
      <div className="flex items-center gap-[1.5vw] mb-[1.4vh]">
        <FocusButton
          focusKey="wifi-rescan"
          onEnter={refresh}
          className="px-[2vw] py-[1.2vh] rounded-[1vh] bg-white/5 text-[1.9vh] font-semibold"
        >
          {scanning ? t("wifi.scanning") : t("wifi.rescan")}
        </FocusButton>
        {connecting ? (
          <span className="text-[1.9vh] text-[#39c0d6]">{t("wifi.connecting", { ssid: connecting })}</span>
        ) : msg ? (
          <span className="text-[1.9vh] text-fg-dim">{msg}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw] max-h-[40vh] overflow-y-auto no-scrollbar">
        {nets.map((n, i) => (
          <FocusButton
            key={n.ssid}
            focusKey={"wifi-net-" + i}
            onEnter={() => onPick(n)}
            className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
          >
            <span className="flex items-center gap-[1vw] min-w-0">
              {n.secured && (
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-[1.9vh] h-[1.9vh] shrink-0 opacity-60">
                  <path d="M6 10V8a6 6 0 1 1 12 0v2h1v11H5V10h1zm2 0h8V8a4 4 0 0 0-8 0v2z" />
                </svg>
              )}
              <span className="text-[2.1vh] truncate">{n.ssid}</span>
            </span>
            <span className="flex items-center gap-[1.2vw] shrink-0">
              {n.active && <span className="text-[1.7vh] text-[#39c0d6]">● {t("wifi.active")}</span>}
              <span className="text-[1.6vh] text-fg-dim tabular-nums">{n.signal}%</span>
            </span>
          </FocusButton>
        ))}
        {!nets.length && !scanning && <div className="text-[1.9vh] text-fg-dim">{t("wifi.none")}</div>}
      </div>
    </div>
  );
}
