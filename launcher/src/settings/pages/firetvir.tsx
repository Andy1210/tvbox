import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteDeviceConfig } from "@sdk/config";
import { useI18n } from "../../lib/i18n";
import { useConfigStore } from "../../stores/config";
import {
  IR_KEYS,
  deviceKeys,
  deviceSupported,
  eraseIr,
  fetchBrandDevices,
  fetchIrIndex,
  fetchIrSetup,
  fetchIrStatus,
  forKey,
  installIrDeps,
  planDevice,
  programIr,
  saveIrSetup,
  testIrKey,
  type FiretvIrStatus,
  type IrAssign,
  type IrBrandListing,
  type IrDevice,
  type IrKey,
  type IrPlanDevice,
  type IrSetup,
} from "../../lib/firetvir";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row, StepperRow, ToggleRow, TextRow } from "../Rows";
import { useSettingsNav } from "../nav";

// Settings → Remotes & accessories → (a Fire TV / Alexa remote) → TV IR.
//
// The remote has its own IR LED, and a Fire TV normally programs it over a custom
// BLE service during "Equipment Control". The box does that instead - the plumbing
// is shell/firetvir.js + remote/firetv_remote_ir.py; this is the screen.
//
// It is built around DEVICES, not codesets, because that is the question the user
// actually has: "the volume should go to the soundbar, the power to the TV". You add
// what is in the room, then say which button drives which - the four-key plan the
// box programs is derived from that, never edited directly.
//
// Two rules the shape follows, both from settings/nav.tsx: a pushed page owns the
// state it shows (so every level here reads the plan from the box on mount, and the
// box is what they agree through), and the picker chain returns with `popTo` rather
// than leaving three screens to Back past.
//
// Everything is a `Row`. The old screen used wrapped grids of `FocusButton`s, which
// scale on focus - and the layout adapter measures the SCALED box, so a focused
// button overlaps its neighbours and spatial navigation drops them from its
// candidate list. Rows in a Group touch by design and never transform.
const KEY_ORDER: IrKey[] = [...IR_KEYS];
const DEPS_POLL_MS = 2000;
const MAX_LISTED_BRANDS = 60; // a search that matches more than this asks for another letter
// Mirrors shell/firetvir.js: MAX_PLAN_DEVICES bounds what one remote may carry, and
// sanitizePlan keeps the FIRST that many - so the screen has to refuse the extra one
// itself, or the device just chosen is the one silently dropped.
const MAX_PLAN_DEVICES = 8;
// The order the type filter cycles in, matching the order the box sorts the list.
const KIND_ORDER_UI = ["tv", "audio", "settop", "player", "climate", "other"];

// A brand's first letter, as the index groups it. Anything not A-Z shares one
// bucket - irdb has ~40 such brands and none of them deserves its own screen.
const initial = (brand: string): string => {
  const c = brand.trim().charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
};

// ---- shared state: the plan lives on the box ------------------------------------
// Every page here reads it on mount and writes it whole. That is what lets a level
// change something the level below it will show, without handing a callback across
// an unmount (settings/nav.tsx).
// `setup` stays null until the box has really answered. A read that FAILED must
// never look like "nothing configured": every writer here sends the whole plan, so
// a page that took an empty answer for a fact would save that emptiness over a
// remote that is fully set up.
function useIrSetup(mac: string) {
  const [setup, setSetup] = useState<IrSetup | null>(null);
  const [error, setError] = useState<"read" | "write" | null>(null);
  const alive = useRef(true);
  // Answers can land out of order (two quick presses, two whole-plan writes), and
  // the last one to ARRIVE is not the last one sent. Only the newest write may
  // paint the screen.
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const s = await fetchIrSetup(mac);
    if (!alive.current || mine !== seq.current) return;
    if (s) {
      setSetup(s);
      setError(null);
    } else setError("read");
  }, [mac]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  const save = useCallback(
    async (next: IrSetup) => {
      const mine = ++seq.current;
      const prev = setup;
      setSetup(next); // shown at once: a row that lags the press reads as an ignored press
      const kept = await saveIrSetup(mac, next);
      if (!alive.current || mine !== seq.current) return kept;
      // ...then corrected to what the box really stored, or put back: a screen that
      // keeps showing a change the box refused is the worst of the three states.
      if (kept) {
        setSetup(kept);
        setError(null);
      } else {
        setSetup(prev);
        setError("write");
      }
      return kept;
    },
    [mac, setup],
  );
  return { setup, error, save, reload };
}

