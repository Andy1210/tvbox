import { type ReactNode } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useFocusableItem } from "../lib/useFocusableItem";

// The category rail. Selection follows focus: moving down it changes what the
// content pane shows, so the box answers every press immediately instead of
// making the user commit before seeing anything.
//
// While a page is pushed the rail is still drawn - it is the user's bearing - but
// its items leave the spatial-nav tree entirely (`focusable: false`). A visible
// row the D-pad can reach would let Left strand focus on the rail with a
// half-finished page still on screen.
export interface Category {
  id: string;
  icon: ReactNode;
  render: () => ReactNode;
}

function RailItem({
  cat,
  selected,
  enabled,
  onSelect,
}: {
  cat: Category;
  selected: boolean;
  enabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const { ref, focused } = useFocusableItem(
    {
      focusKey: "rail:" + cat.id,
      focusable: enabled,
      onEnterPress: onSelect,
      // Selection follows focus, so arriving here IS choosing.
      onFocus: onSelect,
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      // Only while the rail is the thing you can navigate. It leaves the spatial-nav
      // tree when a page is pushed, and a mouse - the box does support one - could
      // otherwise switch category behind the open page, which is the state the whole
      // "the rail stands down" rule exists to prevent.
      onClick={enabled ? onSelect : undefined}
      className={[
        "flex items-center gap-[1vw] px-[1.3vw] py-[1.5vh] rounded-[1.2vh] min-h-[6.4vh]",
        // Three states, not two: focused (the D-pad is here), selected-but-not-
        // focused (the pane below belongs to this one), and neither. Without the
        // middle one the user loses track of which category they are inside the
        // moment they step right into the content.
        focused ? "bg-white text-[#06090d]" : selected ? "bg-white/[0.09] text-fg" : "text-fg-dim",
      ].join(" ")}
    >
      <span className={"w-[2.9vh] h-[2.9vh] shrink-0 " + (focused || selected ? "opacity-100" : "opacity-70")}>
        {cat.icon}
      </span>
      <span className="text-[2.1vh] font-semibold leading-tight">{t("settingsCat." + cat.id)}</span>
    </div>
  );
}

export function Rail({
  categories,
  selected,
  onSelect,
  enabled,
}: {
  categories: Category[];
  selected: string;
  onSelect: (id: string) => void;
  enabled: boolean;
}) {
  // A focus CONTAINER, not just a column of items, and that is what makes Left work.
  // Spatial navigation picks the geometrically nearest focusable, so pressing Left
  // from the third row of the content landed on the third CATEGORY - and because
  // selection follows focus, that silently switched category instead of going back
  // to the one you were in. Navigating into a container consults
  // preferredChildFocusKey instead, so Left always returns to where you were.
  const { ref, focusKey } = useFocusable({
    focusKey: "rail",
    focusable: enabled,
    preferredChildFocusKey: "rail:" + selected,
    // The preference IS the selection, so remembering some earlier child would only
    // fight it.
    saveLastFocusedChild: false,
  });
  return (
    <FocusContext.Provider value={focusKey}>
      <nav ref={ref} className="w-[21vw] shrink-0 flex flex-col gap-[0.5vh] overflow-y-auto no-scrollbar">
        {categories.map((c) => (
          <RailItem key={c.id} cat={c} selected={c.id === selected} enabled={enabled} onSelect={() => onSelect(c.id)} />
        ))}
      </nav>
    </FocusContext.Provider>
  );
}
