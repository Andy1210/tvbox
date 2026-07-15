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
  const [codeset, setCodeset] = useState<IrCodeset | null>(null);
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
        if (sug.sets.length === 1) chooseCodeset(sug.sets[0].path);
      }
    } else setBrandsErr(r.error || "error");
  };

  const chooseCodeset = async (path: string) => {
    setCodeset(null);
    setMsg(null);
    const cs = await fetchIrCodeset(path);
    setCodeset(cs);
    setTimeout(() => setFocus("ftir-test-VolumeUp"), 0);
  };

  const doTest = async (key: string) => {
    if (!mac || !codeset) return;
    setBusy(key);
    setMsg(null);
    const r = await testIrKey(mac, codeset.path, key);
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
    const label =
      (brand ? brand.brand + " " : "") +
      codeset.path
        .split("/")
        .pop()
        ?.replace(/\.csv$/, "");
    const r = await programIr(mac, codeset.path, label);
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

  const filteredBrands = useMemo(() => {
    if (!brands) return [];
    const f = filter.trim().toLowerCase();
    return f ? brands.filter((b) => b.brand.toLowerCase().includes(f)) : brands;
  }, [brands, filter]);

  if (editingFilter) {
    return (
      <Osk
        key="ftir-filter"
        title={t("firetvir.brandFilter")}
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

          {/* Step 3: brand + codeset (irdb) */}
          {mac && (
            <div className="mb-[2vh]">
              <div className="text-[2vh] font-semibold mb-[0.4vh]">{t("firetvir.pickBrand")}</div>
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
                    <div className="flex flex-wrap gap-[0.7vh] max-w-[66vw] max-h-[30vh] overflow-y-auto no-scrollbar">
                      {filteredBrands.slice(0, 60).map((b) => (
                        <FocusButton
                          key={b.brand}
                          focusKey={"ftir-brand-" + b.brand.replace(/[^a-z0-9]/gi, "")}
                          onEnter={() => {
                            setBrand(b);
                            if (b.sets.length === 1) chooseCodeset(b.sets[0].path);
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
                      {brand.sets.map((s) => (
                        <FocusButton
                          key={s.path}
                          focusKey={"ftir-set-" + s.name.replace(/[^a-z0-9]/gi, "")}
                          onEnter={() => chooseCodeset(s.path)}
                          className={[
                            "px-[1.3vw] py-[1vh] rounded-[1vh] text-[1.9vh]",
                            codeset?.path === s.path ? "bg-accent text-[#06090d] font-semibold" : "bg-white/5",
                          ].join(" ")}
                        >
                          {s.name}
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
              <div className="flex flex-wrap gap-[0.8vh] mb-[1.2vh]">
                {TEST_KEYS.map((key) => {
                  const row = codeset.keys[key];
                  const proto = row?.protocol;
                  const ok = row && (codeset.supported ? codeset.supported[proto] : true);
                  return (
                    <FocusButton
                      key={key}
                      focusKey={"ftir-test-" + key}
                      onEnter={() => ok && doTest(key)}
                      className={[
                        "px-[1.6vw] py-[1.2vh] rounded-[1.1vh] text-[1.9vh]",
                        ok ? "bg-white/5" : "bg-white/5 opacity-40",
                      ].join(" ")}
                    >
                      {t("firetvir.key." + key)}
                      {busy === key ? " …" : !row ? " ✕" : !ok ? " (?)" : ""}
                    </FocusButton>
                  );
                })}
              </div>
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