const deviceName = (d: IrPlanDevice): string => (d.brand ? d.brand + " " + d.label : d.label);

// What gets written into the remote's keymap as its name - the devices it drives,
// so a later look at `status.configured` says something.
const planLabel = (setup: IrSetup): string => {
  const used = new Set(Object.values(setup.assign).flatMap((a) => (a ? [a.device, a.second] : [])));
  const names = setup.devices.filter((d) => used.has(d.id)).map(deviceName);
  return (names.join(" + ") || "custom").slice(0, 60);
};

// ---- the codeset picker ----------------------------------------------------------
// Brand -> letter -> the brand's devices. `forKey` narrows the last step to codes
// that can drive that button; `replaceId` swaps a device already in the plan and
// keeps its button assignments.
interface PickProps {
  mac: string;
  home: number; // the main page's depth: where a finished pick returns to
  forKey?: IrKey;
  replaceId?: string;
}

function BrandDevicesPage({
  mac,
  home,
  brand,
  slug,
  forKey: onlyFor,
  replaceId,
}: PickProps & { brand: string; slug: string }) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  // `null` = the box has not answered yet. One small file per brand, so there is nothing
  // to report progress about any more - the codes were merged when the index was built.
  const [state, setState] = useState<{ devices: IrDevice[]; skipped: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [onlyUsable, setOnlyUsable] = useState(true);
  const [kind, setKind] = useState("all");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      const r = await fetchBrandDevices(slug);
      if (!alive.current) return;
      if (!r.ok) return setError(r.error || "error");
      setState({ devices: r.devices || [], skipped: r.skipped || 0 });
      setLoaded(true);
    })();
    return () => {
      alive.current = false;
    };
  }, [slug, attempt]);

  const retry = () => {
    setError("");
    setState(null);
    setLoaded(false);
    setAttempt((n) => n + 1);
  };

  const all = state?.devices || [];
  // Only the kinds this brand really has, so the row never offers an empty answer.
  const kinds = ["all", ...KIND_ORDER_UI.filter((k) => all.some((d) => d.kind === k))];
  const shown = all.filter(
    (d) => (!onlyUsable || !onlyFor || !!d.keys[onlyFor]) && (kind === "all" || d.kind === kind),
  );

  const pick = async (d: IrDevice) => {
    if (saving) return;
    setSaving(true);
    setMsg("");
    try {
      // Read the plan again rather than trusting a copy taken when this page opened: the
      // levels above are unmounted, and this page can sit open while someone reads a
      // long list.
      const cur = await fetchIrSetup(mac);
      // A read that FAILED is not an empty plan. Writing here sends the whole thing, so
      // it would erase every device this remote already drives - and nothing was sent, so
      // say that rather than blaming the save.
      if (!cur) return setMsg(t("firetvir.readFailed"));
      // The codes travel INTO the plan, so what gets programmed is what was chosen even
      // if a later index build renames or regroups this device.
      const dev: IrPlanDevice = planDevice(d, brand, slug);
      const assign: IrAssign = { ...cur.assign };
      let devices = cur.devices.filter((x) => x.id !== dev.id && x.id !== replaceId);
      if (replaceId) {
        for (const k of KEY_ORDER) {
          const a = assign[k];
          if (!a) continue;
          const device = a.device === replaceId ? dev.id : a.device;
          const second = a.second === replaceId ? dev.id : a.second;
          // The replacement may not carry every button the old device did, and a button
          // pointed at a code with no row for it is programmed as nothing.
          if (device === dev.id && !dev.keys[k]) delete assign[k];
          else assign[k] = { device, second: second && second !== device ? second : null };
        }
      }
      if (devices.length >= MAX_PLAN_DEVICES) return setMsg(t("firetvir.tooManyDevices", { n: MAX_PLAN_DEVICES }));
      devices = [...devices, dev];
      if (onlyFor) {
        const prev = assign[onlyFor];
        assign[onlyFor] = { device: dev.id, second: prev?.second && prev.second !== dev.id ? prev.second : null };
      }
      // A new device takes every button nobody has claimed yet. Adding the TV first
      // should leave the screen set up, not with four rows still reading "not set".
      for (const k of KEY_ORDER) if (!assign[k] && dev.keys[k]) assign[k] = { device: dev.id, second: null };
      const kept = await saveIrSetup(mac, { ...cur, devices, assign });
      if (!kept || !kept.devices.some((x) => x.id === dev.id)) return setMsg(t("firetvir.saveFailed"));
      nav.popTo(home);
    } finally {
      // Always: popTo is a no-op if Back already left this level, and a page whose
      // rows stayed disabled for ever would be a dead screen.
      if (alive.current) setSaving(false);
    }
  };

  const keyWords = (d: IrDevice) =>
    deviceKeys(d)
      .map((k) => t("firetvir.key." + k))
      .join(", ");
  const sourceWord = (d: IrDevice) => d.sources.map((s) => t("firetvir.source." + s)).join(" + ");

  return (
    <SettingsPage id="ftir-sets" title={brand} subtitle={t("firetvir.setsHint")} onBack={nav.pop} animate="push">
      {msg && <Note tone="warn">{msg}</Note>}
      {error && <Note tone="warn">{t("firetvir.brandsError", { error })}</Note>}
      {!state && !error && <Note>{t("firetvir.loading")}</Note>}

      {!!error && (
        <Group>
          <Row id="retry" label={t("firetvir.retry")} trailing="none" autoFocus onEnter={retry} />
        </Group>
      )}

      {all.length > 0 && (
        <Group>
          {onlyFor && (
            <ToggleRow
              id="onlyusable"
              label={t("firetvir.onlyWith", { key: t("firetvir.key." + onlyFor) })}
              hint={t("firetvir.onlyWithHint")}
              on={onlyUsable}
              onToggle={() => setOnlyUsable((v) => !v)}
              onWord={t("common.on")}
              offWord={t("common.off")}
            />
          )}
          {/* Left/right, in place. A pushed picker cannot work here: the level below
              is UNMOUNTED while it is open (settings/nav.tsx), so its setState lands
              on a dead component and the remount brings back the default. */}
          {kinds.length > 2 && (
            <StepperRow
              id="kind"
              label={t("firetvir.kindFilter")}
              hint={t("firetvir.kindFilterHint")}
              display={t("firetvir.kind." + kind)}
              onStep={(delta) => {
                const i = kinds.indexOf(kind);
                setKind(kinds[(i + delta + kinds.length) % kinds.length]);
              }}
            />
          )}
        </Group>
      )}

      <Group title={loaded ? t("firetvir.devicesFound", { n: shown.length }) : undefined}>
        {shown.map((d) => (
          <Row
            key={d.id}
            id={"dev-" + d.id}
            label={d.label}
            hint={
              deviceSupported(d)
                ? t("firetvir.kind." + d.kind) + " · " + keyWords(d) + " · " + sourceWord(d)
                : t("firetvir.unsupported", { protocol: d.protocols.join(", ") })
            }
            value={d.count > 1 ? t("firetvir.sameCode", { n: d.count }) : d.variant}
            trailing="none"
            // A protocol this box cannot generate would blast nothing at all, so it
            // is offered as unpressable rather than as a code that silently fails.
            disabled={!deviceSupported(d) || saving}
            onEnter={() => void pick(d)}
          />
        ))}
        {/* Only once the box has really answered: "nothing here" while the codesets
            are still coming down reads as a brand with no codes at all. */}
        {loaded && !shown.length && <InfoRow label={t("firetvir.noneHere")} value="" />}
      </Group>
      {loaded && !!state?.skipped && <Note>{t("firetvir.skipped", { n: state.skipped })}</Note>}
      <Note>{t("firetvir.credit")}</Note>
    </SettingsPage>
  );
}

