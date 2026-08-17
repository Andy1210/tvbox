import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchApps, setAppSwitch } from "../../lib/api";
import type { AppManifest } from "../../lib/types";
import { SettingsPage } from "../SettingsPage";
import { Group, Note, ToggleRow } from "../Rows";

// Settings -> Apps -> App settings: the on/off settings an app asks the BOX for,
// because its own screen cannot hold them.
//
// Two kinds of app end up here. A native app has no screen of ours at all, and a
// remote app's screen is not ours to add anything to - YouTube's TV page is
// Google's, so the switch that decides whether the box answers a phone's cast has
// nowhere else to live. It is a page of its own rather than a row on the app's
// management screen, because that screen is behind "Home screen order", which is
// deliberately about ordering: a setting nobody can find is a setting nobody has.
//
// The shell knows nothing about what a switch does. It carries the label the
// manifest declared and hands the value to the app's own plugin, which is what
// acts on it.
export function AppSwitchesPage() {
  const { t, loc, tag } = useI18n();
  const [apps, setApps] = useState<AppManifest[] | null>(null);

  const load = useCallback(async () => {
    setApps(await fetchApps());
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

  // One write at a time: two quick presses otherwise leave two in flight and the
  // first answer replaces the state with a snapshot taken before the second. A ref,
  // not state, because both presses in one React batch read the same state.
  const saving = useRef(false);
  const onToggle = async (id: string, key: string, on: boolean) => {
    if (saving.current) return;
    saving.current = true;
    // Optimistic, then reload: the flip has to feel immediate on a TV, and the
    // reload is what makes a refused write visible instead of silently kept.
    setApps(
      (prev) =>
        prev &&
        prev.map((a) =>
          a.id !== id ? a : { ...a, switches: (a.switches || []).map((s) => (s.key === key ? { ...s, on } : s)) },
        ),
    );
    await setAppSwitch(id, key, on);
    saving.current = false;
    await load();
  };

  return (
    <SettingsPage id="appswitches" title={t("appswitches.title")}>
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
