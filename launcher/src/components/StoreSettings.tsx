import { useCallback, useEffect, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { fetchStore, storeInstall, storeUninstall, saveAppUrl, type StoreEntry } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useInstalls } from "../stores/installs";
import { FocusButton } from "./FocusButton";
import { Icon } from "./Icon";
import { Osk } from "./Osk";
import { AppDetail } from "./AppDetail";

// Settings → Store: the app registry. Rows are manifest-only apps vetted in
// the tvbox-apps repo. Each row is a single focusable that opens a full-screen
// AppDetail (version info + changelog + actions). Install writes the manifest
// onto the box (the HOME tile appears live), Remove deletes it; self-hosted apps
// (urlConfig) get a "Set address" action backed by the shared OSK. Renders
// inside the parent FocusContext (Settings category panel or Catalog).
const chevron = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-full h-full"
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export function StoreSettings() {
  const { t, loc } = useI18n();
  const [entries, setEntries] = useState<StoreEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [urlEdit, setUrlEdit] = useState<StoreEntry | null>(null); // OSK open for this app
  const [detailId, setDetailId] = useState<string | null>(null); // AppDetail open for this app

  // Every row is focusable now (each opens the detail view); focus the first.
  const firstKey = (list: StoreEntry[]): string | null => (list.length ? "store-app-" + list[0].id : null);

  // placeFocus: the panel mounts with NOTHING focusable (the parent Settings
  // focuses its first child before the fetch resolves), so after the initial
  // load - and after Retry, whose button unmounts on success - focus must be
  // placed explicitly or the D-pad can never enter the panel.
  const load = useCallback(async (refresh = false, placeFocus = false) => {
    const d = await fetchStore(refresh);
    const apps = d ? d.apps : [];
    const err = !d ? "network" : d.error ? "registry" : null;
    setError(err);
    setEntries(apps);
    if (placeFocus)
      setTimeout(() => {
        if (err) setFocus("store-retry");
        else {
          const k = firstKey(apps);
          if (k) setFocus(k);
        }
      }, 0);
  }, []);
  useEffect(() => {
    load(false, true);
  }, [load]);

  // Install runs in the background on the box (POST /store/install returns at
  // once); we poll /store/list while anything is installing so the entry's
  // progress phase - and its completion - show up. The interval stops the moment
  // nothing is installing.
  const anyInstalling = (entries || []).some((e) => e.installing);
  useEffect(() => {
    if (!anyInstalling) return;
    let alive = true;
    const iv = setInterval(async () => {
      const d = await fetchStore();
      if (alive && d) setEntries(d.apps);
    }, 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [anyInstalling]);

  // Detect installing -> done transitions: announce the result and, if the
  // detail view is open on that app, refocus its now-current action button
  // (the progress indicator that held focus is about to unmount).
  const pending = useRef<Map<string, "install" | "update">>(new Map());
  const prevInstalling = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set((entries || []).filter((e) => e.installing).map((e) => e.id));
    for (const id of prevInstalling.current) {
      if (!now.has(id)) {
        const e = (entries || []).find((x) => x.id === id);
        const kind = pending.current.get(id) ?? "install";
        pending.current.delete(id);
        if (e) {
          const key = e.installed ? (kind === "update" ? "store.updated" : "store.installed") : "store.failed";
          setStatus(t(key, { name: loc(e.name) }));
          if (detailId === id) setTimeout(() => setFocus(e.installed ? "detail-remove" : "detail-install"), 0);
        }
      }
    }
    prevInstalling.current = now;
  }, [entries, detailId, t, loc]);

  // Install / Update both POST /store/install (a re-install upgrades in place).
  // The call returns immediately; we mark the entry installing so the detail
  // view swaps its Install/Update button for the progress indicator, move focus
  // to the still-mounted Back button, then refresh once so the phase appears.
  // The poll + completion effects above take it from there.
  const kickoff = async (e: StoreEntry, kind: "install" | "update") => {
    pending.current.set(e.id, kind);
    const ok = await storeInstall(e.id);
    if (!ok) {
      pending.current.delete(e.id);
      setStatus(t("store.failed", { name: loc(e.name) }));
      setTimeout(() => setFocus(kind === "update" ? "detail-update" : "detail-install"), 0);
      return;
    }
    setStatus(null);
    // Owe a global completion toast even if the user leaves the store (the
    // install runs in the background); InstallWatcher fires it when it finishes.
    useInstalls.getState().add(e.id);
    setEntries((prev) => (prev ? prev.map((x) => (x.id === e.id ? { ...x, installing: true } : x)) : prev));
    setTimeout(() => setFocus("detail-back"), 0);
    const d = await fetchStore();
    if (d) setEntries(d.apps);
  };
  const install = (e: StoreEntry) => kickoff(e, "install");
  const update = (e: StoreEntry) => kickoff(e, "update");
  const remove = async (e: StoreEntry) => {
    const ok = await storeUninstall(e.id);
    setStatus(t(ok ? "store.removed" : "store.failed", { name: loc(e.name) }));
    if (ok) await load();
    setTimeout(() => setFocus(ok ? "detail-install" : "detail-remove"), 0);
  };
  const saveUrl = async (e: StoreEntry, value: string) => {
    setUrlEdit(null);
    if (e.urlConfig) {
      const ok = await saveAppUrl(e.urlConfig, value.trim());
      setStatus(ok ? t("store.urlSaved", { name: loc(e.name) }) : t("store.failed", { name: loc(e.name) }));
      if (ok) await load();
    }
    setTimeout(() => setFocus("detail-url"), 0);
  };

  const detailApp = detailId ? ((entries || []).find((e) => e.id === detailId) ?? null) : null;

  // The detail view fills the screen; the OSK (Set address) is a modal on top of
  // it - rendered as a sibling overlay so AppDetail stays mounted (its focus
  // survives) and closing the OSK returns focus to the "Set address" button.
  if (detailApp) {
    return (
      <>
        <AppDetail
          app={detailApp}
          status={status}
          onInstall={() => install(detailApp)}
          onUpdate={() => update(detailApp)}
          onRemove={() => remove(detailApp)}
          onSetUrl={() => setUrlEdit(detailApp)}
          onExit={() => {
            const id = detailApp.id;
            setDetailId(null);
            setTimeout(() => setFocus("store-app-" + id), 0);
          }}
        />
        {urlEdit && (
          <Osk
            title={t("store.urlPrompt", { name: loc(urlEdit.name) })}
            initial={urlEdit.baseUrl || "http://"}
            onDone={(v) => saveUrl(urlEdit, v)}
            onCancel={() => {
              setUrlEdit(null);
              setTimeout(() => setFocus("detail-url"), 0);
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[0.8vh]">{t("store.title")}</div>
      <div className="text-fg-dim text-[1.8vh] mb-[1.4vh] max-w-[70vw]">{t("store.hint")}</div>

      {entries === null && <div className="text-[1.9vh] text-fg-dim">{t("store.loading")}</div>}

      {error && (
        <div className="flex items-center gap-[1.5vw] mb-[1.4vh]">
          <span className="text-[1.9vh] text-amber-200">
            {t(error === "network" ? "app.shellUnreachable" : "store.registryError")}
          </span>
          <FocusButton
            focusKey="store-retry"
            onEnter={() => load(true, true)}
            className="px-[1.6vw] h-[5vh] rounded-[1vh] bg-white/5 flex items-center justify-center text-[1.9vh] font-semibold"
          >
            {t("app.retry")}
          </FocusButton>
        </div>
      )}

      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {(entries || []).map((e) => {
          const shownVersion = e.installed && e.installedVersion ? e.installedVersion : e.version;
          const subtitle = [
            e.tagline ? loc(e.tagline) : null,
            "v" + shownVersion,
            e.urlConfig && e.installed && !e.baseUrl ? t("store.urlMissing") : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <FocusButton
              key={e.id}
              focusKey={"store-app-" + e.id}
              onEnter={() => setDetailId(e.id)}
              className="px-[1.5vw] py-[1.2vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.5vw]"
            >
              <Icon svg={e.icon} className="w-[3.4vh] h-[3.4vh] shrink-0" />
              <div className="flex-1 min-w-0 text-left">
                <div className="text-[2.1vh] truncate">{loc(e.name)}</div>
                <div className="text-[1.6vh] text-fg-dim truncate">{subtitle}</div>
              </div>
              {e.updateAvailable && (
                <span
                  className="text-[1.6vh] font-semibold shrink-0 whitespace-nowrap"
                  style={{ color: e.accent || undefined }}
                >
                  {t("store.updateAvailableBadge")} · v{e.version}
                </span>
              )}
              <span className="w-[2.4vh] h-[2.4vh] shrink-0 opacity-40">{chevron}</span>
            </FocusButton>
          );
        })}
        {entries !== null && !error && !entries.length && (
          <div className="text-[1.9vh] text-fg-dim">{t("store.empty")}</div>
        )}
        {status && (
          <div className="text-[1.8vh] text-fg-dim mt-[0.6vh]" role="status" aria-live="polite">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