// A brand row, wherever it is listed: what it is called and what a fetch of it is
// addressed by (the slug the published index gives it).
function brandRow(
  b: IrBrandListing,
  t: (k: string, v?: Record<string, string | number>) => string,
  open: (b: IrBrandListing) => void,
) {
  return (
    <Row
      key={b.slug}
      id={"brand-" + b.slug}
      label={b.brand}
      value={t("firetvir.deviceCount", { n: b.devices })}
      onEnter={() => open(b)}
    />
  );
}

function BrandListPage({ mac, home, forKey: onlyFor, replaceId, letter }: PickProps & { letter: string }) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [brands, setBrands] = useState<IrBrandListing[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    void fetchIrIndex().then((r) => {
      if (!alive) return;
      // An empty list and a failed fetch look identical once the error is dropped, and
      // the second one leaves a page with a letter for a title and nothing on it.
      if (!r.ok || !r.brands) return setError(r.error || "error");
      setError("");
      setBrands(r.brands.filter((b) => initial(b.brand) === letter));
    });
    return () => {
      alive = false;
    };
  }, [letter, attempt]);

  const open = (b: IrBrandListing) =>
    nav.push({
      id: "ftir-sets-" + b.slug,
      title: b.brand,
      render: () => (
        <BrandDevicesPage mac={mac} home={home} brand={b.brand} slug={b.slug} forKey={onlyFor} replaceId={replaceId} />
      ),
    });

  return (
    <SettingsPage id="ftir-letter" title={letter} onBack={nav.pop} animate="push">
      {error && <Note tone="warn">{t("firetvir.brandsError", { error })}</Note>}
      {!brands && !error && <Note>{t("firetvir.loading")}</Note>}
      {error && (
        <Group>
          <Row
            id="retry"
            label={t("firetvir.retry")}
            trailing="none"
            autoFocus
            onEnter={() => {
              setError("");
              setAttempt((n) => n + 1);
            }}
          />
        </Group>
      )}
      <Group>{(brands || []).map((b) => brandRow(b, t, open))}</Group>
    </SettingsPage>
  );
}

