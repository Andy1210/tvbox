import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchBtStatus, fetchBtDevices, btScan, btAction, type BtDevice, type BtStatus } from "../../lib/bluetooth";
import { fetchIrStatus } from "../../lib/ir";
import { fetchRemoteDevices } from "../../lib/remote";
import { fetchPhoneRemote } from "../../lib/phoneremote";
import { useConfigStore } from "../../stores/config";
import { PhoneRemoteSubPage } from "./phoneremote";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";
import { useSummary, invalidateSummary } from "../summary";
import { btGlyph } from "../icons";
import { RemoteRemap } from "../../components/RemoteRemap";
import { IrPage } from "./ir";
import { radioState, setBuiltinRadio, type RadioState } from "../../lib/radios";

// Settings -> Remotes & accessories. Bluetooth, the per-remote button map, and the
// IR blaster that gives a CEC-volume-less TV its volume back.
//
// The button map keeps its own screens (RemoteRemap -> RemoteKeymap): it is a
// learning flow with its own modals and a panic path, not a list of settings, and
// rebuilding it as rows would be a rewrite with nothing to gain.
const BT_POLL_MS = 4000;

// Self-contained (see PushedPage): it re-reads the device after every action rather
// than trusting what the list handed it, because "Connect" that succeeds and still
// says "Connect" reads as a box that ignored the press. `initial` is only there so
// the title and the first frame are right before the first fetch answers.
function BtDevicePage({ initial }: { initial: BtDevice }) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [device, setDevice] = useState(initial);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const alive = useRef(true);
  const left = useRef(false);
  const busyRef = useRef("");
  busyRef.current = busy;

  const reload = useCallback(async () => {
    invalidateSummary("bt");
    const list = await fetchBtDevices();
    const found = list.find((d) => d.mac === initial.mac);
    if (found && alive.current) setDevice(found);
    return found;
  }, [initial.mac]);

  useEffect(() => {
    alive.current = true;
    void reload();
    // A BLE remote sleeps and drops its link on its own, so a page that read the
    // state once would keep offering "Disconnect" for something already gone. Skip a
    // tick during an action so the poll cannot clobber the optimistic state.
    const iv = setInterval(() => {
      if (!busyRef.current) void reload();
    }, BT_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(iv);
    };
  }, [reload]);

  const run = async (action: Parameters<typeof btAction>[0], leave = false) => {
    if (busy || left.current) return;
    setBusy(action);
    setMsg("");
    const r = await btAction(action, device.mac);
    if (!alive.current) return;
    setBusy("");
    if (!r.ok) {
      setMsg(t("bt.failed", { name: device.name }));
      return;
    }
    if (leave) {
      // Latched: Back pressed while the remove was in flight has already popped this
      // page, and popping again would take the category pane with it.
      left.current = true;
      nav.pop();
      return;
    }
    await reload();
  };

  return (
    <SettingsPage id="bt-dev" title={device.name} onBack={nav.pop} animate="push">
      {busy && <Note tone="accent">{t("bt.working")}</Note>}
      {msg && <Note tone="warn">{msg}</Note>}
      <Group>
        <InfoRow label={t("bt.state")} value={device.connected ? t("bt.connected") : t("bt.paired")} />
        {device.battery != null && <InfoRow label={t("bt.battery")} value={device.battery + "%"} />}
      </Group>
      <Group>
        <Row
          id="conn"
          label={device.connected ? t("bt.disconnect") : t("bt.connect")}
          trailing="none"
          autoFocus
          onEnter={() => void run(device.connected ? "disconnect" : "connect")}
        />
        <Row
          id="remove"
          label={t("bt.remove")}
          hint={t("bt.removeHint")}
          trailing="none"
          // Leaves the page: the device it was about is gone.
          onEnter={() => void run("remove", true)}
        />
      </Group>
    </SettingsPage>
  );
}

function BluetoothPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const setBluetooth = useConfigStore((st) => st.setBluetooth);
  // `bluetooth?` as well as `config?`: this store is shared with app packages, so a
  // newer SDK can run against an older shell whose publicConfig has no bluetooth
  // section - and a throw inside a selector would take the whole screen down.
  const disableErtm = useConfigStore((st) => st.config?.bluetooth?.disableErtm) ?? false;
  const [status, setStatus] = useState<BtStatus | null>(null);
  const [devices, setDevices] = useState<BtDevice[] | null>(null); // null = first fetch in flight
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // mac being acted on
  const [msg, setMsg] = useState("");
  // The device whose pairing just failed. It gets the radio-quiet retry offered
  // underneath - only after a failure, because that retry takes the box off the
  // network for a moment and is not worth doing on a pairing that would work.
  const [retryQuiet, setRetryQuiet] = useState<BtDevice | null>(null);
  // Mirrors for the poll's closure, which would otherwise see stale state.
  const busyRef = useRef<string | null>(null);
  const scanningRef = useRef(false);
  busyRef.current = busy;
  scanningRef.current = scanning;

  // The BUILT-IN controller as a boot-config setting. A USB dongle brings its own
  // antenna, outside the case, and is only worth having once the built-in radio
  // stops sharing the one on the chip - and an owner who wants no Bluetooth at all
  // is entitled to that too. Nothing here checks for a dongle: the box cannot know
  // what is about to be plugged in, and the warning says what is lost either way.
  const [radios, setRadios] = useState<RadioState | null>(null);
  useEffect(() => {
    void radioState().then(setRadios);
  }, []);

  const toggleBuiltinBt = async () => {
    if (!radios) return;
    const want = radios.bt !== "on";
    setMsg(t("radios.applying"));
    const r = await setBuiltinRadio("bt", want);
    setMsg(r.ok ? t("radios.needsRestart") : t("radios.failed"));
    setRadios(await radioState());
  };

  const alive = useRef(true);
  const refresh = useCallback(() => {
    invalidateSummary("bt");
    void fetchBtStatus().then((s) => alive.current && setStatus(s));
    void fetchBtDevices().then((d) => alive.current && setDevices(d));
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    // A BLE remote sleeps and (dis)connects on its own, so poll while this page is
    // open or a stale "connected" lingers. Only while it is open - that is the point
    // of it being a page rather than a section of a bigger one. A tick is skipped
    // during an action so the poll cannot clobber the optimistic state.
    const iv = setInterval(() => {
      if (!busyRef.current && !scanningRef.current) refresh();
    }, BT_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(iv);
    };
  }, [refresh]);

  const scan = async () => {
    if (scanning) return;
    setScanning(true);
    setMsg("");
    // Eight seconds is long enough for the user to have left; writing the result then
    // would be reporting a scan to a screen nobody is on.
    const found = await btScan(8);
    if (!alive.current) return;
    setDevices(found);
    setScanning(false);
  };

  const pair = async (d: BtDevice, quiet = false) => {
    if (busy) return;
    setBusy(d.mac);
    setMsg(t(quiet ? "bt.pairingQuiet" : "bt.pairing", { name: d.name }));
    const r = await btAction(quiet ? "pair-quiet" : "pair", d.mac);
    if (!alive.current) return;
    setBusy(null);
    setMsg(r.ok ? "" : t("bt.failed", { name: d.name }));
    setRetryQuiet(r.ok ? null : d);
    refresh();
  };

  const list = devices || [];
  return (
    <SettingsPage id="bt" title={t("bt.title")} onBack={nav.pop} animate="push">
      {busy ? <Note tone="accent">{msg || t("bt.working")}</Note> : msg ? <Note>{msg}</Note> : null}
      {status && !status.powered && <Note tone="warn">{t("bt.off")}</Note>}

      <Group>
        <Row id="scan" label={scanning ? t("bt.scanning") : t("bt.scan")} trailing="none" autoFocus onEnter={scan} />
      </Group>

      <Group title={t("bt.groupDevices")}>
        {list.map((d) => (
          <Fragment key={d.mac}>
            <Row
              id={"dev-" + d.mac}
              label={d.name}
              // A speaker and a keyboard with unhelpful names are otherwise the same
              // row, and what you do next depends on which one it is.
              leading={btGlyph(d.type)}
              hint={d.battery != null ? t("bt.batteryAt", { pct: d.battery }) : undefined}
              value={d.connected ? t("bt.connected") : d.paired ? t("bt.paired") : t("bt.pair")}
              // A device we already know has more than one thing you might do with it;
              // an unknown one has exactly one, and pays one press for it.
              trailing={d.paired ? "chevron" : "none"}
              disabled={!!busy}
              onEnter={() =>
                d.paired
                  ? nav.push({
                      id: "bt-dev-" + d.mac,
                      title: d.name,
                      render: () => <BtDevicePage initial={d} />,
                    })
                  : void pair(d)
              }
            />
            {/* Under the device it failed for, not at the bottom of the list: this is
                offered because THAT pairing failed, and off-screen it might as well
                not exist. */}
            {retryQuiet?.mac === d.mac && (
              <Row
                id={"quiet-" + d.mac}
                label={t("bt.pairQuiet")}
                hint={t("bt.pairQuietHint")}
                trailing="none"
                autoFocus
                onEnter={() => void pair(d, true)}
              />
            )}
          </Fragment>
        ))}
        {devices && !devices.length && <InfoRow label={t("bt.none")} value="" />}
      </Group>

      {radios?.readable && radios.bt !== null && (
        <Group title={t("radios.groupBuiltin")} hint={t("radios.builtinHint")}>
          <ToggleRow
            id="builtin-bt"
            label={t("radios.builtinBt")}
            hint={
              !radios.helper
                ? t("radios.needsProvision")
                : radios.bt === "on"
                  ? t("radios.builtinBtOnHint")
                  : t("radios.builtinBtOffHint")
            }
            on={radios.bt === "on"}
            onToggle={() => {
              if (radios.helper) void toggleBuiltinBt();
            }}
            onWord={t("common.on")}
            offWord={t("common.off")}
          />
          {radios.bt === "on" && <Note tone="warn">{t("radios.btOffLosesRemotes")}</Note>}
        </Group>
      )}

      <Group title={t("bt.groupTroubleshooting")} hint={t("bt.ertmHint")}>
        <ToggleRow
          id="ertm"
          label={t("bt.ertm")}
          on={disableErtm}
          onToggle={() => void setBluetooth({ disableErtm: !disableErtm })}
          onWord={t("common.on")}
          offWord={t("common.off")}
        />
      </Group>
    </SettingsPage>
  );
}

