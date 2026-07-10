import { useEffect, useState, type ReactNode } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { FocusButton } from "./FocusButton";
import { LanguageSettings } from "./LanguageSettings";
import { RegionSettings } from "./RegionSettings";
import { HostnameSettings } from "./HostnameSettings";
import { WifiSettings } from "./WifiSettings";
import { DisplaySettings } from "./DisplaySettings";
import { AudioSettings } from "./AudioSettings";
import { BluetoothSettings } from "./BluetoothSettings";
import { RemoteRemap } from "./RemoteRemap";
import { AppOrderSettings } from "./AppOrderSettings";
import { StoreSettings } from "./StoreSettings";
import { AmbientSettings } from "./AmbientSettings";
import { ParentalSettings } from "./ParentalSettings";
import { AboutSettings } from "./AboutSettings";
import { UpdateSettings } from "./UpdateSettings";
import { BackupSettings } from "./BackupSettings";

// Device settings, grouped into categories (drill-down: a category list → the
// chosen category's panel → Back returns). Keeps each panel short so D-pad nav is
// clean and nothing hides at the bottom of one giant scroll.
const svg = (paths: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-full h-full"
  >
    {paths}
  </svg>
);

interface Category {
  id: string;
  icon: ReactNode;
  render: () => ReactNode;
}
const CATEGORIES: Category[] = [
  {
    id: "general",
    icon: svg(
      <>
        <line x1="4" y1="8" x2="20" y2="8" />
        <circle cx="9" cy="8" r="2" fill="currentColor" stroke="none" />
        <line x1="4" y1="16" x2="20" y2="16" />
        <circle cx="15" cy="16" r="2" fill="currentColor" stroke="none" />
      </>,
    ),
    render: () => (
      <>
        <LanguageSettings />
        <RegionSettings />
        <ParentalSettings />
        <HostnameSettings />
        <AboutSettings />
      </>
    ),
  },
  {
    id: "av",
    icon: svg(
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </>,
    ),
    render: () => (
      <>
        <DisplaySettings />
        <AudioSettings />
      </>
    ),
  },
  {
    id: "network",
    icon: svg(
      <>
        <path d="M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0" />
        <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
      </>,
    ),
    render: () => <WifiSettings />,
  },
  {
    id: "peripherals",
    icon: svg(<path d="M7 7l10 10-5 4V3l5 4L7 17" />),
    render: () => (
      <>
        <BluetoothSettings />
        <RemoteRemap />
      </>
    ),
  },
  {
    id: "apps",
    icon: svg(
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>,
    ),
    render: () => <AppOrderSettings />,
  },
  {
    id: "store",
    icon: svg(
      <>
        <path d="M4 8l1.5-4h13L20 8" />
        <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
        <path d="M9 12h6" />
        <path d="M12 9v6" />
      </>,
    ),
    render: () => <StoreSettings />,
  },
  {
    id: "ambient",
    icon: svg(
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="M21 16l-5-5-6 6" />
      </>,
    ),
    render: () => <AmbientSettings />,
  },
  {
    id: "system",
    icon: svg(
      <>
        <path d="M20 12a8 8 0 1 1-2.3-5.6" />
        <path d="M20 3v4h-4" />
      </>,
    ),
    render: () => (
      <>
        <UpdateSettings />
        <BackupSettings />
      </>
    ),
  },
];

const chevron = svg(<path d="M9 6l6 6-6 6" />);

function CategoryList({ onPick, onExit }: { onPick: (id: string) => void; onExit: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "settings-cats" });
  useEffect(() => {
    setFocus("cat-" + CATEGORIES[0].id);
  }, []);
  useBackspace(onExit);
  return (
    <div className="h-full flex flex-col px-[5vw] py-[4vh] overflow-y-auto no-scrollbar">
      <div className="text-[3vh] font-bold mb-[3vh]">{t("settings.title")}</div>
      <FocusContext.Provider value={focusKey}>
        <div ref={ref} className="flex flex-col gap-[1.2vh] max-w-[64vw]">
          {CATEGORIES.map((c) => (
            <FocusButton
              key={c.id}
              focusKey={"cat-" + c.id}
              onEnter={() => onPick(c.id)}
              className="px-[2.5vw] py-[2vh] rounded-[1.2vh] bg-white/5 flex items-center gap-[1.5vw]"
            >
              <span className="w-[3.2vh] h-[3.2vh] shrink-0 flex items-center justify-center opacity-80">{c.icon}</span>
              <span className="text-[2.4vh] font-semibold flex-1 text-left">{t("settingsCat." + c.id)}</span>
              <span className="w-[2.6vh] h-[2.6vh] shrink-0 opacity-40">{chevron}</span>
            </FocusButton>
          ))}
        </div>
      </FocusContext.Provider>
    </div>
  );
}

function CategoryPanel({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "settings-panel" });
  useEffect(() => {
    setTimeout(() => setFocus("settings-panel"), 0);
  }, []); // norigin focuses the first child
  useBackspace(onBack);
  const cat = CATEGORIES.find((c) => c.id === id);
  return (
    // scrollPaddingTop leaves headroom when a focused item scrolls to the top
    // edge, so the panel header + section title stay reachable (norigin uses
    // block:"nearest"; without this the topmost focusable pins to the very top
    // and hides everything above it).
    <div
      className="h-full flex flex-col px-[5vw] py-[4vh] overflow-y-auto no-scrollbar"
      style={{ scrollPaddingTop: "16vh" }}
    >
      <div className="flex items-center gap-[1.2vw] mb-[1vh]">
        <span className="w-[2.8vh] h-[2.8vh] text-white/50 rotate-180">{chevron}</span>
        <div className="text-[3vh] font-bold">{t("settingsCat." + id)}</div>
      </div>
      <FocusContext.Provider value={focusKey}>
        <div ref={ref}>{cat?.render()}</div>
      </FocusContext.Provider>
    </div>
  );
}

export function Settings({ onExit }: { onExit: () => void }) {
  const [cat, setCat] = useState<string | null>(null);
  return cat ? (
    <CategoryPanel
      id={cat}
      onBack={() => {
        setCat(null);
        setTimeout(() => setFocus("cat-" + cat), 0);
      }}
    />
  ) : (
    <CategoryList onPick={setCat} onExit={onExit} />
  );
}
