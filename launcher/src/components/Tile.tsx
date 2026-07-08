import { useEffect } from "react";
import type { AppManifest } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { useFocusableItem } from "../lib/useFocusableItem";
import { Icon } from "./Icon";

export function Tile({ app, onSelect }: { app: AppManifest; onSelect: (app: AppManifest) => void }) {
  const { t, loc } = useI18n();
  const ready = app.status === "ready";

  // keep the focused tile centered in the horizontally-scrolling rail
  const { ref, focused } = useFocusableItem(
    { focusKey: app.id, onEnterPress: () => onSelect(app) },
    { behavior: "smooth", inline: "center", block: "nearest" },
  );

  // tint the ambient backdrop (Backdrop.tsx) with the focused app's accent -
  // the .tv-backdrop-accent layer transitions when this variable changes
  useEffect(() => {
    if (focused) document.documentElement.style.setProperty("--tile-accent", app.accent || "#4152d8");
  }, [focused, app.accent]);

  return (
    <div
      ref={ref}
      data-id={app.id}
      onClick={() => onSelect(app)}
      className={[
        "relative flex-none w-[22vw] max-w-[320px] aspect-[16/10] rounded-[1.6vh] overflow-hidden",
        "flex flex-col justify-end p-[2vh] transition-[transform,box-shadow,outline-color] duration-150",
        "outline outline-[3px] outline-transparent outline-offset-[3px]",
        ready ? "" : "opacity-55",
        focused
          ? "scale-[1.09] outline-[var(--color-focus)] shadow-[0_2vh_5vh_rgba(0,0,0,0.6)]"
          : "shadow-[0_1vh_3vh_rgba(0,0,0,0.45)]",
      ].join(" ")}
      style={{ background: `linear-gradient(150deg, ${app.accent || "#8b9db4"}22 0%, #0a0f16 70%)` }}
    >
      <div className="absolute inset-x-0 top-0 bottom-[38%] flex items-center justify-center">
        <Icon svg={app.icon} className="w-[32%] h-auto" />
      </div>

      {!ready ? (
        <div className="absolute top-[1.4vh] right-[1.4vh] text-[1.2vh] font-bold tracking-wide uppercase bg-white/15 px-[1vh] py-[0.5vh] rounded-[1vh]">
          {t("home.comingSoonBadge")}
        </div>
      ) : app.installing ? (
        <div className="absolute top-[1.4vh] right-[1.4vh] text-[1.2vh] font-bold tracking-wide bg-white/15 px-[1vh] py-[0.5vh] rounded-[1vh]">
          {t("home.installingBadge")}
        </div>
      ) : app.installable && !app.installed ? (
        <div className="absolute top-[1.4vh] right-[1.4vh] text-[1.2vh] font-bold tracking-wide bg-sky-500/25 text-sky-200 px-[1vh] py-[0.5vh] rounded-[1vh]">
          {t("home.install")}
        </div>
      ) : null}

      <div className="relative z-10 text-[2.2vh] font-bold leading-tight">{loc(app.name)}</div>
      {app.tagline && <div className="relative z-10 text-[1.5vh] text-white/70 mt-[0.3vh]">{loc(app.tagline)}</div>}
    </div>
  );
}
