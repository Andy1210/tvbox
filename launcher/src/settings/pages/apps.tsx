import { useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { useConfigStore } from "../../stores/config";
import { fetchAppsOrNull } from "../../lib/api";
import { StoreSettings } from "../../components/StoreSettings";
import { AppOrderSettings } from "../../components/AppOrderSettings";
import { StoreSourcesPage } from "./storesources";
import { AppSwitchesPage } from "./appswitches";
import { SettingsPage } from "../SettingsPage";
import { Group, Row, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";

// Settings -> Apps. The store used to be a top-level category of its own next to
// "Apps", which read as two places for one subject; it is a page here now.
//
// Both screens keep their existing components: the store is a catalogue with
// screenshots and release notes, and the order editor is a drag-by-D-pad grid.
// Neither is a list of settings, so both bring their own focus handling and are
// marked `wide` - they need the rail's width, and the rail is not useful while you
// are inside them.
function StorePage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  return (
    <SettingsPage
      id="store"
      title={t("store.title")}
      subtitle={t("store.hint")}
      onBack={nav.pop}
      animate="push"
      focusPolicy="legacy"
      width="full"
    >
      <StoreSettings />
    </SettingsPage>
  );
}

function AppOrderPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  return (
    <SettingsPage
      id="apporder"
      title={t("apps.orderTitle")}
      subtitle={t("appsettings.hint")}
      onBack={nav.pop}
      animate="push"
      focusPolicy="legacy"
      width="full"
    >
      <AppOrderSettings />
    </SettingsPage>
  );
}

export function AppsPane() {
  const { t, loc } = useI18n();
  const nav = useSettingsNav();
  const appsAuto = useConfigStore((s) => s.config?.update.appsAuto ?? true);
  const setUpdate = useConfigStore((s) => s.setUpdate);
  // What is behind the row below - the SWITCH labels, not the app names: somebody
  // scanning Settings is looking for the feature ("cast from phone"), and the app it
  // belongs to tells them nothing. Empty = no row at all.
  // null = the box did not answer, which must not read as "no app has one": the row
  // stays, so the page behind it can say what actually happened.
  const [switchLabels, setSwitchLabels] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchAppsOrNull().then((list) => {
      if (!alive) return;
      setSwitchLabels(list === null ? null : list.flatMap((a) => (a.switches || []).map((s) => loc(s.label))));
    });
    return () => {
      alive = false;
    };
    // loc changes with the UI language, and a language change reloads the launcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The store's value only changes once the save comes back, so two quick presses
  // would both compute the same `!appsAuto` and the box would end up on whichever
  // reply landed last - not on what the user pressed last.
  const [saving, setSaving] = useState(false);

  return (
    <SettingsPage id="apps" focusPolicy="rail">
      <Group>
        <Row
          id="store"
          label={t("store.title")}
          hint={t("store.hint")}
          onEnter={() => nav.push({ id: "store", title: t("store.title"), wide: true, render: () => <StorePage /> })}
        />
        <Row
          id="store-sources"
          label={t("storeSources.title")}
          hint={t("storeSources.hint")}
          onEnter={() =>
            nav.push({ id: "store-sources", title: t("storeSources.title"), render: () => <StoreSourcesPage /> })
          }
        />
        <Row
          id="order"
          label={t("apps.orderTitle")}
          hint={t("apps.orderHint")}
          onEnter={() =>
            nav.push({ id: "apporder", title: t("apps.orderTitle"), wide: true, render: () => <AppOrderPage /> })
          }
        />
        {/* Only when an installed app actually declares one: without this the row is a
            press that leads to an empty page, which is exactly what a fresh box has
            (nothing declares a switch until an app that has one lands). The value
            names the FEATURES behind it, the way the Network rows show their state.
            Last in the group, because it arrives with a fetch: inserted higher up it
            would shift the row under somebody's focus when it lands. */}
        {(switchLabels === null || switchLabels.length > 0) && (
          <Row
            id="app-switches"
            label={t("appswitches.title")}
            hint={t("appswitches.rowHint")}
            value={
              switchLabels === null
                ? ""
                : switchLabels.slice(0, 2).join(", ") +
                  (switchLabels.length > 2 ? " +" + (switchLabels.length - 2) : "")
            }
            onEnter={() =>
              nav.push({ id: "appswitches", title: t("appswitches.title"), render: () => <AppSwitchesPage /> })
            }
          />
        )}
      </Group>
      <Group>
        <ToggleRow
          id="apps-auto"
          label={t("update.appsAuto")}
          hint={t("update.appsAutoHint")}
          on={appsAuto}
          disabled={saving}
          onToggle={() => {
            setSaving(true);
            void setUpdate({ appsAuto: !appsAuto }).finally(() => setSaving(false));
          }}
          onWord={t("common.on")}
          offWord={t("common.off")}
        />
      </Group>
    </SettingsPage>
  );
}
