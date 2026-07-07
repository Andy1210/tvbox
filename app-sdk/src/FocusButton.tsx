import { type ReactNode } from "react";
import { useFocusableItem } from "./useFocusableItem";

// Reusable D-pad-focusable button: white focus ring + slight scale, scrolls into
// view on focus. Used by Settings, the PIN pad, etc.
export function FocusButton({
  focusKey,
  onEnter,
  className,
  children,
}: {
  focusKey?: string;
  onEnter: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { ref, focused } = useFocusableItem({ focusKey, onEnterPress: onEnter }, { block: "nearest" });
  return (
    <div
      ref={ref}
      onClick={onEnter}
      className={[
        "transition-[transform,background-color,color] duration-150",
        // Focus is the single, unmistakable highlight: a bright fill with dark
        // text (overrides any base bg). Nothing else should look "selected".
        focused ? "!bg-white !text-[#06090d] scale-[1.04] shadow-[0_0.6vh_2vh_rgba(0,0,0,0.5)]" : "",
        className || "",
      ].join(" ")}
    >
      {children}
    </div>
  );
}
