import { useEffect, useRef, useState } from "react";
import type { IrAction, IrBackend } from "@sdk/config";
import { useI18n } from "../../lib/i18n";
import { useConfigStore } from "../../stores/config";
import { sendIr, fetchIrStatus, type IrStatus } from "../../lib/ir";
import { fetchIrSetup, deviceKeys, type IrSetup, type IrKey } from "../../lib/firetvir";
import { SettingsPage } from "../SettingsPage";
import { ChoicePage } from "../ChoicePage";
import { Group, Note, Row, TextRow } from "../Rows";
import { useSettingsNav } from "../nav";
import { invalidateSummary } from "../summary";

// Settings -> Remotes & accessories -> TV volume: a network IR blaster for a TV
// that takes no volume over CEC (shell ir.js). Two backends - an ESPHome
// transceiver over its native API, or Home Assistant scripts, which covers
// Broadlink and friends.
//
// Every row saves immediately and the shell reconnects; secrets are write-only, so
// an empty submit keeps the stored value (TextRow already does that).
//
// The command mapping is TYPED, not picked from a list, and that is not an oversight.
// `/tvbox/api/ir/status` reports `actions` as the keys of the mapping the box already
// has (shell/ir.js), NOT the signal options the device offers - so a picker built from
// it would offer the three command names as if they were signal slots, and would
// appear the moment the first mapping was saved, locking out the typing that is the
// only way to enter a real slot name.
// Every action the blaster knows (shell/config.js IR_ACTIONS). The TV's own input and
// a soundbar are here because HDMI-CEC cannot express either: a source device can only
// make ITSELF the active source, and a soundbar is usually not on the bus at all.
const ACTIONS: IrAction[] = [
  "volume_up",
  "volume_down",
  "mute",
  "tv_power",
  "input_hdmi1",
  "input_hdmi2",
  "input_hdmi3",
  "input_hdmi4",
  "soundbar_power",
  "soundbar_volume_up",
  "soundbar_volume_down",
  "soundbar_mute",
];

