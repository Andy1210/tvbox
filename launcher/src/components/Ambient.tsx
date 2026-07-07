import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { fetchWeather, fetchPhotos, photoUrl, weatherGroup, type Weather } from "../lib/ambient";

// Idle/ambient screen: a big clock + weather over a photo slideshow (local
// ~/.tvbox/ambient/ photos, blurred in the Spotify now-playing aesthetic) or an
// elegant gradient when there are none. Any key exits (App's useIdle wakes on
// keydown; we also swallow that first key so it doesn't activate a tile).
function WeatherIcon({ group, className }: { group: string; className?: string }) {
  const p = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (group === "clear")
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <circle cx="12" cy="12" r="4.5" {...p} />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" {...p} />
      </svg>
    );
  if (group === "rain")
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <path d="M7 15a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 15z" {...p} />
        <path d="M8 19l-.5 1.5M12 19l-.5 1.5M16 19l-.5 1.5" {...p} />
      </svg>
    );
  if (group === "snow")
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <path d="M7 15a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 15z" {...p} />
        <path d="M9 19h.01M12 20h.01M15 19h.01" {...p} />
      </svg>
    );
  if (group === "storm")
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <path d="M7 14a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 14z" {...p} />
        <path d="M12 13l-2 4h3l-2 4" {...p} />
      </svg>
    );
  if (group === "fog")
    return (
      <svg viewBox="0 0 24 24" className={className}>
        <path d="M7 13a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 13z" {...p} />
        <path d="M5 17h14M7 20h10" {...p} />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path d="M7 17a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 17z" {...p} />
    </svg>
  );
}

export function Ambient({ onExit }: { onExit: () => void }) {
  const { t, tag } = useI18n();
  const [now, setNow] = useState(() => new Date());
  const [wx, setWx] = useState<Weather | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const clock = setInterval(() => setNow(new Date()), 15000);
    fetchWeather().then(setWx);
    const wxTimer = setInterval(() => fetchWeather().then(setWx), 10 * 60 * 1000);
    fetchPhotos().then(setPhotos);
    return () => {
      clearInterval(clock);
      clearInterval(wxTimer);
    };
  }, []);

  useEffect(() => {
    if (photos.length < 2) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % photos.length), 30000);
    return () => clearInterval(id);
  }, [photos]);

  // Swallow the first key so waking the screen doesn't also trigger a tile.
  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      onExit();
    };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [onExit]);

  const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }).format(now);
  const date = new Intl.DateTimeFormat(tag, { weekday: "long", month: "long", day: "numeric" }).format(now);
  const photo = photos.length ? photoUrl(photos[idx]) : null;

  return (
    <div className="fixed inset-0 z-[60] overflow-hidden bg-[#07090d] text-white" onClick={onExit}>
      {photo ? (
        <>
          {/* blurred cover fills the screen (no letterbox bars); the sharp
              contained copy shows the WHOLE photo without cropping */}
          <img
            src={photo}
            alt=""
            className="absolute inset-0 w-full h-full object-cover scale-110 blur-[28px] opacity-50"
          />
          <img src={photo} alt="" className="absolute inset-0 w-full h-full object-contain" />
        </>
      ) : (
        <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_20%_20%,#1c2740_0%,#0b0f18_55%,#07090d_100%)]" />
      )}
      {/* darken only the bottom for clock/weather legibility, leave the photo visible */}
      <div className="absolute inset-x-0 bottom-0 h-[45vh] bg-gradient-to-t from-black/75 to-transparent" />
      <div className="absolute left-[6vw] bottom-[8vh]">
        <div className="text-[16vh] font-bold leading-[0.9] tabular-nums drop-shadow-[0_0.4vh_2vh_rgba(0,0,0,0.6)]">
          {time}
        </div>
        <div className="text-[3vh] text-white/80 mt-[1vh] capitalize">{date}</div>
        {wx && wx.tempC != null && (
          <div className="flex items-center gap-[1.4vw] mt-[2.4vh] text-white/90">
            <WeatherIcon group={weatherGroup(wx.code)} className="w-[5vh] h-[5vh]" />
            <span className="text-[4vh] font-semibold tabular-nums">{wx.tempC}°</span>
            <span className="text-[2.4vh] text-white/70">
              {t("ambient.wx." + weatherGroup(wx.code))}
              {wx.city ? " · " + wx.city : ""}
            </span>
          </div>
        )}
      </div>
      <div className="absolute right-[6vw] bottom-[8vh] text-[1.8vh] text-white/40">{t("ambient.dismiss")}</div>
    </div>
  );
}
