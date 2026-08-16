import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { fetchStore, storeInstall, storeUninstall, storeFlatpakUpdate, saveAppUrl, type StoreEntry } from "../lib/api";
import { sourceLabel } from "../lib/storesource";
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
  // status is scoped to the app it's about, so a "X removed" / "Y installed"
  // message can never leak onto a different app's detail view (it did: the
  // status lingered and showed the last-acted app's name on every app you opened).
  const [status, setStatus] = useState<{ id: string; text: string } | null>(null);
  const [urlEdit, setUrlEdit] = useState<StoreEntry | null>(null); // OSK open for this app
  const [detailId, setDetailId] = useState<string | null>(null); // AppDetail open for this app

  // Every row is focusable now (each opens the detail view); focus the first.
  const firstKey = (list: StoreEntry[]): string | null => (list.length ? "store-app-" + list[0].id : null);

  // placeFocus: the panel mounts with NOTHING focusable (the parent Settings
  // focuses its first child before the fetch resolves), so after the initial
  // load - and after Retry, whose button unmounts on success - focus must be
  // placed explicitly or the D-pad can never enter the panel.
  // Returns what it loaded: a caller that has just removed something needs to
  // know whether the row it was standing on still exists.
  const load = useCallback(async (refresh = false, placeFocus = false): Promise<StoreEntry[]> => {
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
    return apps;
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
  const pending = useRef<Map<string, "install" | "update" | "flatpak">>(new Map());
  /** Which registry a switch was aimed at, so its completion can name it. */
  const switchedTo = useRef<Map<string, string>>(new Map());
  const prevInstalling = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set((entries || []).filter((e) => e.installing).map((e) => e.id));
    for (const id of prevInstalling.current) {
      if (!now.has(id)) {
        const e = (entries || []).find((x) => x.id === id);
        const kind = pending.current.get(id) ?? "install";
        const movedTo = switchedTo.current.get(id);
        pending.current.delete(id);
        switchedTo.current.delete(id);
        if (e && kind === "flatpak") {
          // The box reports what the update did: a flatpak can be rebuilt without
          // its version moving, so "already current" is a real outcome, not a
          // failure - and the version shown is the one now on the box. With no
          // result at all (a shell restart mid-run) nothing is claimed either way;
          // the version line, which refreshes with the list, is the answer then.
          const st = e.flatpakStatus;
          const named = (e.flatpaks || []).filter((f) => f.version);
          const name = named.length === 1 ? named[0].name : loc(e.name);
          if (st) {
            const key = !st.ok ? "store.flatpakFailed" : st.changed ? "store.flatpakUpdated" : "store.flatpakCurrent";
            setStatus({ id: e.id, text: t(key, { name, v: st.version ?? "" }) });
          }
          if (detailId === id) setTimeout(() => setFocus("detail-flatpak"), 0);
        } else if (e) {
          if (e.installed && movedTo) {
            setStatus({
              id: e.id,
              text: t("store.switched", {
                name: loc(e.name),
                source: movedTo,
              }),
            });
          } else {
            const key = e.installed ? (kind === "update" ? "store.updated" : "store.installed") : "store.failed";
            setStatus({ id: e.id, text: t(key, { name: loc(e.name) }) });
          }
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
  const kickoff = async (e: StoreEntry, kind: "install" | "update", sourceUrl?: string) => {
    pending.current.set(e.id, kind);
    // Remembered for the completion message: "updated" is the wrong sentence for
    // a switch - the version often does not move at all, and on a first install
    // from another registry it never said where the app went.
    if (sourceUrl) {
      // The LABEL, resolved here: the entry in hand knows what its registries
      // are called, and looking it up later would tie the completion effect to
      // the whole list.
      const src = e.source?.url === sourceUrl ? e.source : (e.alsoIn || []).find((x) => x.url === sourceUrl);
      switchedTo.current.set(
        e.id,
        sourceLabel({ url: sourceUrl, name: src?.name ?? null, official: !!src?.official }, t("storeSources.official")),
      );
    }
    const r = await storeInstall(e.id, sourceUrl);
    if (!r.ok) {
      pending.current.delete(e.id);
      // The box's own reason, when it gave one: "that registry does not offer
      // it" and "registry unreachable" are different problems with different
      // next steps, and both used to read as "action failed".
      // Said in the language the box is set to. The shell's strings are
      // diagnostics - "registry unreachable: connect ECONNREFUSED
      // 192.168.1.19:8790" is a log line, not a sentence for a sofa - so the
      // ones a press can reach are mapped and anything else falls back to the
      // plain failure, with the raw text left to the log.
      const reason = ((raw?: string): string | null => {
        if (!raw) return null;
        if (raw.startsWith("registry unreachable")) return t("store.whyUnreachable");
        if (raw.includes("does not offer it")) return t("store.whyNotOffered");
        if (raw.includes("not a configured registry")) return t("store.whyNotConfigured");
        if (raw.includes("built-in app")) return t("store.whyBuiltin");
        if (raw.includes("could not record")) return t("store.whyPin");
        return null;
      })(r.error);
      setStatus({
        id: e.id,
        text: reason
          ? t("store.failedWhy", { name: loc(e.name), why: reason })
          : t("store.failed", { name: loc(e.name) }),
      });
      // Back to the button that was actually pressed. Keying this off `kind`
      // sent focus to `detail-update`, which is NOT mounted when the two
      // registries carry the same version - the ordinary case for a switch - and
      // spatial navigation then either sat on a key nothing owns or landed on
      // the red Uninstall button with somebody's thumb on OK.
      const back = sourceUrl ? `detail-source-${sourceUrl}` : kind === "update" ? "detail-update" : "detail-install";
      setTimeout(() => setFocus(back), 0);
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
  // Taking an app from a DIFFERENT registry than the one it stands with. Counted
  // as an update rather than an install because that is what it is from the
  // box's side - the app stays, its origin moves - and because the focus goes
  // back to the right button if the registry refuses it.
  const switchSource = (e: StoreEntry, sourceUrl: string) => kickoff(e, "update", sourceUrl);
  // Updating the flatpak is not a store install: the app package stays put and the
  // program it runs (or was built from) moves. It reuses the same progress plumbing
  // because it is the same kind of wait - hundreds of MB, out of process.
  const flatpakUpdate = async (e: StoreEntry) => {
    pending.current.set(e.id, "flatpak");
    const r = await storeFlatpakUpdate(e.id);
    if (!r.ok) {
      pending.current.delete(e.id);
      // The box refusing because it is already installing something is worth saying
      // as such: waiting a moment fixes it, unlike a failure.
      const text = r.error === "busy" ? t("store.busy") : t("store.failed", { name: loc(e.name) });
      setStatus({ id: e.id, text });
      setTimeout(() => setFocus("detail-flatpak"), 0);
      return;
    }
    setStatus(null);
    setEntries((prev) => (prev ? prev.map((x) => (x.id === e.id ? { ...x, installing: true } : x)) : prev));
    setTimeout(() => setFocus("detail-back"), 0);
    const d = await fetchStore();
    if (d) setEntries(d.apps);
  };
  const remove = async (e: StoreEntry) => {
    const ok = await storeUninstall(e.id);
    setStatus({ id: e.id, text: t(ok ? "store.removed" : "store.failed", { name: loc(e.name) }) });
    if (!ok) {
      setTimeout(() => setFocus("detail-remove"), 0);
      return;
    }
    const rest = await load();
    // An app no source lists has no row left once it is gone, so the detail
    // unmounts with it and `detail-install` never mounts again - a cursor there
    // discards every press afterwards, with only Back out. Leave for the list.
    if (rest && !rest.some((x) => x.id === e.id)) {
      setDetailId(null);
      const next = firstKey(rest);
      if (next) setTimeout(() => setFocus(next), 0);
      return;
    }
    setTimeout(() => setFocus("detail-install"), 0);
  };
  const saveUrl = async (e: StoreEntry, value: string) => {
    setUrlEdit(null);
    if (e.urlConfig) {
      const ok = await saveAppUrl(e.urlConfig, value.trim());
      setStatus({
        id: e.id,
        text: ok ? t("store.urlSaved", { name: loc(e.name) }) : t("store.failed", { name: loc(e.name) }),
      });
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
          status={status && status.id === detailApp.id ? status.text : null}
          onInstall={() => install(detailApp)}
          onSwitchSource={(url) => switchSource(detailApp, url)}
          onUpdate={() => update(detailApp)}
          onFlatpakUpdate={() => flatpakUpdate(detailApp)}
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
      {entries === null && <div className="text-[1.9vh] text-fg-dim">{t("store.loading")}</div>}

      {error && (
        <div className="flex items-center gap-[1.5vw] mb-[1.4vh]">
          <span className="text-[1.9vh] text-warn">
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
        {(entries || []).map((e, i, all) => {
          // The shell puts them last, so one boundary is all it takes. The
          // heading is a plain div: spatial navigation only registers
          // focusables, so the D-pad travels straight past it.
          const opensUnlisted = !!e.unlisted && !all[i - 1]?.unlisted;
          const shownVersion = e.installed && e.installedVersion ? e.installedVersion : e.version;
          const subtitle = [
            e.tagline ? loc(e.tagline) : null,
            t("store.vShort", { v: shownVersion }),
            // Only for an added registry: naming the official one on every row
            // would be noise, while an app from somewhere else is exactly what a
            // person scrolling the catalogue needs to see without opening it.
            e.unlisted ? t("store.unlisted") : null,
            e.source && !e.source.official ? t("store.fromSource", { name: sourceLabel(e.source) }) : null,
            e.urlConfig && e.installed && !e.baseUrl ? t("store.urlMissing") : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Fragment key={e.id}>
              {opensUnlisted && (
                <div className="mt-[1.4vh] px-[1.5vw] text-[1.7vh] text-fg-dim">{t("store.unlistedGroup")}</div>
              )}
              <FocusButton
                focusKey={"store-app-" + e.id}
                onEnter={() => setDetailId(e.id)}
                className="px-[1.5vw] py-[1.2vh] rounded-[1.1vh] bg-white/5 flex items-center gap-[1.5vw]"
              >
                <Icon svg={e.icon} className="w-[3.4vh] h-[3.4vh] shrink-0" />
                <div className="flex-1 min-w-0 text-left">
                  <div className="text-[2.1vh] truncate">{loc(e.name)}</div>
                  <div className="text-[1.6vh] text-fg-dim truncate">{subtitle}</div>
                </div>
                {/* fixed emerald (same as AppDetail's Update button) - the manifest
                  accent can be arbitrarily dark and unreadable */}
                {e.updateAvailable && (
                  <span className="text-[1.6vh] font-semibold shrink-0 whitespace-nowrap text-emerald-200">
                    {t("store.updateAvailableBadge")} · {t("store.vShort", { v: e.version })}
                  </span>
                )}
                <span className="w-[2.4vh] h-[2.4vh] shrink-0 opacity-40">{chevron}</span>
              </FocusButton>
            </Fragment>
          );
        })}
        {entries !== null && !error && !entries.length && (
          <div className="text-[1.9vh] text-fg-dim">{t("store.empty")}</div>
        )}
        {status && (
          <div className="text-[1.8vh] text-fg-dim mt-[0.6vh]" role="status" aria-live="polite">
            {status.text}
          </div>
        )}
      </div>
    </div>
  );
}
