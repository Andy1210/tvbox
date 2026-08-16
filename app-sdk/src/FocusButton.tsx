import { useEffect, type ReactNode } from "react";
import { useFocusableItem } from "./useFocusableItem";

// Reusable D-pad-focusable button: white focus ring + slight scale, scrolls into
// view on focus. Used by Settings, the PIN pad, etc.
export function FocusButton({
  focusKey,
  onEnter,
  className,
  children,
  label,
  onFocused,
  onArrowPress,
}: {
  focusKey?: string;
  onEnter: () => void;
  className?: string;
  children: ReactNode;
  label?: string; // accessible name - needed when the visible content is an icon
  /**
   * Intercept an arrow before spatial navigation resolves it.
   *
   * Return false to say the press is handled. For the cases where geometry
   * gives the right answer and the wrong destination - the edge of a rail that
   * should reach the header above it rather than whatever happens to lie up and
   * to the left.
   */
  onArrowPress?: (direction: string) => boolean;
  /**
   * Called when this button takes focus.
   *
   * For what scrollIntoView cannot express: bringing the page's own header into
   * view when its topmost focusable is reached, which is otherwise unreachable
   * because nothing above it is focusable.
   */
  onFocused?: () => void;
}) {
  const { ref, focused } = useFocusableItem({ focusKey, onEnterPress: onEnter, onArrowPress }, { block: "nearest" });

  useEffect(() => {
    if (focused) onFocused?.();
  }, [focused, onFocused]);

  return (
    <div
      ref={ref}
      onClick={onEnter}
      aria-label={label}
      // The focus key, in the DOM. The settings rows already carry theirs this
      // way and their navigation tests depend on it: without a marker a test
      // cannot place a rectangle on the right element, and a navigation
      // assertion with no rectangles is decided by nothing at all.
      data-sfocus={focusKey}
      className={[
        // transform only: background-color/color aren't compositable, so
        // transitioning them repaints on every D-pad move (this is the most-used
        // focusable in the UI). The fill still changes, it just snaps.
        "transition-transform duration-150",
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