export function IrPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const config = useConfigStore((s) => s.config);
  const setIr = useConfigStore((s) => s.setIr);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<IrStatus | null>(null);
  const [tested, setTested] = useState<{ action: IrAction; ok: boolean; cause?: string; busy?: boolean } | null>(null);

  const ir = config?.ir;
  const backend: IrBackend = ir?.backend || "esphome";
  const es = ir?.esphome;
  const ha = ir?.homeassistant;
  const fv = ir?.firetv;
  const actions = (backend === "esphome" ? es?.actions : backend === "firetv" ? fv?.actions : ha?.actions) || {};

  // What the `firetv` backend can actually send: the entries of the remote's saved code
  // plan. A free-text `<kind>:<Key>` was the first cut and it is the wrong question to
  // ask in front of a television - the value is a machine token, case-sensitive on both
  // halves, and a typo is dropped by the save with nothing on screen to say so.
  // `undefined` = not asked yet, `null` = the box could not be asked, a plan = asked.
  // The three are different sentences on screen, and conflating them told somebody to
  // go and build a plan they already had.
  const [setup, setSetup] = useState<IrSetup | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setSetup(undefined);
    if (backend === "firetv" && fv?.mac) void fetchIrSetup(fv.mac).then((s) => alive && setSetup(s));
    return () => {
      alive = false;
    };
  }, [backend, fv?.mac]);

  // One entry per (device kind, key) the plan carries, labelled in the reader's own
  // language. Deduplicated by target, first device winning - which is the same rule the
  // box itself applies when two devices of a kind carry the key. The KEY comes first
  // because the value is truncated from the right, and which button it is matters more
  // than which kind of device - "Egyéb (távirányító-cikkszám)" alone fills the width.
  const allTargets: { id: string; label: string; kind: string; key: IrKey }[] = [];
  for (const dev of setup?.devices || []) {
    for (const key of deviceKeys(dev) as IrKey[]) {
      const id = `${dev.kind}:${key}`;
      if (allTargets.some((x) => x.id === id)) continue;
      allTargets.push({
        id,
        kind: dev.kind,
        key,
        label: `${t("firetvir.key." + key)} · ${t("firetvir.kind." + dev.kind)}`,
      });
    }
  }
  // An action only offers targets that could possibly BE it. Without this the four
  // "TV input HDMI n" rows offered the television's Power key as readily as anything
  // else - bind that and the input action turns the set off while the assistant reports
  // the input switched.
  // A key set per action, and the mirror cases matter as much as the obvious one: with
  // no filter at all, `volume_up` offered the television's Power key just as readily,
  // so "hangosítsd fel a tévét" would switch the set off. `Input` is deliberately NOT
  // an input target - it is the TV's own Source key, which opens a menu no remote the
  // box owns can drive, which is why there is no action for it any more.
  const KEYS_FOR = (a: IrAction): string[] | null => {
    if (a.startsWith("input_")) return ["HDMI1", "HDMI2", "HDMI3", "HDMI4"];
    if (a.endsWith("_power") || a === "tv_power") return ["Power"];
    if (a.endsWith("mute")) return ["Mute"];
    if (a.endsWith("volume_up")) return ["VolumeUp"];
    if (a.endsWith("volume_down")) return ["VolumeDown"];
    return null;
  };
  // Which DEVICE kinds an action may point at. "not a television" was too loose: it let
  // a soundbar action bind to a set-top box's Power, which is a device nobody means by
  // "soundbar" and which the label on the row does not warn about. A TV input or the
  // TV's own power is meaningless anywhere but the television. Volume and mute stay open
  // on purpose - a house whose TV volume goes through the amplifier is an ordinary
  // setup, and that is the one case where either kind is right.
  const KINDS_FOR = (a: IrAction) => {
    if (a.startsWith("soundbar_")) return ["audio"];
    if (a === "tv_power" || a.startsWith("input_")) return ["tv"];
    return null;
  };
  const targetsFor = (a: IrAction) => {
    const keys = KEYS_FOR(a);
    const kinds = KINDS_FOR(a);
    return allTargets.filter((x) => (!keys || keys.includes(x.key)) && (!kinds || kinds.includes(x.kind)));
  };
  const targetLabel = (v?: string) => allTargets.find((x) => x.id === v)?.label || v || "";
  // Which sentence the row gets when it has nothing to offer.
  const emptyHint = (a: IrAction) => {
    if (setup === undefined) return undefined; // still loading; say nothing yet
    if (setup === null) return t("ir.planUnreadable");
    if (!allTargets.length) return t("ir.noPlanHint");
    return targetsFor(a).length ? undefined : t("ir.noSuitableTarget");
  };

  useEffect(() => {
    let alive = true;
    void fetchIrStatus().then((s) => alive && setStatus(s));
    invalidateSummary("ir");
    return () => {
      alive = false;
    };
  }, [config?.ir, tested]);

  // Full-block saves: the shell replaces the block from what we send, except
  // secrets, where "" means "keep the stored one".
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
  // The Fire TV remote carries no secret of its own - the BlueZ bond is the whole
  // credential - so this block is a MAC and the action map.
  const saveFiretv = async (patch: Record<string, unknown>) => {
    setFailed(false);
    try {
      // The MAC is only sent when we HAVE one: an empty string is how the block is
      // cleared, and this function also runs for an action save that knows nothing
      // about the address.
      await setIr({ firetv: { ...(fv?.mac ? { mac: fv.mac } : {}), actions: fv?.actions || {}, ...patch } });
    } catch {
      setFailed(true);
    }
  };
  const saveAction = (a: IrAction, value: string) => {
    const next = { ...actions, [a]: value }; // "" is dropped by the shell = unmapped
    if (backend === "esphome") return saveEs({ actions: next });
    if (backend === "firetv") return saveFiretv({ actions: next });
    return saveHa({ actions: next });
  };
  // The picker's contract is that a rejected write THROWS, so it stays open and shows
  // its own failure line. Going through saveAction would swallow it into `failed` on
  // this page - which the nav has unmounted while the picker is up, so nothing would be
  // reported anywhere.
  const pickAction = async (a: IrAction, value: string) => {
    const next = { ...actions, [a]: value };
    await setIr({ firetv: { ...(fv?.mac ? { mac: fv.mac } : {}), actions: next } });
  };

  // A blast through a Fire TV remote takes up to twelve seconds, so a press with no
  // sign of life invites a second one - which queues a second blast behind the first.
  const [testing, setTesting] = useState<IrAction | null>(null);
  // A ref as well as state: two OK presses inside one render commit would both read the
  // stale `testing` and send twice, and the remote's blaster is not something to send
  // twice by accident - a power toggle undoes itself.
  const testingRef = useRef<IrAction | null>(null);
  const test = async (a: IrAction) => {
    if (testingRef.current) {
      // Saying so, rather than nothing: with the row no longer disabled, a press that
      // silently did nothing for up to twelve seconds was the new dead button.
      setTested({ action: a, ok: false, busy: true });
      return;
    }
    setTested(null);
    testingRef.current = a;
    setTesting(a);
    try {
      const r = await sendIr(a);
      setTested({ action: a, ok: r.ok, cause: r.cause });
    } finally {
      testingRef.current = null;
      setTesting(null);
    }
  };

  const pushBackendPicker = () =>
    nav.push({
      id: "ir-backend",
      title: t("ir.backendTitle"),
      render: () => (
        <ChoicePage
          id="ir-backend"
          title={t("ir.backendTitle")}
          failLabel={t("ir.saveFailed")}
          options={(["esphome", "homeassistant", "firetv"] as IrBackend[]).map((b) => ({
            id: b,
            label: t("ir.backend." + b),
          }))}
          value={backend}
          // Deliberately not caught: the page below is unmounted while this is open, so
          // reporting a rejected write there would report it to nobody. ChoicePage
          // stays put and says so instead.
          onPick={(b) => setIr({ backend: b as IrBackend }).then(() => undefined)}
        />
      ),
    });

  return (
    <SettingsPage id="ir" title={t("ir.title")} subtitle={t("ir.hint")} onBack={nav.pop} animate="push">
      {failed && <Note tone="warn">{t("ir.saveFailed")}</Note>}
      {/* What the last failure MEANT, in the viewer's language. The shell classifies it
          (ir.js causeOf) so this says the same thing as the toast on the TV; showing
          `lastError` here put an English sentence on a Hungarian screen. And a link
          that is merely down is NOT an unreachable blaster - a sleeping remote is one
          button press away, which is what `ir.failed.asleep` says. */}
      {/* The LAST failure, said as one: a box that blasts once a day would otherwise
          carry a single failure as a standing claim about the present. A link that is
          merely down gets no note at all - it is the resting state of a healthy box,
          because the remote sleeps and the link is opened by the next blast. */}
      {status?.lastError && !tested ? (
        <Note tone="warn">{t("ir.lastFailure", { reason: t("ir.failed." + (status.cause || "other")) })}</Note>
      ) : null}
      {status?.service?.failed ? <Note tone="warn">{t("ir.serviceFailed")}</Note> : null}
      {tested ? (
        <Note tone={tested.ok ? "ok" : "warn"}>
          {tested.ok ? t("ir.testOk") : tested.busy ? t("ir.testRunning") : t("ir.failed." + (tested.cause || "other"))}
        </Note>
      ) : null}
      {/* The firetv backend has no host or URL to clear, so the generic hint would tell
          somebody to empty a field that is not there. */}
      <Note>{backend === "firetv" ? t("ir.offHintFiretv") : t("ir.offHint")}</Note>

      <Group>
        <Row
          id="backend"
          label={t("ir.backendTitle")}
          value={t("ir.backend." + backend)}
          autoFocus
          onEnter={pushBackendPicker}
        />
      </Group>

      {backend === "esphome" ? (
        <Group title={t("ir.groupDevice")}>
          <TextRow
            id="host"
            label={t("ir.host")}
            title={t("ir.host")}
            value={es?.host}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => void saveEs({ host: v.trim() })}
          />
          <TextRow
            id="port"
            label={t("ir.port")}
            title={t("ir.port")}
            value={es?.port ? String(es.port) : ""}
            emptyLabel={t("ir.portDefault")}
            onSubmit={(v) => {
              const n = /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : NaN;
              void saveEs({ port: n >= 1 && n <= 65535 ? n : null }); // blank or junk = the default
            }}
          />
          <TextRow
            id="key"
            label={t("ir.encryptionKey")}
            title={t("ir.encryptionKey")}
            secret
            hasSecret={!!es?.hasEncryptionKey}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => v && void saveEs({ encryptionKey: v })}
          />
          <TextRow
            id="select"
            label={t("ir.selectEntity")}
            title={t("ir.selectEntity")}
            value={es?.select}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => void saveEs({ select: v.trim() })}
          />
          <TextRow
            id="button"
            label={t("ir.buttonEntity")}
            title={t("ir.buttonEntity")}
            value={es?.button}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => void saveEs({ button: v.trim() })}
          />
        </Group>
      ) : backend === "firetv" ? (
        <Group title={t("ir.groupDevice")}>
          <TextRow
            id="mac"
            label={t("ir.mac")}
            title={t("ir.mac")}
            value={fv?.mac}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => void saveFiretv({ mac: v.trim() })}
          />
        </Group>
      ) : (
        <Group title={t("ir.groupDevice")}>
          <TextRow
            id="haurl"
            label={t("ir.haUrl")}
            title={t("ir.haUrl")}
            value={ha?.url}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => void saveHa({ url: v.trim() })}
          />
          <TextRow
            id="hatoken"
            label={t("ir.haToken")}
            title={t("ir.haToken")}
            secret
            hasSecret={!!ha?.hasToken}
            emptyLabel={t("common.notSet")}
            onSubmit={(v) => v && void saveHa({ token: v })}
          />
        </Group>
      )}

      <Group
        title={t("ir.actionsTitle")}
        hint={
          backend === "esphome"
            ? t("ir.actionsHintEsphome")
            : backend === "firetv"
              ? t("ir.actionsHintFiretv")
              : t("ir.actionsHintHa")
        }
      >
        {ACTIONS.map((a) =>
          backend === "firetv" ? (
            <Row
              key={a}
              id={"map-" + a}
              label={t("ir.action." + a)}
              value={actions[a] ? targetLabel(actions[a]) : t("ir.notSet")}
              // Nothing to pick from means the remote has no saved code plan yet, and
              // the row says where that is built rather than opening an empty list.
              hint={emptyHint(a)}
              onEnter={() =>
                // Openable when there is something to pick, and also when there is
                // something to CLEAR - a mapping left behind by an erased plan shows as
                // a raw token, and a row that cannot be opened can never lose it.
                (targetsFor(a).length || actions[a]) &&
                nav.push({
                  id: "ir-target-" + a,
                  title: t("ir.action." + a),
                  render: () => (
                    <ChoicePage
                      id={"ir-target-" + a}
                      title={t("ir.action." + a)}
                      failLabel={t("ir.saveFailed")}
                      options={[{ id: "", label: t("ir.notSet") }, ...targetsFor(a)]}
                      value={actions[a] || ""}
                      onPick={(v) => pickAction(a, v)}
                    />
                  ),
                })
              }
            />
          ) : (
            <TextRow
              key={a}
              id={"map-" + a}
              label={t("ir.action." + a)}
              title={t("ir.action." + a)}
              value={actions[a]}
              emptyLabel={t("ir.notSet")}
              onSubmit={(v) => void saveAction(a, v.trim())}
            />
          ),
        )}
      </Group>

      {/* Only when there is something to test - the header over an empty card reads as
          a screen that failed to load. */}
      {ACTIONS.some((a) => actions[a]) ? (
        <Group title={t("ir.groupTest")} hint={backend === "firetv" ? t("ir.awakeHintFiretv") : undefined}>
          {ACTIONS.filter((a) => actions[a]).map((a) => (
            <Row
              key={a}
              id={"test-" + a}
              label={(testing === a ? t("ir.testing") : t("ir.test")) + " · " + t("ir.action." + a)}
              // The notes are at the top of a page a screen and a half up, so the
              // outcome also lands on the row that was pressed.
              hint={
                tested && tested.action === a && !tested.busy
                  ? tested.ok
                    ? t("ir.testOk")
                    : t("ir.failed." + (tested.cause || "other"))
                  : undefined
              }
              trailing="none"
              // NOT disabled while a test runs: a disabled row loses its focus key, so
              // the cursor jumped to the top of the page and the next OK opened the
              // blaster-type picker - which unmounts this page and throws the result
              // away. test() already ignores a second press while one is in flight.
              disabled={!actions[a]}
              onEnter={() => void test(a)}
            />
          ))}
        </Group>
      ) : null}
    </SettingsPage>
  );
}
