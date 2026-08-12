import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../lib/i18n";
import { Osk } from "../../components/Osk";
import { useConfigStore } from "../../stores/config";
import {
  wifiStatus,
  wifiList,
  wifiConnect,
  wifiForget,
  wifiRadio,
  type WifiNet,
  type WifiStatus,
  type WifiFailure,
} from "../../lib/wifi";
import { SettingsPage } from "../SettingsPage";
import { ChoicePage } from "../ChoicePage";
import { Group, InfoRow, Note, Row, StatusBanner, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";
import { invalidateSummary } from "../summary";
import { icons } from "../icons";
import { radioState, applyBuiltinRadio, type RadioState } from "../../lib/radios";

// Settings -> Network -> Wi-Fi. What used to be one column holding the radio
// switch, the scan, the network list, the hidden-network entry and the regulatory
// country is now three named groups, and the two actions a saved network has
// (reconnect, forget) moved off the list into the network's own page.
//
// That last part is the substantive change: a "Forget" button beside every row
// doubled the width of the list and put a destructive action one careless press
// from a connect. Joining a NEW network is still a single press - the common case
// pays nothing for it.
const COUNTRIES = [
  "",
  "HU",
  "DE",
  "AT",
  "CH",
  "GB",
  "US",
  "FR",
  "IT",
  "ES",
  "NL",
  "BE",
  "PL",
  "CZ",
  "SK",
  "RO",
  "HR",
  "RS",
  "SI",
  "UA",
  "SE",
  "NO",
  "DK",
  "FI",
  "PT",
  "IE",
  "GR",
  "TR",
];

// Names come from the platform in the UI language, so a new country costs no
// translation.
function countryName(tag: string, code: string, autoLabel: string): string {
  if (!code) return autoLabel;
  try {
    return new Intl.DisplayNames([tag], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

function CountryPage() {
  const { t, tag } = useI18n();
  const country = useConfigStore((st) => st.config?.wifi.country) || "";
  const setWifiCfg = useConfigStore((st) => st.setWifi);
  return (
    <ChoicePage
      id="wifi-country"
      title={t("wifi.country")}
      subtitle={t("wifi.countryHint")}
      options={COUNTRIES.map((code) => ({ id: code, label: countryName(tag, code, t("wifi.countryAuto")) }))}
      value={country}
      // Returned, not voided: ChoicePage awaits this and stays put if it throws.
      onPick={(code) => setWifiCfg({ country: code })}
    />
  );
}

// A saved or connected network, and where Forget lives. `net` is a scan result held
// only for display (see PushedPage): this page cannot change a signal strength, and
// popping it rescans, so there is nothing here that can go stale misleadingly.
function NetworkPage({ net }: { net: WifiNet }) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  // Self-contained (see PushedPage): a saved profile carries its own secret, so this
  // needs no password prompt and no help from the page below - which is unmounted.
  const connect = async () => {
    if (busy) return;
    setBusy("connect");
    setMsg("");
    const r = await wifiConnect(net.ssid, "");
    setBusy("");
    invalidateSummary("wifi");
    if (r.ok) {
      nav.pop(); // the list rescans as it remounts and will show this one as active
      return;
    }
    setMsg(t("wifi.failed", { ssid: net.ssid }));
  };

  const forget = async () => {
    if (busy) return;
    setBusy("forget");
    const r = await wifiForget(net.ssid);
    setBusy("");
    if (r.ok) {
      // The page below rescans when it remounts, so there is nothing to tell it.
      invalidateSummary("wifi");
      nav.pop();
      return;
    }
    setMsg(t("wifi.forgetFailed", { ssid: net.ssid }));
  };

  return (
    <SettingsPage id="wifi-net" title={net.ssid} onBack={nav.pop} animate="push">
      {msg && <Note tone="warn">{msg}</Note>}
      {/* Joining it is the whole reason you would open a saved network you are not on,
          and leaving it out meant Forget-and-retype was the only way back onto it. */}
      {!net.active && (
        <Group>
          <Row
            id="connect"
            label={t("wifi.connect")}
            value={busy === "connect" ? t("common.working") : undefined}
            trailing="none"
            autoFocus
            onEnter={connect}
          />
        </Group>
      )}
      <Group>
        <InfoRow label={t("wifi.signal")} value={`${net.signal}%`} />
        <InfoRow label={t("wifi.security")} value={net.secured ? t("wifi.securedYes") : t("wifi.securedNo")} />
      </Group>
      {net.known && (
        <Group>
          <Row
            id="forget"
            label={t("wifi.forget")}
            hint={t("wifi.forgetHint")}
            value={busy === "forget" ? t("common.working") : undefined}
            trailing="none"
            autoFocus={net.active}
            onEnter={forget}
          />
        </Group>
      )}
    </SettingsPage>
  );
}

// `embedded` is for the first-boot wizard, which puts this on one of its own steps:
// no title, no slide-in and no Back of its own (the wizard owns all three), and it
// must not grab focus - the wizard focuses its Next button first so a step that
// cannot load can never strand first boot.
export function WifiPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, tag } = useI18n();
  const nav = useSettingsNav();
  const [status, setStatus] = useState<WifiStatus | null>(null);
  const [nets, setNets] = useState<WifiNet[]>([]);
  const [scanning, setScanning] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pwHidden, setPwHidden] = useState(false);
  const [hiddenSsid, setHiddenSsid] = useState(false);
  const [msg, setMsg] = useState("");
  const [detail, setDetail] = useState("");
  const country = useConfigStore((st) => st.config?.wifi.country) || "";

  const refresh = useCallback(() => {
    invalidateSummary("wifi"); // the category row behind us shows the network name
    void wifiStatus().then(setStatus);
    setScanning(true);
    void wifiList().then((n) => {
      setNets(n);
      setScanning(false);
    });
  }, []);
  useEffect(refresh, [refresh]);

  // A sentence the user can act on, with NetworkManager's own words underneath
  // rather than inside it: from the couch there is no log to open, but a raw
  // English string is not an answer either.
  const failureText = (r: { code?: WifiFailure }, ssid: string) => {
    if (r.code === "bad-ssid") return t("wifi.failedName");
    if (r.code === "bad-password") return t("wifi.failedBadPassword", { ssid });
    if (r.code === "not-found") return t("wifi.failedNotFound", { ssid });
    return t("wifi.failed", { ssid });
  };

  const doConnect = async (ssid: string, password: string, hidden = false) => {
    setPwFor(null);
    setPwHidden(false);
    setConnecting(ssid);
    setMsg("");
    setDetail("");
    const r = await wifiConnect(ssid, password, hidden);
    setConnecting(null);
    setMsg(r.ok ? t("wifi.connected", { ssid }) : failureText(r, ssid));
    setDetail(r.ok ? "" : r.error || "");
    if (r.ok) refresh();
  };

  // The BOOT-CONFIG state of both radios, which is a different thing from the
  // switch above: that one lasts until the next boot, this one is what actually
  // frees the antenna. Loaded next to the wifi status so one refresh covers both.
  const [radios, setRadios] = useState<RadioState | null>(null);
  // The direction the box asked us to confirm, not a bare flag: a sticky `true`
  // would ride along on whatever the NEXT press happens to be.
  const [confirmWifi, setConfirmWifi] = useState<boolean | null>(null);
  useEffect(() => {
    void radioState().then(setRadios);
  }, []);

  const toggleBuiltinWifi = async () => {
    if (!radios) return;
    const want = radios.wifi !== "on"; // "on" means the radio is not disabled in config.txt
    setMsg(t("radios.applying"));
    setDetail("");
    const r = await applyBuiltinRadio("wifi", want, confirmWifi === want);
    setMsg(t(r.key));
    setDetail(r.detail || "");
    setConfirmWifi(r.needsConfirm ? want : null); // the next press confirms THIS change
    setRadios(await radioState());
  };

  const toggleRadio = async () => {
    const want = !status?.radio;
    setMsg(want ? t("wifi.radioTurningOn") : t("wifi.radioTurningOff"));
    const r = await wifiRadio(want);
    setMsg(r.ok ? "" : r.error === "no-ethernet" ? t("wifi.radioNeedsEthernet") : t("wifi.radioFailed"));
    refresh();
  };

  const onPick = (net: WifiNet) => {
    if (connecting) return;
    // Anything with a saved profile (or the one we are on) has more than one thing
    // you might want to do with it, so it gets a page. A fresh network does not.
    //
    // Except in the wizard, which has no page stack at all: there a press has to DO
    // something, so a known network simply reconnects (the shell resolves the stored
    // secret from the profile). A row that silently ignores the press is exactly the
    // dead end a keyboardless first boot cannot afford.
    if ((net.known || net.active) && !embedded) {
      nav.push({
        id: "wifi-net-" + net.ssid,
        title: net.ssid,
        render: () => <NetworkPage net={net} />,
      });
      return;
    }
    if (net.known) void doConnect(net.ssid, "");
    else if (net.secured) setPwFor(net.ssid);
    else void doConnect(net.ssid, "");
  };

  const eth = status?.ethernet;
  return (
    <SettingsPage
      id="wifi"
      title={embedded ? undefined : t("settings.wifi")}
      onBack={embedded ? undefined : nav.pop}
      animate={embedded ? "none" : "push"}
      focusPolicy={embedded ? "rail" : "own"}
    >
      {eth?.connected && (
        <StatusBanner
          icon={icons.ethernet}
          title={t("wifi.ethernet")}
          detail={t("wifi.ethConnected") + (eth.ip ? " · " + eth.ip : "")}
          tone="accent"
        />
      )}
      {connecting ? (
        <Note tone="accent">{t("wifi.connecting", { ssid: connecting })}</Note>
      ) : msg ? (
        <Note>{msg}</Note>
      ) : null}
      {detail && !connecting ? <Note>{detail}</Note> : null}

      <Group title={t("wifi.groupConnection")}>
        {status?.radio !== null && status?.radio !== undefined && (
          <ToggleRow
            id="radio"
            label={t("wifi.radio")}
            hint={status.radio ? t("wifi.radioOnHint") : t("wifi.radioOffHint")}
            on={status.radio}
            onToggle={toggleRadio}
            onWord={t("common.on")}
            offWord={t("common.off")}
          />
        )}
        <Row
          id="rescan"
          label={t("wifi.rescan")}
          value={scanning ? t("wifi.scanning") : undefined}
          trailing="none"
          autoFocus
          onEnter={refresh}
        />
      </Group>

      {/* A group of its own, and not part of "Connection" above: the switch there
          parks the radio until the next boot, this one writes the boot config, and
          two adjacent rows that read the same but mean different things need the
          group's own "takes effect at the next restart" to tell them apart.
          Not during first-time setup - the wizard runs on a freshly flashed box,
          which has never been provisioned, so the row could only ever be the
          disabled one, and a dead row is what a keyboardless first boot can least
          afford. */}
      {!embedded && radios?.readable && radios.wifi !== null && (
        <Group title={t("radios.groupBuiltin")} hint={t("radios.builtinHint")}>
          <ToggleRow
            id="builtin-wifi"
            label={t("radios.builtinWifi")}
            hint={
              !radios.helper
                ? t("radios.needsProvision")
                : radios.wifi === "on"
                  ? t("radios.builtinWifiOnHint")
                  : t("radios.builtinWifiOffHint")
            }
            on={radios.wifi === "on"}
            // A row that cannot act must not look actionable: `disabled` takes it
            // out of spatial navigation and dims it, where swallowing the press
            // inside the handler left it lit and silently ignoring every OK.
            disabled={!radios.helper}
            onToggle={() => void toggleBuiltinWifi()}
            onWord={t("common.on")}
            offWord={t("common.off")}
          />
        </Group>
      )}
      {!embedded && radios?.readable && radios.wifi === "on" && !radios.ethernet?.connected && (
        <Note tone="warn">{t("radios.wifiOffGoesOffline")}</Note>
      )}

      <Group title={t("wifi.groupNetworks")}>
        {nets.map((n) => (
          <Row
            key={n.ssid}
            id={"net-" + n.ssid}
            label={n.ssid}
            // Whether it will ask for a password is the one thing worth knowing before
            // you press it, and a word for it would cost the row a line.
            leading={n.secured ? icons.lock : undefined}
            hint={n.active ? t("wifi.active") : n.known ? t("wifi.savedNetwork") : undefined}
            value={`${n.signal}%`}
            trailing={(n.known || n.active) && !embedded ? "chevron" : "none"}
            onEnter={() => onPick(n)}
          />
        ))}
        {!nets.length && !scanning && <InfoRow label={t("wifi.none")} value="" />}
        <Row id="hidden" label={t("wifi.hidden")} trailing="none" onEnter={() => !connecting && setHiddenSsid(true)} />
      </Group>

      {/* Not in the wizard: it has no page stack, so this row could only ignore the
          press. The setting applies at the next restart anyway and is reachable from
          Settings the moment the box is up. */}
      {!embedded && (
        <Group title={t("wifi.groupRegion")}>
          <Row
            id="country"
            label={t("wifi.country")}
            hint={t("wifi.countryHint")}
            value={countryName(tag, country, t("wifi.countryAuto"))}
            onEnter={() => nav.push({ id: "wifi-country", title: t("wifi.country"), render: () => <CountryPage /> })}
          />
        </Group>
      )}

      {hiddenSsid &&
        createPortal(
          <Osk
            title={t("wifi.hiddenSsid")}
            onDone={(v: string) => {
              const ssid = v.trim();
              setHiddenSsid(false);
              if (!ssid) return;
              // Hidden networks are not in the scan, so we cannot know whether they
              // are secured - always ask; an empty password joins an open one.
              setPwHidden(true);
              setPwFor(ssid);
            }}
            onCancel={() => setHiddenSsid(false)}
          />,
          document.body,
        )}
      {pwFor &&
        createPortal(
          <Osk
            title={t("wifi.passwordFor", { ssid: pwFor })}
            onDone={(v: string) => void doConnect(pwFor, v, pwHidden)}
            onCancel={() => {
              setPwFor(null);
              setPwHidden(false);
            }}
          />,
          document.body,
        )}
    </SettingsPage>
  );
}
