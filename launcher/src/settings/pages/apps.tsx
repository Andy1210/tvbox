import { useI18n } from "../../lib/i18n";
import { useConfigStore } from "../../stores/config";
import { StoreSettings } from "../../components/StoreSettings";
import { AppOrderSettings } from "../../components/AppOrderSettings";
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
    <SettingsPage id="store" title={t("store.title")} onBack={nav.pop} animate="push" focusPolicy="legacy" width="full">
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
  const { t } = useI18n();
  const nav = useSettingsNav();
  const appsAuto = useConfigStore((s) => s.config?.update.appsAuto ?? true);
  const setUpdate = useConfigStore((s) => s.setUpdate);

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
          id="order"
          label={t("apps.orderTitle")}
          hint={t("apps.orderHint")}
          onEnter={() =>
            nav.push({ id: "apporder", title: t("apps.orderTitle"), wide: true, render: () => <AppOrderPage /> })
          }
        />
      </Group>
      <Group>
        <ToggleRow
          id="apps-auto"
          label={t("update.appsAuto")}
          hint={t("update.appsAutoHint")}
          on={appsAuto}
          onToggle={() => void setUpdate({ appsAuto: !appsAuto })}
          onWord={t("common.on")}
          offWord={t("common.off")}
        />
      </Group>
    </SettingsPage>
  );
}