// The existing remap screen, wrapped so it gets the page frame, the Back handler
// and the slide-in like everything else. Its focusables are its own and unmarked, so
// the page becomes a focus container and hands the focus to it - focusPolicy
// "legacy".
function RemoteButtonsPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  return (
    <SettingsPage
      id="remote"
      title={t("remote.title")}
      // The teaching instructions moved with the thing they describe: this screen
      // is now a list of remotes, and each one's buttons are a page below it.
      subtitle={t("remote.listHint")}
      onBack={nav.pop}
      animate="push"
      focusPolicy="legacy"
    >
      <RemoteRemap />
    </SettingsPage>
  );
}

export function PeripheralsPane() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const bt = useSummary("bt", fetchBtDevices);
  const ir = useSummary("ir", fetchIrStatus);
  const phone = useSummary("phoneremote", fetchPhoneRemote);
  // The remotes the BRIDGE can see, which is exactly what the page behind the row
  // lists. Counting `config.remote.devices` instead counted saved KEYMAPS, and the
  // two answer differently in both directions: a remote removed from Bluetooth
  // leaves its keymap behind (so the row went on counting a remote that is gone),
  // and a remote nobody has remapped has no entry at all (so it was never counted).
  const remotes = useSummary("remotes", fetchRemoteDevices);

  const btValue = !bt
    ? undefined
    : bt.filter((d) => d.connected).length
      ? t("bt.connectedN", { n: bt.filter((d) => d.connected).length })
      : t("bt.noneConnected");

  return (
    <SettingsPage id="periph" focusPolicy="rail">
      <Group>
        <Row
          id="bt"
          label={t("bt.title")}
          hint={t("peripherals.btHint")}
          value={btValue}
          onEnter={() => nav.push({ id: "bt", title: t("bt.title"), render: () => <BluetoothPage /> })}
        />
        <Row
          id="remote"
          label={t("remote.title")}
          hint={t("peripherals.remoteHint")}
          // Not remote.customCount - that one counts remapped BUTTONS on one remote.
          // `undefined` while the answer is still coming, so the row shows nothing
          // rather than "0 remotes" for a moment on every pass down the rail.
          value={remotes ? t("remote.devicesCount", { n: remotes.length }) : undefined}
          onEnter={() => nav.push({ id: "remote", title: t("remote.title"), render: () => <RemoteButtonsPage /> })}
        />
        <Row
          id="phoneremote"
          label={t("phoneRemote.title")}
          hint={t("peripherals.phoneRemoteHint")}
          value={
            phone?.kind === "ok"
              ? phone.state.enabled
                ? phone.state.phones.length
                  ? t("phoneRemote.pairedCount", { n: phone.state.phones.length })
                  : t("phoneRemote.on")
                : t("phoneRemote.off")
              : undefined
          }
          onEnter={() =>
            nav.push({
              id: "phoneremote",
              title: t("phoneRemote.title"),
              render: () => <PhoneRemoteSubPage onBack={nav.pop} />,
            })
          }
        />
        <Row
          id="ir"
          label={t("ir.title")}
          hint={t("peripherals.irHint")}
          value={ir ? (ir.configured ? t("ir.configured") : t("ir.notConfigured")) : undefined}
          onEnter={() => nav.push({ id: "ir", title: t("ir.title"), render: () => <IrPage /> })}
        />
      </Group>
    </SettingsPage>
  );
}
