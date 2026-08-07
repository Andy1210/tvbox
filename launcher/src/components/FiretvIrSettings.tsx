import { useEffect, useMemo, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import type { RemoteDeviceConfig } from "@sdk/config";
import { useI18n } from "../lib/i18n";
import { useConfigStore } from "../stores/config";
import { fetchRemoteDevices, type ConnectedRemote } from "../lib/remote";
import {
  fetchIrStatus,
  installIrDeps,
  fetchIrBrands,
  fetchIrCodeset,
  testIrKey,
  programIr,
  eraseIr,
  type FiretvIrStatus,
  type IrBrand,
  type IrCodeset,
  type IrPlan,
} from "../lib/firetvir";
import { FocusButton } from "./FocusButton";
import { Osk } from "./Osk";

// Settings → Peripherals: teach a Fire TV / Alexa remote to blast the TV's IR
// itself (Volume/Mute/Power), from the box, no Fire TV needed. Guided flow:
//   deps (Bluetooth support) → pick remote → pick TV brand+codeset →
//   test a key → program → optionally hand volume back to the remote.
// The heavy lifting is shell-side (shell/firetvir.js + remote/firetv_remote_ir.py);
// TV codes come from the community irdb database (credited in About).
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const TEST_KEYS = ["VolumeUp", "VolumeDown", "Mute", "Power"] as const;

// A chosen codeset + how to name it on screen. The picker serves three targets:
// the base (all keys), one key's override, or a key's SECOND device.
type PickedSet = { path: string; label: string };
type PickTarget = { kind: "base" } | { kind: "override"; key: string } | { kind: "second"; key: string };

// `device`, when given, embeds the flow under one remote in the remap UI (no
// remote-picker, scoped to that MAC) - so the feature only appears for a remote
// that is actually a programmable Fire TV / Alexa remote. Standalone (no
// device) keeps the self-contained picker for direct use/testing.
export function FiretvIrSettings({ device }: { device?: { id: string; name: string } } = {}) {
  const { t } = useI18n();
  const config = useConfigStore((s) => s.config);
  const setRemote = useConfigStore((s) => s.setRemote);
  const embedded = !!device;

  const [status, setStatus] = useState<FiretvIrStatus | null>(null);
  const [remotes, setRemotes] = useState<ConnectedRemote[]>([]);
  const [mac, setMac] = useState<string | null>(device ? device.id : null);
  const [brands, setBrands] = useState<IrBrand[] | null>(null);
  const [brandsErr, setBrandsErr] = useState("");
  const [brand, setBrand] = useState<IrBrand | null>(null);
  const [filter, setFilter] = useState("");
  const [editingFilter, setEditingFilter] = useState(false);
  const [codeset, setCodeset] = useState<IrCodeset | null>(null); // the base
  // Per-key overrides on top of the base, and an optional second device on a key
  // (one press blasts both - e.g. Power to the TV and a soundbar).
  const [overrides, setOverrides] = useState<Record<string, PickedSet>>({});
  const [seconds, setSeconds] = useState<Record<string, PickedSet>>({});
  const [csCache, setCsCache] = useState<Record<string, IrCodeset>>({});
  const [picking, setPicking] = useState<PickTarget | null>(null);
  const [busy, setBusy] = useState<string>(""); // a key being tested / "program"
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = () => fetchIrStatus().then((s) => s && setStatus(s));

  useEffect(() => {
    refreshStatus();
    // Standalone mode needs the remote list for its picker; embedded mode is
    // already scoped to `device`, so skip it.
    if (!embedded) fetchRemoteDevices().then((d) => setRemotes(d.filter((r) => MAC_RE.test(r.id))));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Embedded + deps ready: load the brand list once (the picker step normally
  // triggers this on remote-select, which embedded mode skips).
  useEffect(() => {
    if (embedded && status?.depsOk && !brands && !brandsErr) loadBrands();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, status?.depsOk]);

  // While deps install, poll status until it finishes (success or error).
  const startDeps = async () => {
    setMsg(null);
    await installIrDeps();
    refreshStatus();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const s = await fetchIrStatus();
      if (s) setStatus(s);
      if (s && !s.installing) {
        if (pollRef.current) clearInterval(pollRef.current);
        if (s.installError) setMsg({ ok: false, text: t("firetvir.depsFailed", { error: s.installError }) });
      }
    }, 2000);
  };

  const loadBrands = async () => {
    setBrandsErr("");
    setBrands(null);
    const r = await fetchIrBrands();
    if (r.ok && r.brands) {
      setBrands(r.brands);
      // Auto-suggest: the box knows the TV brand from its HDMI EDID / CEC vendor.
      // Pre-open that brand (single codeset -> straight to test); the user can
      // still go back and pick another. Only when nothing's chosen yet.
      const sug = status?.suggestedBrand && r.brands.find((b) => b.brand === status.suggestedBrand);
      if (sug && !brand && !codeset) {
        setBrand(sug);
        if (sug.sets.length === 1) chooseCodeset(sug.sets[0].path, sug.brand + " " + sug.sets[0].name);
      }
    } else setBrandsErr(r.error || "error");
  };

  const chooseCodeset = async (path: string, label: string) => {
    setMsg(null);
    const target: PickTarget = picking || { kind: "base" };
    if (target.kind === "base") setCodeset(null);
    const cs = await fetchIrCodeset(path);
    setCsCache((c) => ({ ...c, [path]: cs }));
    if (target.kind === "base") setCodeset(cs);
    else if (target.kind === "override") setOverrides((o) => ({ ...o, [target.key]: { path, label } }));
    else setSeconds((o) => ({ ...o, [target.key]: { path, label } }));
    setPicking(null);
    setBrand(null);
    setTimeout(() => setFocus(target.kind === "base" ? "ftir-test-VolumeUp" : "ftir-change-" + target.key), 0);
  };

  // What a key will actually blast: its override if it has one, else the base.
  // The second device is resolved the same way - the shell only attaches it when
  // that codeset really has a row for THIS key, so a soundbar set without e.g.
  // Mute must not be advertised here as if it were being blasted.
  const effective = (key: string) => {
    const ov = overrides[key];
    const path = ov?.path || codeset?.path || null;
    const cs = path ? csCache[path] : null;
    const row = cs?.keys?.[key];
    const sec = seconds[key];
    return {
      path,
      row,
      label: ov?.label || null,
      ok: !!row && (cs?.supported ? !!cs.supported[row.protocol] : true),
      sec,
      secRow: sec ? csCache[sec.path]?.keys?.[key] : undefined,
    };
  };

  // The plan the shell resolves into a keymap - the test blasts exactly this.
  const buildPlan = (): IrPlan => {
    const keys: IrPlan["keys"] = {};
    for (const key of TEST_KEYS) {
      const entry: { path?: string; second?: string } = {};
      if (overrides[key]) entry.path = overrides[key].path;
      if (seconds[key]) entry.second = seconds[key].path;
      if (Object.keys(entry).length) keys[key] = entry;
    }
    return { base: codeset?.path || null, keys };
  };

  const doTest = async (key: string) => {
    if (!mac || !codeset) return;
    setBusy(key);
    setMsg(null);
    const r = await testIrKey(mac, buildPlan(), key);
    setBusy("");
    setMsg({
      ok: r.ok,
      text: r.ok ? t("firetvir.testSent", { key }) : t("firetvir.testFailed", { error: r.error || r.output || "?" }),
    });
  };

  const doProgram = async () => {
    if (!mac || !codeset) return;
    setBusy("program");
    setMsg(null);
    const extra = TEST_KEYS.filter((k) => overrides[k] || seconds[k]).length;
    const label =
      (codeset.path
        .split("/")
        .pop()
        ?.replace(/\.csv$/, "") || "custom") + (extra ? ` +${extra}` : "");
    const r = await programIr(mac, buildPlan(), label);
    setBusy("");
    if (r.ok) {
      await enablePassthrough(mac);
      setMsg({ ok: true, text: t("firetvir.programmed") });
    } else {
      setMsg({ ok: false, text: t("firetvir.programFailed", { error: r.error || r.output || "?" }) });
    }
  };

  // After programming, the remote blasts the TV itself - tell the bridge to
  // stop diverting this remote's volume keys to the box's IR blaster (else
  // every press fires twice). Merges into the existing device entry.
  const enablePassthrough = async (id: string) => {
    const devices: Record<string, RemoteDeviceConfig> = {};
    for (const [k, v] of Object.entries(config?.remote?.devices || {})) devices[k] = { ...v, keymap: { ...v.keymap } };
    const name = remotes.find((r) => r.id === id)?.name || devices[id]?.name || id;
    devices[id] = { ...(devices[id] || { name, keymap: {} }), name, irPassthrough: true };
    await setRemote(devices);
  };

  const doErase = async () => {
    if (!mac) return;
    setBusy("erase");
    setMsg(null);
    const r = await eraseIr(mac);
    setBusy("");
    setMsg({ ok: r.ok, text: r.ok ? t("firetvir.erased") : t("firetvir.programFailed", { error: r.error || "?" }) });
  };

  // The base is a TV codeset (that is what the flow is for); a per-key override
  // or second device may be any device type - that is how a soundbar lands on
  // the volume keys. Brands with no TV set fall back to showing everything.
  const setsFor = (b: IrBrand) => {
    if (picking && picking.kind !== "base") return b.sets;
    const tv = b.sets.filter((s) => s.type === "TV");
    return tv.length ? tv : b.sets;
  };
  const setLabel = (s: { name: string; type: string }) =>
    picking && picking.kind !== "base" && s.type !== "TV" ? s.type + " " + s.name : s.name;

  const filteredBrands = useMemo(() => {
    if (!brands) return [];
    const f = filter.trim().toLowerCase();
    return f ? brands.filter((b) => b.brand.toLowerCase().includes(f)) : brands;
  }, [brands, filter]);

  if (editingFilter) {
    return (
      <Osk
        key="ftir-filter"
        title={t("firetvir.filterBrand")}
        initial={filter}
        onDone={(v) => {
          setEditingFilter(false);
          setFilter(v.trim());
          setTimeout(() => setFocus("ftir-brandfilter"), 0);
        }}
        onCancel={() => {
          setEditingFilter(false);
          setTimeout(() => setFocus("ftir-brandfilter"), 0);
        }}
      />
    );
  }

  return (
    <div className={embedded ? "mt-[1.5vh]" : "mt-[4vh]"}>
      <div className={embedded ? "text-[2vh] font-semibold mb-[0.4vh]" : "text-[2.4vh] font-semibold mb-[0.6vh]"}>
        {t("firetvir.title")}
      </div>
      <div className="text-[1.7vh] text-fg-dim mb-[1.4vh] max-w-[66vw]">{t("firetvir.hint")}</div>

      {/* Step 1: Bluetooth support (venv + bleak) */}
      {status && !status.depsOk && (
        <div className="mb-[2vh] max-w-[66vw]">
          <div className="text-[1.9vh] text-fg-dim mb-[1vh]">{t("firetvir.depsNeeded")}</div>
          <FocusButton
            focusKey="ftir-deps"
            onEnter={startDeps}
            className="px-[2vw] py-[1.4vh] rounded-[1.1vh] bg-white/5 text-[2vh] font-semibold inline-flex"
          >
            {status.installing ? t("firetvir.installing", { step: status.installStep }) : t("firetvir.installDeps")}
          </FocusButton>
        </div>
      )}

      {/* Step 2: pick the remote (standalone only; embedded is already scoped) */}
      {status && status.depsOk && (
        <>
          {!embedded &&
            (remotes.length === 0 ? (
              <div className="text-[1.9vh] text-fg-dim mb-[2vh]">{t("firetvir.noRemote")}</div>
            ) : (
              <div className="mb-[2vh]">
                <div className="text-[2vh] font-semibold mb-[0.8vh]">{t("firetvir.pickRemote")}</div>
                <div className="flex flex-wrap gap-[0.8vh] max-w-[66vw]">
                  {remotes.map((r) => (
                    <FocusButton
                      key={r.id}
                      focusKey={"ftir-remote-" + r.id.replace(/[^a-z0-9]/gi, "")}
                      onEnter={() => {
                        setMac(r.id);
                        if (!brands) loadBrands();
                        setTimeout(() => setFocus("ftir-brandfilter"), 0);
                      }}
                      className={[
                        "px-[1.6vw] py-[1.2vh] rounded-[1.1vh] text-[2vh]",
                        mac === r.id ? "bg-accent text-[#06090d] font-semibold" : "bg-white/5",
                      ].join(" ")}
                    >
                      {r.name || r.id}
                    </FocusButton>
                  ))}
                </div>
              </div>
            ))}

          {/* Step 3: brand + codeset (irdb). Shown until a base is chosen, and
              again whenever a key's override / second device is being picked. */}
          {mac && (!codeset || picking) && (
            <div className="mb-[2vh]">
              <div className="text-[2vh] font-semibold mb-[0.4vh]">
                {picking && picking.kind !== "base"
                  ? t(picking.kind === "second" ? "firetvir.pickSecondFor" : "firetvir.pickFor", {
                      key: t("firetvir.key." + picking.key),
                    })
                  : t("firetvir.pickBrand")}
              </div>
              {picking && (
                <FocusButton
                  focusKey="ftir-pickcancel"
                  onEnter={() => {
                    setPicking(null);
                    setBrand(null);
                    setTimeout(() => setFocus("ftir-test-VolumeUp"), 0);
                  }}
                  className="px-[1.3vw] py-[1vh] rounded-[1vh] bg-white/5 text-[1.8vh] mb-[1vh] inline-flex"
                >
                  {t("firetvir.cancel")}
                </FocusButton>
              )}
              {status?.suggestedBrand && (
                <div className="text-[1.7vh] text-fg-dim mb-[0.8vh]">
                  {t("firetvir.suggested", { brand: status.suggestedBrand })}
                </div>
              )}
              {brandsErr && (
                <div className="text-[1.8vh] text-warn mb-[1vh]">
                  {t("firetvir.brandsError", { error: brandsErr })}{" "}
                  <FocusButton focusKey="ftir-brandretry" onEnter={loadBrands} className="underline">
                    {t("firetvir.retry")}
                  </FocusButton>
                </div>
              )}
              {!brands && !brandsErr && (
                <div className="text-[1.8vh] text-fg-dim mb-[1vh]">{t("firetvir.loading")}</div>
              )}
              {brands && (
                <>
                  <FocusButton
                    focusKey="ftir-brandfilter"
                    onEnter={() => setEditingFilter(true)}
                    className="px-[1.6vw] py-[1.1vh] rounded-[1.1vh] bg-white/5 text-[1.9vh] mb-[1vh] inline-flex"
                  >
                    {filter ? t("firetvir.filterIs", { q: filter }) : t("firetvir.filterBrand")}
                  </FocusButton>
                  {!brand ? (
                    <div className="flex flex-wrap gap-[0.7vh] max-w-[69vw] max-h-[30vh] overflow-y-auto no-scrollbar px-[1.5vw] -mx-[1.5vw]">
                      {filteredBrands.slice(0, 60).map((b) => (
                        <FocusButton
                          key={b.brand}
                          focusKey={"ftir-brand-" + b.brand.replace(/[^a-z0-9]/gi, "")}
                          onEnter={() => {
                            setBrand(b);
                            const only = setsFor(b);
                            if (only.length === 1) chooseCodeset(only[0].path, b.brand + " " + setLabel(only[0]));
                          }}
                          className="px-[1.3vw] py-[1vh] rounded-[1vh] bg-white/5 text-[1.9vh]"
                        >
                          {b.brand}
                        </FocusButton>
                      ))}
                      {filteredBrands.length > 60 && (
                        <span className="text-[1.7vh] text-fg-dim self-center">{t("firetvir.narrow")}</span>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-[0.7vh] max-w-[66vw]">
                      <FocusButton
                        focusKey="ftir-brandback"
                        onEnter={() => {
                          setBrand(null);
                          setCodeset(null);
                          setTimeout(() => setFocus("ftir-brandfilter"), 0);
                        }}
                        className="px-[1.3vw] py-[1vh] rounded-[1vh] bg-white/5 text-[1.9vh] font-semibold"
                      >
                        ← {brand.brand}
                      </FocusButton>
                      {setsFor(brand).map((s) => (
                        <FocusButton
                          key={s.path}
                          focusKey={"ftir-set-" + s.name.replace(/[^a-z0-9]/gi, "")}
                          onEnter={() => chooseCodeset(s.path, brand.brand + " " + setLabel(s))}
                          className={[
                            "px-[1.3vw] py-[1vh] rounded-[1vh] text-[1.9vh]",
                            codeset?.path === s.path ? "bg-accent text-[#06090d] font-semibold" : "bg-white/5",
                          ].join(" ")}
                        >
                          {setLabel(s)}
                        </FocusButton>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step 4: test + program */}
          {codeset && codeset.ok && (
            <div className="mb-[1.4vh] max-w-[66vw]">
              <div className="text-[2vh] font-semibold mb-[0.4vh]">{t("firetvir.testTitle")}</div>
              <div className="text-[1.7vh] text-fg-dim mb-[1vh]">{t("firetvir.testHint")}</div>
              <div className="mb-[1.2vh]">
                {TEST_KEYS.map((key) => {
                  const eff = effective(key);
                  const sec = seconds[key];
                  return (
                    <div
                      key={key}
                      className="flex items-center gap-[0.8vw] py-[0.7vh] border-b-[0.15vh] border-white/5"
                    >
                      <div className="w-[9vw] text-[1.9vh] font-semibold">{t("firetvir.key." + key)}</div>
                      <div className="flex-1 text-[1.7vh] text-fg-dim truncate">
                        {!eff.row
                          ? t("firetvir.keyMissing")
                          : (eff.label || t("firetvir.fromBase")) +
                            (eff.sec
                              ? " + " + eff.sec.label + (eff.secRow ? "" : " (" + t("firetvir.keyMissing") + ")")
                              : "")}
                      </div>
                      <FocusButton
                        focusKey={"ftir-test-" + key}
                        onEnter={() => eff.ok && doTest(key)}
                        className={[
                          "px-[1.2vw] py-[0.9vh] rounded-[1vh] text-[1.8vh]",
                          eff.ok ? "bg-white/5" : "bg-white/5 opacity-40",
                        ].join(" ")}
                      >
                        {busy === key ? "…" : t("firetvir.test")}
                        {eff.row && !eff.ok ? " (?)" : ""}
                      </FocusButton>
                      <FocusButton
                        focusKey={"ftir-change-" + key}
                        onEnter={() => {
                          setPicking({ kind: "override", key });
                          setBrand(null);
                          setTimeout(() => setFocus("ftir-brandfilter"), 0);
                        }}
                        className="px-[1.2vw] py-[0.9vh] rounded-[1vh] bg-white/5 text-[1.8vh]"
                      >
                        {overrides[key] ? t("firetvir.change") : t("firetvir.override")}
                      </FocusButton>
                      <FocusButton
                        focusKey={"ftir-second-" + key}
                        onEnter={() => {
                          if (sec)
                            return setSeconds((o) => {
                              const n = { ...o };
                              delete n[key];
                              return n;
                            });
                          setPicking({ kind: "second", key });
                          setBrand(null);
                          setTimeout(() => setFocus("ftir-brandfilter"), 0);
                        }}
                        className="px-[1.2vw] py-[0.9vh] rounded-[1vh] bg-white/5 text-[1.8vh]"
                      >
                        {sec ? t("firetvir.removeSecond") : t("firetvir.addSecond")}
                      </FocusButton>
                      {overrides[key] && (
                        <FocusButton
                          focusKey={"ftir-reset-" + key}
                          onEnter={() =>
                            setOverrides((o) => {
                              const n = { ...o };
                              delete n[key];
                              return n;
                            })
                          }
                          className="px-[1.2vw] py-[0.9vh] rounded-[1vh] bg-white/5 text-[1.8vh]"
                        >
                          {t("firetvir.useBase")}
                        </FocusButton>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="text-[1.6vh] text-fg-dim mb-[1vh]">{t("firetvir.perKeyHint")}</div>
              {codeset.supported && Object.values(codeset.supported).some((v) => !v) && (
                <div className="text-[1.7vh] text-warn mb-[1vh]">{t("firetvir.someUnsupported")}</div>
              )}
              <div className="flex gap-[0.8vh]">
                <FocusButton
                  focusKey="ftir-program"
                  onEnter={doProgram}
                  className="px-[2vw] py-[1.4vh] rounded-[1.1vh] bg-accent text-[#06090d] text-[2vh] font-semibold"
                >
                  {busy === "program" ? t("firetvir.programming") : t("firetvir.program")}
                </FocusButton>
                <FocusButton
                  focusKey="ftir-erase"
                  onEnter={doErase}
                  className="px-[1.6vw] py-[1.4vh] rounded-[1.1vh] bg-white/5 text-[1.9vh]"
                >
                  {busy === "erase" ? "…" : t("firetvir.erase")}
                </FocusButton>
              </div>
            </div>
          )}
        </>
      )}

      {msg && (
        <div className={["text-[1.9vh] mt-[1vh] max-w-[66vw]", msg.ok ? "text-accent" : "text-warn"].join(" ")}>
          {msg.text}
        </div>
      )}
      <div className="text-[1.5vh] text-fg-dim mt-[2vh] max-w-[66vw]">{t("firetvir.credit")}</div>
    </div>
  );
}