function BrandPickerPage({ mac, home, forKey: onlyFor, replaceId }: PickProps) {
  const { t, tag } = useI18n();
  const nav = useSettingsNav();
  const [brands, setBrands] = useState<IrBrandListing[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [suggested, setSuggested] = useState<string | null>(null);
  const [built, setBuilt] = useState("");

  const load = useCallback(async () => {
    setError("");
    const r = await fetchIrIndex();
    if (r.ok && r.brands) {
      setBrands(r.brands);
      // When the list was built. It is a downloaded file the box keeps for a month, so
      // "my new TV is not in here" has an answer that is not a shrug.
      const d = new Date(r.generated || "");
      // The launcher's own locale, not the browser's: a Hungarian UI must not print an
      // English date.
      setBuilt(isNaN(d.getTime()) ? "" : d.toLocaleDateString(tag));
    } else setError(r.error || "error");
  }, [tag]);

  useEffect(() => {
    void load();
    void fetchIrStatus().then((s) => s && setSuggested(s.suggestedBrand));
  }, [load]);

  const open = (b: IrBrandListing) =>
    nav.push({
      id: "ftir-sets-" + b.slug,
      title: b.brand,
      render: () => (
        <BrandDevicesPage mac={mac} home={home} brand={b.brand} slug={b.slug} forKey={onlyFor} replaceId={replaceId} />
      ),
    });
  const openLetter = (letter: string) =>
    nav.push({
      id: "ftir-letter-" + letter,
      title: letter,
      render: () => <BrandListPage mac={mac} home={home} letter={letter} forKey={onlyFor} replaceId={replaceId} />,
    });

  const q = query.trim().toLowerCase();
  const hits = q ? (brands || []).filter((b) => b.brand.toLowerCase().includes(q)) : [];
  // The letter index exists because there are over a thousand brands: listing even the
  // first screenful of them is a wall nobody reads, and the ones past it are unreachable.
  const letters = [...new Set((brands || []).map((b) => initial(b.brand)))].sort();
  const counts = new Map<string, number>();
  for (const b of brands || []) counts.set(initial(b.brand), (counts.get(initial(b.brand)) || 0) + 1);

  return (
    <SettingsPage
      id="ftir-brand"
      title={onlyFor ? t("firetvir.pickFor", { key: t("firetvir.key." + onlyFor) }) : t("firetvir.pickBrand")}
      subtitle={t("firetvir.pickBrandHint")}
      onBack={nav.pop}
      animate="push"
    >
      {error && <Note tone="warn">{t("firetvir.brandsError", { error })}</Note>}
      {!brands && !error && <Note>{t("firetvir.loading")}</Note>}
      <Group>
        <TextRow
          id="search"
          label={t("firetvir.filterBrand")}
          title={t("firetvir.filterBrand")}
          value={query}
          emptyLabel={t("firetvir.filterAny")}
          autoFocus
          onSubmit={(v) => setQuery(v)}
        />
        {error && <Row id="retry" label={t("firetvir.retry")} trailing="none" onEnter={() => void load()} />}
        {/* The box read the TV's brand off the HDMI EDID, so the commonest answer is
            one press away and the alphabet is for everything else. */}
        {!q &&
          suggested &&
          (() => {
            const hit = (brands || []).find((b) => b.brand === suggested);
            return hit ? (
              <Row id="suggested" label={hit.brand} hint={t("firetvir.suggestedHint")} onEnter={() => open(hit)} />
            ) : null;
          })()}
      </Group>

      {q ? (
        <Group title={t("firetvir.matches", { n: hits.length })}>
          {hits.slice(0, MAX_LISTED_BRANDS).map((b) => brandRow(b, t, open))}
          {!hits.length && brands && <InfoRow label={t("firetvir.noMatch")} value="" />}
          {hits.length > MAX_LISTED_BRANDS && <InfoRow label={t("firetvir.narrow")} value="" />}
        </Group>
      ) : (
        <Group title={t("firetvir.byLetter")}>
          {letters.map((l) => (
            <Row
              key={l}
              id={"letter-" + l}
              label={l === "#" ? t("firetvir.letterOther") : l}
              value={t("firetvir.brandCount", { n: counts.get(l) || 0 })}
              onEnter={() => openLetter(l)}
            />
          ))}
        </Group>
      )}
      {!!built && <Note>{t("firetvir.indexAge", { date: built })}</Note>}
    </SettingsPage>
  );
}

// ---- one configured device -------------------------------------------------------
function IrDevicePage({ mac, home, deviceId }: { mac: string; home: number; deviceId: string }) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const { setup, error, save, reload } = useIrSetup(mac);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const left = useRef(false);

  const dev = setup?.devices.find((d) => d.id === deviceId);
  const usedBy = setup ? KEY_ORDER.filter((k) => setup.assign[k]?.device === deviceId) : [];

  const canDrive = dev ? deviceKeys(dev) : [];

  const test = async () => {
    if (!setup || !dev || !canDrive.length || busy) return;
    // A button this device is really used for AND can really send. Testing a key it was
    // assigned to but has no code for would fail with a puzzling error instead of
    // proving anything.
    const key = usedBy.find((k) => !!dev.keys[k]) || canDrive[0];
    setBusy(true);
    setMsg(null);
    // Point the blast at THIS device even if the button is assigned elsewhere.
    const r = await testIrKey(mac, forKey(setup, key, deviceId), key);
    setBusy(false);
    setMsg({
      ok: r.ok,
      text: r.ok
        ? t("firetvir.testSent", { key: t("firetvir.key." + key) })
        : t("firetvir.testFailed", { error: r.error || r.output || "?" }),
    });
  };

  const remove = async () => {
    if (!setup || left.current) return;
    const assign: IrAssign = {};
    for (const k of KEY_ORDER) {
      const a = setup.assign[k];
      if (!a || a.device === deviceId) continue;
      assign[k] = { device: a.device, second: a.second === deviceId ? null : a.second };
    }
    const kept = await save({ ...setup, devices: setup.devices.filter((d) => d.id !== deviceId), assign });
    // Only leave if it really went: popping on a refused write shows the device
    // still there on the page below, with nothing said about why.
    if (!kept) return setMsg({ ok: false, text: t("firetvir.saveFailed") });
    left.current = true;
    nav.pop();
  };

  return (
    <SettingsPage
      id="ftir-dev"
      title={dev ? deviceName(dev) : t("firetvir.deviceTitle")}
      onBack={nav.pop}
      animate="push"
    >
      {msg && <Note tone={msg.ok ? "ok" : "warn"}>{msg.text}</Note>}
      {error === "read" && <Note tone="warn">{t("firetvir.readFailed")}</Note>}
      {!setup && !error && <Note>{t("firetvir.loading")}</Note>}
      {/* A page with a title, Back and nothing else is a dead end - and this one can
          reach that state for real, when the device was removed elsewhere. */}
      {(error === "read" || (setup && !dev)) && (
        <Group>
          <Row
            id="reload"
            label={t("firetvir.retry")}
            trailing="none"
            autoFocus
            onEnter={() => {
              setMsg(null);
              void reload();
            }}
          />
          <Row id="back" label={t("firetvir.back")} trailing="none" onEnter={nav.pop} />
        </Group>
      )}
      {dev && (
        <>
          <Group>
            <InfoRow label={t("firetvir.brand")} value={dev.brand} />
            <InfoRow label={t("firetvir.type")} value={t("firetvir.kind." + dev.kind)} />
            <InfoRow
              label={t("firetvir.protocol")}
              value={[...new Set(canDrive.map((k) => dev.keys[k]?.protocol).filter(Boolean))].join(", ")}
            />
            <InfoRow
              label={t("firetvir.database")}
              value={dev.sources.map((s) => t("firetvir.source." + s)).join(" + ") || t("firetvir.none")}
            />
            <InfoRow
              label={t("firetvir.canDrive")}
              value={canDrive.map((k) => t("firetvir.key." + k)).join(", ") || t("firetvir.none")}
            />
            <InfoRow
              label={t("firetvir.assignedTo")}
              value={usedBy.map((k) => t("firetvir.key." + k)).join(", ") || t("firetvir.none")}
            />
            {dev.count > 1 && (
              <InfoRow label={t("firetvir.sharedCode")} value={t("firetvir.sameCode", { n: dev.count })} />
            )}
          </Group>
          <Group hint={t("firetvir.deviceHint")}>
            <Row
              id="test"
              label={busy ? t("firetvir.testing") : t("firetvir.test")}
              trailing="none"
              autoFocus
              disabled={!canDrive.length}
              onEnter={() => void test()}
            />
            <Row
              id="replace"
              label={t("firetvir.replace")}
              hint={t("firetvir.replaceHint")}
              onEnter={() =>
                nav.push({
                  id: "ftir-brand",
                  title: t("firetvir.pickBrand"),
                  render: () => <BrandPickerPage mac={mac} home={home} replaceId={deviceId} />,
                })
              }
            />
            <Row id="remove" label={t("firetvir.removeDevice")} trailing="none" onEnter={() => void remove()} />
          </Group>
        </>
      )}
    </SettingsPage>
  );
}

