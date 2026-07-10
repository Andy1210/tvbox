import { useEffect, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { fetchBtStatus, fetchBtDevices, btScan, btAction, type BtDevice, type BtStatus } from "../lib/bluetooth";
import { FocusButton } from "./FocusButton";

// Bluetooth section of the HOME Settings screen: scan, pair, connect/disconnect
// and remove devices (audio + input). Renders inside the parent Settings
// FocusContext. Pairing is "just works" - a device demanding a typed passkey
// isn't supported here (rare for TV-room speakers/keyboards/mice).

// Per-type SVG glyph (never emoji - the TV font has no colour emoji).
function BtGlyph({ type }: { type: string }) {
  const cls = "w-[2.8vh] h-[2.8vh] shrink-0 opacity-80"; // inherit currentColor (dark on the white focus fill)
  const p = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (type === "keyboard")
    return (
      <svg viewBox="0 0 24 24" className={cls}>
        <rect x="2" y="6" width="20" height="12" rx="2" {...p} />
        <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" {...p} />
      </svg>
    );
  if (type === "mouse")
    return (
      <svg viewBox="0 0 24 24" className={cls}>
        <rect x="6" y="3" width="12" height="18" rx="6" {...p} />
        <path d="M12 7v4" {...p} />
      </svg>
    );
  if (type === "audio")
    return (
      <svg viewBox="0 0 24 24" className={cls}>
        <rect x="7" y="3" width="10" height="18" rx="3" {...p} />
        <circle cx="12" cy="15" r="3" {...p} />
        <path d="M12 7h.01" {...p} />
      </svg>
    );
  // generic Bluetooth rune
  return (
    <svg viewBox="0 0 24 24" className={cls}>
      <path d="M7 7l10 10-5 4V3l5 4L7 17" {...p} />
    </svg>
  );
}

export function BluetoothSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<BtStatus | null>(null);
  const [devices, setDevices] = useState<BtDevice[] | null>(null); // null = first fetch in flight
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // mac being acted on
  const [msg, setMsg] = useState("");
  // Mirrors for the polling interval (its closure would otherwise see stale state).
  const busyRef = useRef<string | null>(null);
  const scanningRef = useRef(false);
  busyRef.current = busy;
  scanningRef.current = scanning;

  const refresh = () => {
    fetchBtStatus().then(setStatus);
    fetchBtDevices().then(setDevices);
  };
  useEffect(() => {
    refresh();
    // Live status: a BLE remote sleeps/wakes and (dis)connects on its own, so
    // poll while this screen is open instead of only on mount + after actions -
    // otherwise a stale "connected" lingers. Skip a tick while an action is in
    // flight so the poll doesn't clobber the optimistic busy state.
    const iv = setInterval(() => {
      if (!busyRef.current && !scanningRef.current) refresh();
    }, 4000);
    return () => clearInterval(iv);
  }, []);

  const scan = async () => {
    if (scanning) return;
    setScanning(true);
    setMsg("");
    setDevices(await btScan(8));
    setScanning(false);
    setTimeout(() => setFocus("bt-scan"), 0);
  };

  const act = async (d: BtDevice) => {
    if (busy) return;
    const action = d.connected ? "disconnect" : d.paired ? "connect" : "pair";
    setBusy(d.mac);
    setMsg(action === "pair" ? t("bt.pairing", { name: d.name }) : "");
    const r = await btAction(action, d.mac);
    setBusy(null);
    setMsg(r.ok ? "" : t("bt.failed", { name: d.name }));
    setTimeout(() => setFocus("bt-dev-" + d.mac), 0);
    refresh();
  };
  const remove = async (d: BtDevice) => {
    if (busy) return;
    setBusy(d.mac);
    await btAction("remove", d.mac);
    setBusy(null);
    setTimeout(() => setFocus("bt-scan"), 0);
    refresh();
  };

  return (
    <div className="mt-[3vh]">
      <div className="flex items-center gap-[1.5vw] mb-[1.4vh]">
        <div className="text-[2.4vh] font-semibold">{t("bt.title")}</div>
        {busy ? (
          <span className="text-[1.9vh] text-accent">{msg || t("bt.working")}</span>
        ) : msg ? (
          <span className="text-[1.9vh] text-fg-dim">{msg}</span>
        ) : null}
      </div>
      {status && !status.powered && <div className="text-[1.9vh] text-fg-dim mb-[1vh]">{t("bt.off")}</div>}
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw] max-h-[46vh] overflow-y-auto no-scrollbar px-[1.5vw] -mx-[1.5vw]">
        {/* Scan is a full-width row (not a small button by the title) so vertical nav lands on it */}
        <FocusButton
          focusKey="bt-scan"
          onEnter={scan}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="text-[2.1vh] font-semibold">{scanning ? t("bt.scanning") : t("bt.scan")}</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-[2.4vh] h-[2.4vh] opacity-70"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </FocusButton>
        {(devices || []).map((d) => (
          <div key={d.mac} className="flex items-center gap-[1vw]">
            <FocusButton
              focusKey={"bt-dev-" + d.mac}
              onEnter={() => act(d)}
              className="flex-1 px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.2vw] min-w-0"
            >
              <BtGlyph type={d.type} />
              <span className="text-[2.1vh] truncate flex-1 min-w-0 text-left">{d.name}</span>
              {d.battery != null && (
                <span className="text-[1.7vh] text-fg-dim shrink-0 tabular-nums">{d.battery}%</span>
              )}
              <span className={["text-[1.7vh] shrink-0", d.connected ? "text-accent" : "text-fg-dim"].join(" ")}>
                {d.connected ? t("bt.connected") : d.paired ? t("bt.paired") : t("bt.pair")}
              </span>
            </FocusButton>
            {d.paired && (
              <FocusButton
                focusKey={"bt-rm-" + d.mac}
                onEnter={() => remove(d)}
                className="px-[1.4vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 text-[1.8vh] font-semibold shrink-0"
              >
                {t("bt.remove")}
              </FocusButton>
            )}
          </div>
        ))}
        {devices && !devices.length && <div className="text-[1.9vh] text-fg-dim">{t("bt.none")}</div>}
      </div>
    </div>
  );
}
