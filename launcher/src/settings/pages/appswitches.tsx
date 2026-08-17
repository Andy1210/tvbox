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
  // null = still loading; true = the box did not answer. A page that claims what the
  // apps declare must not make that claim out of a failed fetch.
  const [unreachable, setUnreachable] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const list = await fetchAppsOrNull();
    setUnreachable(list === null);
    if (list) setApps(list);
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

  if (unreachable) {
    return (
      <SettingsPage id="appswitches" title={t("appswitches.title")} onBack={nav.pop} animate="push">
        <Group>
          <Note tone="warn">{t("app.shellUnreachable")}</Note>
          <Row id="retry" label={t("app.retry")} trailing="none" autoFocus onEnter={() => void load()} />
        </Group>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage id="appswitches" title={t("appswitches.title")} onBack={nav.pop} animate="push">
      {failed && <Note tone="warn">{t("common.saveFailed")}</Note>}
      <Group hint={t("appswitches.hint")}>
        {apps !== null && rows.length === 0 && <Note>{t("appswitches.none")}</Note>}
        {rows.map(({ app, sw }, i) => (
          <ToggleRow
            key={app.id + "/" + sw.key}
            id={app.id + "-" + sw.key}
            label={loc(app.name) + " - " + loc(sw.label)}
            hint={sw.hint ? loc(sw.hint) : undefined}
            on={sw.on}
            onToggle={() => void onToggle(app.id, sw.key, !sw.on)}
            onWord={t("common.on")}
            offWord={t("common.off")}
            autoFocus={i === 0}
          />
        ))}
      </Group>
    </SettingsPage>
  );
}