// ---- one button ------------------------------------------------------------------
function IrKeyPage({ mac, home, irKey }: { mac: string; home: number; irKey: IrKey }) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const { setup, error, save, reload } = useIrSetup(mac);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const assigned = setup?.assign[irKey] || null;
  const devices = setup?.devices || [];

  const setPrimary = (id: string | null) => {
    if (!setup) return;
    const assign: IrAssign = { ...setup.assign };
    if (!id) delete assign[irKey];
    else assign[irKey] = { device: id, second: assigned?.second && assigned.second !== id ? assigned.second : null };
    void save({ ...setup, assign });
  };
  const setSecond = (id: string | null) => {
    if (!setup || !assigned) return;
    void save({ ...setup, assign: { ...setup.assign, [irKey]: { device: assigned.device, second: id } } });
  };

  const test = async () => {
    if (!setup || !assigned || busy) return;
    setBusy(true);
    setMsg(null);
    const r = await testIrKey(mac, forKey(setup, irKey), irKey);
    setBusy(false);
    setMsg({
      ok: r.ok,
      text: r.ok
        ? t("firetvir.testSent", { key: t("firetvir.key." + irKey) })
        : t("firetvir.testFailed", { error: r.error || r.output || "?" }),
    });
  };

  return (
    <SettingsPage
      id="ftir-key"
      title={t("firetvir.key." + irKey)}
      subtitle={t("firetvir.keyHint")}
      onBack={nav.pop}
      animate="push"
    >
      {msg && <Note tone={msg.ok ? "ok" : "warn"}>{msg.text}</Note>}
      {error && <Note tone="warn">{t(error === "read" ? "firetvir.readFailed" : "firetvir.saveFailed")}</Note>}
      {error === "read" && (
        <Group>
          <Row id="reload" label={t("firetvir.retry")} trailing="none" autoFocus onEnter={() => void reload()} />
        </Group>
      )}
      {/* Nothing focusable until the box has answered. SettingsPage places the focus
          on the first row that exists and keeps it there, so rendering the list
          early opens this page on "not set" for a button that IS assigned - the
          rows it should have opened on had not arrived yet. Its retry loop is built
          for exactly this wait. */}
      {!setup ? (
        error ? null : (
          <Note>{t("firetvir.loading")}</Note>
        )
      ) : (
        <>
          <Group>
            <Row
              id="test"
              label={busy ? t("firetvir.testing") : t("firetvir.test")}
              hint={t("firetvir.testHint")}
              trailing="none"
              disabled={!assigned}
              onEnter={() => void test()}
            />
          </Group>

          <Group title={t("firetvir.whichDevice")}>
            {devices.map((d) => (
              <Row
                key={d.id}
                id={"pick-" + d.id}
                label={deviceName(d)}
                // A device whose codeset has no row for this button cannot drive it, and
                // saying so beats a button that is quietly never programmed.
                hint={d.keys[irKey] ? undefined : t("firetvir.keyMissing")}
                value={assigned?.device === d.id ? t("common.selected") : undefined}
                trailing="none"
                autoFocus={assigned?.device === d.id}
                disabled={!d.keys[irKey]}
                onEnter={() => setPrimary(d.id)}
              />
            ))}
            <Row
              id="pick-none"
              label={t("firetvir.notSet")}
              value={!assigned ? t("common.selected") : undefined}
              trailing="none"
              autoFocus={!assigned}
              onEnter={() => setPrimary(null)}
            />
            <Row
              id="add"
              label={t("firetvir.addDevice")}
              hint={t("firetvir.addForKeyHint")}
              onEnter={() =>
                nav.push({
                  id: "ftir-brand",
                  title: t("firetvir.pickBrand"),
                  render: () => <BrandPickerPage mac={mac} home={home} forKey={irKey} />,
                })
              }
            />
          </Group>

          {/* One press, two devices - a soundbar's volume while the TV keeps power.
              The shell only attaches the second when its codeset really carries this
              key. */}
          {assigned && devices.length > 1 && (
            <Group title={t("firetvir.secondDevice")} hint={t("firetvir.secondHint")}>
              {devices
                .filter((d) => d.id !== assigned.device)
                .map((d) => (
                  <Row
                    key={d.id}
                    id={"second-" + d.id}
                    label={deviceName(d)}
                    hint={d.keys[irKey] ? undefined : t("firetvir.keyMissing")}
                    value={assigned.second === d.id ? t("common.selected") : undefined}
                    trailing="none"
                    disabled={!d.keys[irKey]}
                    onEnter={() => setSecond(d.id)}
                  />
                ))}
              <Row
                id="second-none"
                label={t("firetvir.noSecond")}
                value={!assigned.second ? t("common.selected") : undefined}
                trailing="none"
                onEnter={() => setSecond(null)}
              />
            </Group>
          )}
        </>
      )}
    </SettingsPage>
  );
}

