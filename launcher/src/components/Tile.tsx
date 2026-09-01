import { useEffect } from "react";
import type { AppManifest } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { useFocusableItem } from "../lib/useFocusableItem";
import { Icon } from "./Icon";

export function Tile({
  app,
  focusKey,
  onSelect,
  onArrowPress,
  onFocused,
}: {
  app: AppManifest;
  /** Given rather than derived from the id: HOME owns its key namespace, because
   *  an app id may legally read like one of the other rows' keys. */
  focusKey: string;
  onSelect: (app: AppManifest) => void;
  /** Intercept an arrow before spatial navigation resolves it (see FocusButton). */
  onArrowPress?: (direction: string) => boolean;
  /** Called with this tile's id when it takes focus, so the rail can be
   *  re-entered where it was left. */
  onFocused?: (id: string) => void;
}) {
  const { t, loc } = useI18n();
  const ready = app.status === "ready";

  // keep the focused tile centered in the horizontally-scrolling rail
  const { ref, focused } = useFocusableItem(
    { focusKey, onEnterPress: () => onSelect(app), onArrowPress },
    { behavior: "smooth", inline: "center", block: "nearest" },
  );

  useEffect(() => {
    if (focused) onFocused?.(app.id);
  }, [focused, onFocused, app.id]);

  return (
    <div
      ref={ref}
      data-id={app.id}
      onClick={() => onSelect(app)}
      className={[
        "relative flex-none w-[16.7vw] aspect-[16/10] rounded-[1.6vh] overflow-hidden",
        // Only transform is transitioned - box-shadow isn't compositable, so
        // animating it repaints the tile every frame. The shadow is the same in
        // both states; focus is the scale plus an outline that snaps on.
        "flex flex-col justify-end p-[2vh] transition-transform duration-150",
        // vh, not px: a 3px ring is a hairline at 4K and bold at 720p.
        "outline outline-[0.4vh] outline-offset-[0.4vh]",
        "shadow-[0_1vh_3vh_rgba(0,0,0,0.45)]",
        ready ? "" : "opacity-55",
        // The two outline-color classes MUST be mutually exclusive: they have
        // equal specificity, so whichever Tailwind emits last would win no
        // matter what the element asks for (transparent, as it happens).
        focused ? "scale-[1.09] outline-[var(--color-focus)]" : "outline-transparent",
      ].join(" ")}
      style={{ background: `linear-gradient(150deg, ${app.accent || "#8b9db4"}22 0%, #0a0f16 70%)` }}
    >
      <div className="absolute inset-x-0 top-0 bottom-[38%] flex items-center justify-center">
        <Icon svg={app.icon} className="w-[32%] h-auto" />
      </div>

      {!ready ? (
        <div className="absolute top-[1.4vh] right-[1.4vh] text-[1.7vh] font-bold tracking-wide uppercase bg-white/15 px-[1.2vh] py-[0.5vh] rounded-[1.2vh]">
          {t("home.comingSoonBadge")}
        </div>
      ) : app.installing ? (
        <div className="absolute top-[1.4vh] right-[1.4vh] text-[1.7vh] font-bold tracking-wide bg-white/15 px-[1.2vh] py-[0.5vh] rounded-[1.2vh]">
          {t("home.installingBadge")}
        </div>
      ) : app.installable && !app.installed ? (
        <div className="absolute top-[1.4vh] right-[1.4vh] text-[1.7vh] font-bold tracking-wide bg-sky-500/25 text-sky-200 px-[1.2vh] py-[0.5vh] rounded-[1.2vh]">
          {t("home.install")}
        </div>
      ) : null}

      <div className="relative z-10 text-[2.2vh] font-bold leading-tight line-clamp-2">{loc(app.name)}</div>
      {app.tagline && (
        <div className="relative z-10 text-[1.7vh] text-white/70 mt-[0.3vh] truncate">{loc(app.tagline)}</div>
      )}
    </div>
  );
}
