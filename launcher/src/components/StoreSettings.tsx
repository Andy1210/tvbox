import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { fetchStore, storeInstall, storeUninstall, storeFlatpakUpdate, saveAppUrl, type StoreEntry } from "../lib/api";
import { sourceLabel } from "../lib/storesource";
import { useSwallowEnterRepeats } from "./RemoteKeymap";
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

/** What one catalogue read yielded: what the panel renders, and whether it may
 *  be believed. `partial` is one source of several failing, which the panel
 *  shows next to the source it belongs to rather than as a failed read. */
type Loaded = { apps: StoreEntry[]; read: boolean; partial: boolean };

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
  const detailApp = detailId ? ((entries || []).find((e) => e.id === detailId) ?? null) : null;
  // The keyboard is rendered inside the detail, but its state is not: a poll
  // that dropped the app closed the screen and left `urlEdit` set, so the next
  // press opened another app's detail with the previous app's address editor on
  // top of it - saving to the right app from the wrong screen, and leaving the
  // cursor on a button that screen does not have.
  useEffect(() => {
    if (!detailApp && urlEdit) setUrlEdit(null);
  }, [detailApp, urlEdit]);
  /** Until when a row press is ignored, so one queued behind a removal cannot open the row that replaced it. */
  const settling = useRef(0);
  // A held OK repeats on this hardware, and one press in this list is two away
  // from removing an app. Measured with autorepeat: a single held button walked
  // the list and uninstalled three.
  // Not while the on-screen keyboard is up: it is a sibling of the detail view,
  // so the same listener was eating held keys there - clearing an address went
  // from one held press to twenty-four. Keyed on what the render actually uses,
  // because `urlEdit` outlives the keyboard whenever the detail closes under it,
  // and the list would then run with the swallow off.
  useSwallowEnterRepeats(!(detailApp && urlEdit));

  // Every row is focusable now (each opens the detail view); focus the first.
  const firstKey = (list: StoreEntry[]): string | null => (list.length ? "store-app-" + list[0].id : null);

  // placeFocus: the panel mounts with NOTHING focusable (the parent Settings
  // focuses its first child before the fetch resolves), so after the initial
  // load - and after Retry, whose button unmounts on success - focus must be
  // placed explicitly or the D-pad can never enter the panel.
  // Returns what it loaded: a caller that has just removed something needs to
  // know whether the row it was standing on still exists.
  const load = useCallback(async (refresh = false, placeFocus = false): Promise<Loaded> => {
    const d = await fetchStore(refresh);
    const apps = d ? d.apps : [];
    const err = !d ? "network" : d.error ? "registry" : null;
    setError(err);
    setEntries(apps);
    if (placeFocus)
      setTimeout(() => {
        // Empty is a place the cursor has to be PUT, not skipped. Leaving it
        // unplaced left the cursor on whatever the previous screen held - a
        // HOME tile that had already unmounted, or the pane container itself -
        // and from there every arrow and every OK is discarded, with only Back
        // out. Measured in both hosts this panel has.
        if (err) setFocus("store-retry");
        else setFocus(firstKey(apps) ?? "store-empty");
      }, 0);
    // Both halves are handed back, because a caller after a removal asks two
    // different questions of them. `apps` is what the panel RENDERS, so it is
    // what the cursor may be sent into; `read` is whether the list may be
    // believed as proof that a removal happened - an unreachable registry is
    // answered 200 with an empty list and an `error` in the body, and reading
    // that as "everything is gone" is how a removal that failed announced
    // success.
    //
    // One source of several failing no longer costs that proof. It used to:
    // a registry blinking out dropped its apps from this list while the answer
    // still looked healthy, which reads as "removed". An INSTALLED app cannot
    // drop out that way any more - the shell keeps a row for it and marks it
    // `unchecked` - and an installed app is the only kind a removal is about.
    return { apps, read: !!d && !d.error, partial: !!d && Array.isArray(d.sources) && d.sources.some((x) => x.error) };
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
    const before = entries || [];
    const wasAt = before.findIndex((x) => x.id === e.id);
    const ok = await storeUninstall(e.id);
    const { apps: shown, read } = await load();
    const row = read ? shown.find((x) => x.id === e.id) : undefined;
    // A row does NOT disappear when an ordinary app is removed - the registry
    // still lists it, with `installed` false - so "is it still in the list" is
    // no test of anything. Only an app nobody offers loses its row.
    //
    // The press's own answer is right except in one case: a second OK inside
    // one round trip is refused with "not a store app", which means the FIRST
    // one worked. So a refusal is believed only while the app is still there
    // and still installed - and never when the list could not be read at all.
    // One source of several failing does not cost the read: the shell keeps a
    // row for an installed app whatever the sources answered, so "the row is
    // gone" still means the removal happened.
    const gone = read && (row === undefined || !row.installed);
    const removed = ok || gone;
    setStatus({ id: e.id, text: t(removed ? "store.removed" : "store.failed", { name: loc(e.name) }) });
    const stillThere = !!row;
    // Whether the detail can still hold the cursor is decided by the LIST, not
    // by whether this press succeeded. A second OK arriving while the first
    // removal is in flight is answered "not a store app", and focusing
    // detail-remove then parks the cursor on a screen that has already
    // unmounted - every press after it discarded, with only Back out.
    if (stillThere) {
      // What the screen is about to RENDER, not what the press answered: the two
      // disagree whenever the box's reply and its own list do, and naming the
      // button that is not there leaves the cursor on nothing.
      setTimeout(() => setFocus(row && row.installed ? "detail-remove" : "detail-install"), 0);
      return;
    }
    setDetailId(null);
    // The neighbour, not the top of the list: being thrown to the first row
    // costs a screenful of presses to get back in a long store, and the
    // confirmation line lives at the end of the list, below the fold from there.
    // Named, not positional. A list that grew between the press and the reload
    // put the cursor on an unrelated app - and that cursor sits one press from
    // its Uninstall.
    // What is on SCREEN, which is not the same question as what may be believed:
    // a list read while one source of several was down is rendered in full, and
    // the cursor has to land in the list a person is looking at.
    const now = shown;
    const after = before.slice(wasAt + 1).find((x) => now.some((y) => y.id === x.id));
    const back = before
      .slice(0, Math.max(wasAt, 0))
      .reverse()
      .find((x) => now.some((y) => y.id === x.id));
    const keep = after || back;
    // Which of the two the screen actually has: the empty button is rendered
    // only when there is no error, and the retry only when there is. Naming the
    // wrong one leaves the cursor on nothing.
    const bare = read ? "store-empty" : "store-retry";
    const next = keep ? "store-app-" + keep.id : now.length ? "store-app-" + now[0].id : bare;
    // A press queued behind the removal would otherwise open whichever row the
    // cursor just landed on - and an installed app's detail opens focused on
    // its own Uninstall, so a third press removes an app nobody asked about.
    settling.current = Date.now() + 600;
    setTimeout(() => setFocus(next), 0);
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
          // A heading per REASON, not one over the lot: "no longer offered by any
          // source" is false above a row that a store is still serving.
          const reason = e.unlisted ? e.unlistedReason || "retired" : null;
          const opensGroup =
            !!reason && reason !== (all[i - 1]?.unlisted ? all[i - 1]?.unlistedReason || "retired" : null);
          const shownVersion = e.installed && e.installedVersion ? e.installedVersion : e.version;
          const subtitle = [
            e.tagline ? loc(e.tagline) : null,
            t("store.vShort", { v: shownVersion }),
            // Only for an added registry: naming the official one on every row
            // would be noise, while an app from somewhere else is exactly what a
            // person scrolling the catalogue needs to see without opening it.
            // The catch-all is the LEAST specific sentence: a reason this build
            // does not know must not be announced as "this box cannot read it".
            e.unlisted
              ? reason === "retired"
                ? t("store.unlisted")
                : reason === "blocked"
                  ? t("store.blocked")
                  : reason === "unreadable"
                    ? t("store.unreadable")
                    : t("store.unchecked")
              : null,
            e.source && !e.source.official ? t("store.fromSource", { name: sourceLabel(e.source) }) : null,
            e.urlConfig && e.installed && !e.baseUrl ? t("store.urlMissing") : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Fragment key={e.id}>
              {opensGroup && (
                <div className="mt-[1.4vh] px-[1.5vw] text-[1.7vh] text-fg-dim">
                  {reason === "retired"
                    ? t("store.unlistedGroup")
                    : reason === "blocked"
                      ? t("store.blockedGroup")
                      : reason === "unreadable"
                        ? t("store.unreadableGroup")
                        : t("store.uncheckedGroup")}
                </div>
              )}
              <FocusButton
                focusKey={"store-app-" + e.id}
                onEnter={() => {
                  if (Date.now() < settling.current) return;
                  setDetailId(e.id);
                }}
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
          // Focusable, not a sentence. An empty store used to hold nothing the
          // D-pad could reach, so arrows and OK did nothing at all and only Back
          // escaped - and removing the last app is a way to arrive here.
          <FocusButton
            focusKey="store-empty"
            onEnter={() => {
              if (Date.now() < settling.current) return;
              load(true);
            }}
            className="px-[1.6vw] h-[5vh] rounded-[1vh] bg-white/5 flex items-center justify-center text-[1.9vh] font-semibold self-start"
          >
            {t("store.empty")} · {t("app.retry")}
          </FocusButton>
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