// ---- the screen the remote's row opens -------------------------------------------
export function FiretvIrPage({ device }: { device: { id: string; name: string } }) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  // This page's own level, pinned at mount: the picker chain returns here from
  // three pushes down, and by then this component is unmounted.
  const home = useRef(nav.depth).current;
  const mac = device.id;
  // Read-only here: every change is made on a page below this one, and popping back
  // remounts this - so the box is what the two agree through, not shared state.
  const { setup, error, reload } = useIrSetup(mac);
  const [status, setStatus] = useState<FiretvIrStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const config = useConfigStore((s) => s.config);
  const setRemote = useConfigStore((s) => s.setRemote);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => fetchIrStatus().then((s) => s && setStatus(s)), []);
  useEffect(() => {
    void refresh();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [refresh]);

  const startDeps = async () => {
    setMsg(null);
    await installIrDeps();
    void refresh();
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      const s = await fetchIrStatus();
      if (s) setStatus(s);
      if (s && !s.installing) {
        if (poll.current) clearInterval(poll.current);
        if (s.installError) setMsg({ ok: false, text: t("firetvir.depsFailed", { error: s.installError }) });
      }
    }, DEPS_POLL_MS);
  };

  // Whether the bridge still diverts this remote's volume keys to the box's own IR
  // blaster. Once the remote blasts for itself, both would fire on one press;
  // erasing hands the job back. Merged into the existing entry, never replacing it.
  const setPassthrough = async (on: boolean) => {
    const devices: Record<string, RemoteDeviceConfig> = {};
    for (const [k, v] of Object.entries(config?.remote?.devices || {})) devices[k] = { ...v, keymap: { ...v.keymap } };
    const name = devices[mac]?.name || device.name || mac;
    devices[mac] = { ...(devices[mac] || { name, keymap: {} }), name, irPassthrough: on };
    await setRemote(devices);
  };

  const assignedKeys = setup ? KEY_ORDER.filter((k) => setup.assign[k]) : [];

  const doProgram = async () => {
    if (!setup || !assignedKeys.length || busy) return;
    setBusy("program");
    setMsg(null);
    const r = await programIr(mac, setup, planLabel(setup));
    setBusy("");
    if (r.ok) {
      await setPassthrough(true);
      setMsg({ ok: true, text: t("firetvir.programmed") });
      void refresh();
    } else setMsg({ ok: false, text: t("firetvir.programFailed", { error: r.error || r.output || "?" }) });
  };

  const doErase = async () => {
    if (busy) return;
    setBusy("erase");
    setMsg(null);
    const r = await eraseIr(mac);
    setBusy("");
    if (r.ok) await setPassthrough(false);
    setMsg({
      ok: r.ok,
      text: r.ok ? t("firetvir.erased") : t("firetvir.programFailed", { error: r.error || "?" }),
    });
    void refresh();
  };

  const nameOf = (id: string | null | undefined) => {
    const d = setup?.devices.find((x) => x.id === id);
    return d ? deviceName(d) : null;
  };
  const assignValue = (k: IrKey) => {
    const a = setup?.assign[k];
    if (!a) return t("firetvir.notSet");
    const first = nameOf(a.device) || t("firetvir.notSet");
    return a.second ? first + " + " + (nameOf(a.second) || "?") : first;
  };

  return (
    <SettingsPage id="ftir" title={t("firetvir.title")} subtitle={t("firetvir.hint")} onBack={nav.pop} animate="push">
      {msg && <Note tone={msg.ok ? "ok" : "warn"}>{msg.text}</Note>}
      {/* A plan the box could not hand over is NOT an empty one, and this screen must
          not invite a setup that would be written over the real one. */}
      {error === "read" && (
        <>
          <Note tone="warn">{t("firetvir.readFailed")}</Note>
          <Group>
            <Row id="reload" label={t("firetvir.retry")} trailing="none" autoFocus onEnter={() => void reload()} />
          </Group>
        </>
      )}

      {status && !status.depsOk ? (
        <Group hint={t("firetvir.depsNeeded")}>
          <Row
            id="deps"
            label={
              status.installing ? t("firetvir.installing", { step: status.installStep }) : t("firetvir.installDeps")
            }
            trailing="none"
            autoFocus
            // Focusable while it installs, on purpose: minutes of a page with nothing
            // to focus is a D-pad that does nothing. The handler is what refuses.
            onEnter={() => !status.installing && void startDeps()}
          />
        </Group>
      ) : !setup ? (
        error ? null : (
          <Note>{t("firetvir.loading")}</Note>
        )
      ) : (
        <>
          <Group title={t("firetvir.devicesTitle")} hint={!setup.devices.length ? t("firetvir.noDevices") : undefined}>
            {setup.devices.map((d) => (
              <Row
                key={d.id}
                id={"dev-" + d.id}
                label={deviceName(d)}
                hint={t("firetvir.kind." + d.kind)}
                value={
                  KEY_ORDER.filter((k) => setup.assign[k]?.device === d.id).length
                    ? t("firetvir.buttonCount", {
                        n: KEY_ORDER.filter((k) => setup.assign[k]?.device === d.id).length,
                      })
                    : t("firetvir.unused")
                }
                onEnter={() =>
                  nav.push({
                    id: "ftir-dev-" + d.id,
                    title: deviceName(d),
                    render: () => <IrDevicePage mac={mac} home={home} deviceId={d.id} />,
                  })
                }
              />
            ))}
            <Row
              id="add"
              label={t("firetvir.addDevice")}
              hint={t("firetvir.addDeviceHint")}
              autoFocus={!setup.devices.length}
              onEnter={() =>
                nav.push({
                  id: "ftir-brand",
                  title: t("firetvir.pickBrand"),
                  render: () => <BrandPickerPage mac={mac} home={home} />,
                })
              }
            />
          </Group>

          {!!setup.devices.length && (
            <Group title={t("firetvir.keysTitle")} hint={t("firetvir.keysHint")}>
              {KEY_ORDER.map((k) => (
                <Row
                  key={k}
                  id={"key-" + k}
                  label={t("firetvir.key." + k)}
                  value={assignValue(k)}
                  onEnter={() =>
                    nav.push({
                      id: "ftir-key-" + k,
                      title: t("firetvir.key." + k),
                      render: () => <IrKeyPage mac={mac} home={home} irKey={k} />,
                    })
                  }
                />
              ))}
            </Group>
          )}

          <Group title={t("firetvir.saveTitle")} hint={t("firetvir.saveHint")}>
            <Row
              id="program"
              label={busy === "program" ? t("firetvir.programming") : t("firetvir.program")}
              trailing="none"
              disabled={!assignedKeys.length}
              onEnter={() => void doProgram()}
            />
            <Row
              id="erase"
              label={busy === "erase" ? t("firetvir.erasing") : t("firetvir.erase")}
              hint={t("firetvir.eraseHint")}
              trailing="none"
              onEnter={() => void doErase()}
            />
          </Group>
          {setup.programmed?.label && <Note>{t("firetvir.lastProgrammed", { name: setup.programmed.label })}</Note>}
        </>
      )}
      <Note>{t("firetvir.credit")}</Note>
    </SettingsPage>
  );
}
