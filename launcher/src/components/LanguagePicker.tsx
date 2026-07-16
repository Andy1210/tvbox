import { AVAILABLE_LOCALES, useI18n, type LocaleInfo } from "../lib/i18n";
import { useFocusableItem } from "../lib/useFocusableItem";

// Shared, scalable language picker. A wrapping auto-fit grid of focusable
// options that scrolls when it overflows, so it reads well with 2 languages and
// still with 15+ (the old fixed flex-row overflowed off-screen). Used by BOTH
// the first-boot wizard's language step and Settings -> General. Each option is
// focusKey "lang-<id>"; the active locale gets an unmistakable selected state (a
// filled tint + solid ring + check mark), not just a faint ring.
//
// `onPicked` lets the host react to a selection without the picker knowing about
// it - the wizard passes one that moves D-pad focus to its Next button, so the
// pick is obviously registered; Settings passes none and focus stays put.
function Check({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function LangOption({
  locale,
  active,
  size,
  onPick,
}: {
  locale: LocaleInfo;
  active: boolean;
  size: "md" | "lg";
  onPick: (id: string) => void;
}) {
  const { ref, focused } = useFocusableItem<HTMLButtonElement>(
    { focusKey: "lang-" + locale.id, onEnterPress: () => onPick(locale.id) },
    { block: "nearest" },
  );
  return (
    <button
      ref={ref}
      onClick={() => onPick(locale.id)}
      className={[
        "relative w-full rounded-[1.4vh] font-bold text-center truncate",
        "transition-[transform,background-color,color] duration-150",
        size === "lg" ? "px-[2vw] py-[2.6vh] text-[2.8vh]" : "px-[1.5vw] py-[1.6vh] text-[2.2vh]",
        // Selected (but not focused): filled tint + solid ring + check, so the
        // choice stays obvious even after focus moves to the Next button.
        active ? "bg-white/15 ring-[0.3vh] ring-white" : "bg-white/5",
        // Focus is still the brightest state (dark text on a white fill).
        focused ? "bg-white! text-[#06090d]! scale-[1.04] shadow-[0_0.6vh_2vh_rgba(0,0,0,0.5)]" : "",
      ].join(" ")}
    >
      {active && <Check className="absolute left-[1vw] top-1/2 -translate-y-1/2 w-[2.4vh] h-[2.4vh]" />}
      {locale.name}
    </button>
  );
}

export function LanguagePicker({ size = "md", onPicked }: { size?: "md" | "lg"; onPicked?: (id: string) => void }) {
  const { setLocale, locale } = useI18n();
  const pick = (id: string) => {
    setLocale(id);
    onPicked?.(id);
  };
  return (
    <div
      className="grid gap-[1.4vh] max-w-[70vw] max-h-full overflow-y-auto no-scrollbar px-[1.5vw] -mx-[1.5vw]"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(18vw, 1fr))" }}
    >
      {AVAILABLE_LOCALES.map((l) => (
        <LangOption key={l.id} locale={l} active={locale === l.id} size={size} onPick={pick} />
      ))}
    </div>
  );
}
