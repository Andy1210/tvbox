import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { SettingsNavProvider } from "./nav";
import { Rail, type Category } from "./Rail";
import { icons } from "./icons";
import { NetworkPane } from "./pages/network";
import { AvPane } from "./pages/av";
import { PeripheralsPane } from "./pages/peripherals";
import { AppsPane } from "./pages/apps";
import { AmbientPane } from "./pages/ambient";
import { SystemPane } from "./pages/system";
import { AboutPane } from "./pages/about";

// Settings: a category rail on the left, the chosen category's rows on the right,
// and drill-downs pushed over the right-hand pane. Two levels of list instead of
// the three the old screen needed, and no category is a dump - anything with more
// than a handful of controls (Wi-Fi, the file server, the remotes, updates) is its
// own page.
//
// The rail is what makes the "something is always focused" rule cheap to keep: at
// the top level it owns the D-pad, so a category pane never has to invent a focus
// target, and Right steps into the rows.
const CATEGORIES: Category[] = [
  { id: "network", icon: icons.network, render: () => <NetworkPane /> },
  { id: "av", icon: icons.av, render: () => <AvPane /> },
  { id: "peripherals", icon: icons.peripherals, render: () => <PeripheralsPane /> },
  { id: "apps", icon: icons.apps, render: () => <AppsPane /> },
  { id: "ambient", icon: icons.ambient, render: () => <AmbientPane /> },
  { id: "system", icon: icons.system, render: () => <SystemPane /> },
  { id: "about", icon: icons.about, render: () => <AboutPane /> },
];

export function Settings({ onExit }: { onExit: () => void }) {
  const { t } = useI18n();
  const [cat, setCat] = useState(CATEGORIES[0].id);

  // The root handler, and deliberately the FIRST one mounted: useBackspace runs the
  // most recently mounted handler, so a pushed page's own Back always wins and this
  // one only sees the press that leaves Settings.
  useBackspace(onExit);

  useEffect(() => {
    void setFocus("rail:" + CATEGORIES[0].id);
  }, []);

  const current = CATEGORIES.find((c) => c.id === cat) || CATEGORIES[0];

  return (
    <SettingsNavProvider>
      {(stack) => {
        const top = stack[stack.length - 1];
        const wide = !!top?.wide;
        return (
          <div className="h-full flex flex-col px-[4.5vw] pt-[3.4vh]">
            <h1 className="text-[3.6vh] font-bold leading-none mb-[2.8vh] shrink-0">{t("settings.title")}</h1>
            <div className="flex-1 min-h-0 flex gap-[2.4vw]">
              {!wide && <Rail categories={CATEGORIES} selected={cat} onSelect={setCat} enabled={stack.length === 0} />}
              {/* Only the top of the stack is mounted. A level below stays in the
                  spatial-nav tree if it is merely hidden, and the D-pad would then
                  reach rows nobody can see. */}
              <div className="flex-1 min-w-0">
                {top ? <div key={top.id}>{top.render()}</div> : <div key={cat}>{current.render()}</div>}
              </div>
            </div>
          </div>
        );
      }}
    </SettingsNavProvider>
  );
}
