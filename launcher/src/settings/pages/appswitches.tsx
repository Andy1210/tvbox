import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchAppsOrNull, setAppSwitch } from "../../lib/api";
import type { AppManifest } from "../../lib/types";
import { SettingsPage } from "../SettingsPage";
import { Group, Note, Row, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";

// Settings -> Apps -> extra app settings: the on/off settings an app asks the BOX
// for, because its own screen cannot hold them.
//
// Two kinds of app end up here. A native app has no screen of ours at all, and a
// remote app's screen is not ours to add anything to - YouTube's TV page is
// Google's, so the switch that decides whether the box answers a phone's cast has
// nowhere else to live. It is a page of its own rather than a row on the app's
// management screen, because that screen is behind "Home screen order", which is
// deliberately about ordering: a setting nobody can find is a setting nobody has.
//
// The shell knows nothing about what a switch does. It carries the label the
// manifest declared and hands the value to the app's own plugin, which is what acts
// on it - and it only offers a switch whose plugin is actually loaded.
export function AppSwitchesPage() {
  const { t, loc, tag } = useI18n();
  const nav = useSettingsNav();
  const [apps, setApps] = useState<AppManifest[] | null>(null);
  // The box did not answer. A page that claims what the apps declare must not make
  // that claim out of a failed fetch - but it only takes over the SCREEN while there
  // is nothing to show: a reload that fails after a successful write would otherwise
  // replace the setting the person just changed with an error about the box.
  const [unreachable, setUnreachable] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const list = await fetchAppsOrNull();
    setUnreachable(list === null);
    if (list) setApps(list);
    setBusy(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Only the apps that declare one, by name - the list is otherwise every app on
  // the box, most of them with nothing to show here.
  const rows = (apps ?? [])
    .filter((a) => (a.switches || []).length > 0)
    .sort((x, y) => loc(x.name).localeCompare(loc(y.name), tag))
    .flatMap((a) => (a.switches || []).map((s) => ({ app: a, sw: s })));

  // Which rows have a write in flight, by row - not one flag for the page: two
  // switches are two independent writes, and a page-wide guard silently drops the
  // second press with nothing on screen to explain it. A ref because two presses in
  // one React batch read the same state.
  const saving = useRef(new Set<string>());
  const onToggle = async (id: string, key: string, on: boolean) => {
    const rowKey = id + "/" + key;
    if (saving.current.has(rowKey)) return;
    saving.current.add(rowKey);
    setFailed(false);
    // Optimistic, then reload: the flip has to feel immediate on a TV, and the
    // reload is what makes a refused write visible instead of silently kept.
    setApps(
      (prev) =>
        prev &&
        prev.map((a) =>
          a.id !== id ? a : { ...a, switches: (a.switches || []).map((s) => (s.key === key ? { ...s, on } : s)) },
        ),
    );
    const ok = await setAppSwitch(id, key, on);
    if (!ok) setFailed(true);
    await load();
    // Released only after the answer AND the reload: a press accepted in between
    // would have its value overwritten by the older snapshot.
    saving.current.delete(rowKey);
  };

  // Nothing to show AND no answer: the page is about the box's apps, and it does not
  // know any. "Unreachable" alone reads oddly on a screen the box is drawing, so it
  // carries the sentence that explains it, the same pair the launcher shows elsewhere.
  if (unreachable && apps === null) {
    return (
      <SettingsPage id="appswitches" title={t("appswitches.title")} onBack={nav.pop} animate="push">
        <Note tone="warn">{t("app.shellUnreachable")}</Note>
        <Note>{t("app.shellUnreachableHint")}</Note>
        <Group>
          <Row
            id="retry"
            label={busy ? t("common.working") : t("app.retry")}
            hint={undefined}
            trailing="none"
            autoFocus
            disabled={busy}
            onEnter={() => void load()}
          />
        </Group>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage id="appswitches" title={t("appswitches.title")} onBack={nav.pop} animate="push">
      {failed && <Note tone="warn">{t("appswitches.saveFailed")}</Note>}
      {/* A reload that failed while rows are on screen: say so, keep the rows. They
          are the last thing the box confirmed, which is more use than an error. */}
      {unreachable && <Note tone="warn">{t("app.shellUnreachable")}</Note>}
      {apps !== null && rows.length === 0 && <Note>{t("appswitches.none")}</Note>}
      {/* No empty card: a Group with no rows is a rounded box with a sentence in it. */}
      {rows.length > 0 && (
        <Group hint={t("appswitches.hint")}>
          {rows.map(({ app, sw }, i) => (
            <ToggleRow
              key={app.id + "/" + sw.key}
              id={app.id + "-" + sw.key}
              label={loc(app.name) + " - " + loc(sw.label)}
              // A switch whose app cannot act on it right now is shown, greyed, and
              // says so: hiding it would leave somebody following the app's release
              // notes with no trace of a setting that is supposed to be here.
              hint={sw.available === false ? t("appswitches.unavailable") : sw.hint ? loc(sw.hint) : undefined}
              on={sw.on}
              disabled={sw.available === false}
              onToggle={() => void onToggle(app.id, sw.key, !sw.on)}
              onWord={t("common.on")}
              offWord={t("common.off")}
              autoFocus={i === 0}
            />
          ))}
        </Group>
      )}
    </SettingsPage>
  );
}
