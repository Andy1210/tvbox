import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { FocusButton } from "./FocusButton";
import { Osk } from "./Osk";
import { wifiStatus, wifiList, wifiConnect, wifiForget, type WifiNet, type WifiStatus } from "../lib/wifi";

// WiFi section of the HOME Settings screen: shows the current network + connected
// state, scans, connects (password via the on-screen keyboard for secured
// networks), forgets saved networks and joins hidden ones (SSID via the OSK).
// Renders its focusable rows inside the parent Settings FocusContext.
export function WifiSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<WifiStatus | null>(null);
  const [nets, setNets] = useState<WifiNet[]>([]);
  const [scanning, setScanning] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<string | null>(null); // ssid awaiting a password
  const [pwHidden, setPwHidden] = useState(false); // the pwFor flow targets a hidden network
  const [hiddenSsid, setHiddenSsid] = useState(false); // OSK open for a hidden network's SSID
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

  const doConnect = async (ssid: string, password: string, hidden = false) => {
    setPwFor(null);
    setPwHidden(false);
    setConnecting(ssid);
    setMsg("");
    setTimeout(() => setFocus("wifi-rescan"), 0);
    const r = await wifiConnect(ssid, password, hidden);
    setConnecting(null);
    setMsg(r.ok ? t("wifi.connected", { ssid }) : t("wifi.failed", { ssid }));
    if (r.ok) refresh();
  };
  const onPick = (net: WifiNet) => {
    if (connecting || net.active) return;
    if (net.secured) setPwFor(net.ssid);
    else doConnect(net.ssid, "");
  };
  const doForget = async (net: WifiNet) => {
    if (connecting || forgetting) return;
    setForgetting(net.ssid);
    setMsg("");
    const r = await wifiForget(net.ssid);
    setForgetting(null);
    setMsg(r.ok ? t("wifi.forgotten", { ssid: net.ssid }) : t("wifi.forgetFailed", { ssid: net.ssid }));
    // The forget button vanishes with the profile - land back on the scan row.
    setTimeout(() => setFocus("wifi-rescan"), 0);
    refresh();
  };

  if (hiddenSsid) {
    return (
      <Osk
        key="wifi-ssid"
        title={t("wifi.hiddenSsid")}
        onDone={(v) => {
          const ssid = v.trim();
          setHiddenSsid(false);
          if (!ssid) {
            setTimeout(() => setFocus("wifi-hidden"), 0);
            return;
          }
          // Hidden networks aren't in the scan list, so we can't know whether
          // they're secured - always ask; an empty password joins open networks.
          setPwHidden(true);
          setPwFor(ssid);
        }}
        onCancel={() => {
          setHiddenSsid(false);
          setTimeout(() => setFocus("wifi-hidden"), 0);
        }}
      />
    );
  }
  if (pwFor) {
    return (
      <Osk
        key="wifi-pw"
        title={t("wifi.passwordFor", { ssid: pwFor })}
        onDone={(v) => doConnect(pwFor, v, pwHidden)}
        onCancel={() => {
          setPwFor(null);
          setPwHidden(false);
          setTimeout(() => setFocus(pwHidden ? "wifi-hidden" : "wifi-rescan"), 0);
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
            className="w-[2.4vh] h-[2.4vh] text-accent"
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
          <span className="text-[1.9vh] text-accent">{t("wifi.connecting", { ssid: connecting })}</span>
        ) : msg ? (
          <span className="text-[1.9vh] text-fg-dim">{msg}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw] max-h-[40vh] overflow-y-auto no-scrollbar">
        {nets.map((n, i) => (
          <div key={n.ssid} className="flex items-center gap-[1vw]">
            <FocusButton
              focusKey={"wifi-net-" + i}
              onEnter={() => onPick(n)}
              className="flex-1 min-w-0 px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
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
                {n.active && (
                  <span className="flex items-center gap-[0.6vw] text-[1.7vh] text-accent">
                    <span className="w-[1.2vh] h-[1.2vh] rounded-full bg-accent shrink-0" />
                    {t("wifi.active")}
                  </span>
                )}
                <span className="text-[1.6vh] text-fg-dim tabular-nums">{n.signal}%</span>
              </span>
            </FocusButton>
            {n.known && (
              <FocusButton
                focusKey={"wifi-forget-" + i}
                onEnter={() => doForget(n)}
                className="px-[1.4vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 text-[1.8vh] font-semibold shrink-0"
              >
                {t("wifi.forget")}
              </FocusButton>
            )}
          </div>
        ))}
        {!nets.length && !scanning && <div className="text-[1.9vh] text-fg-dim">{t("wifi.none")}</div>}
        <FocusButton
          focusKey="wifi-hidden"
          onEnter={() => {
            if (!connecting) setHiddenSsid(true);
          }}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1vw]"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-[1.9vh] h-[1.9vh] shrink-0 opacity-60"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span className="text-[2.1vh]">{t("wifi.hidden")}</span>
        </FocusButton>
      </div>
    </div>
  );
}
