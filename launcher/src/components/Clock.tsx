import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { greetingKey } from "../lib/greeting";
import { useConfigStore } from "../stores/config";
import { fetchWeather, weatherGroup, type Weather } from "../lib/ambient";
import { WeatherIcon } from "./Ambient";

// Locale-correct clock + greeting + a small weather chip (shares the ambient
// screen's Open-Meteo data; hidden until a city is set in Settings). Date/time
// names come from Intl (no hardcoded month/weekday tables), so a new locale
// needs zero extra date strings. NOTE: no CSS `capitalize` on the date - it
// title-cases every word, which is wrong Hungarian orthography (months and
// weekdays are lowercase).
export function Clock() {
  const { t, tag } = useI18n();
  const [now, setNow] = useState(() => new Date());
  const [wx, setWx] = useState<Weather | null>(null);
  const hourFormat = useConfigStore((s) => s.config?.ui.hourFormat) || "auto";
  const city = useConfigStore((s) => s.config?.ambient.city) || "";

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!city) {
      setWx(null); // drop stale weather when the city is cleared, don't keep showing it
      return;
    }
    fetchWeather().then(setWx);
    const id = setInterval(() => fetchWeather().then(setWx), 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [city]);

  const hour12 = hourFormat === "12" ? true : hourFormat === "24" ? false : undefined;
  const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hour12 }).format(now);
  const date = new Intl.DateTimeFormat(tag, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);

  return (
    <div className="flex items-start justify-between w-full">
      <div>
        <div className="text-[2.4vh] font-semibold">{t(`greeting.${greetingKey(now.getHours())}`)}</div>
        {wx && wx.tempC != null && (
          <div className="flex items-center gap-[0.6vw] mt-[0.8vh] text-fg-dim">
            <WeatherIcon group={weatherGroup(wx.code)} className="w-[2.6vh] h-[2.6vh]" />
            <span className="text-[1.9vh] font-semibold tabular-nums">{wx.tempC}°</span>
            <span className="text-[1.9vh]">{t("ambient.wx." + weatherGroup(wx.code))}</span>
          </div>
        )}
      </div>
      <div className="text-right">
        <div className="text-[3.4vh] font-bold leading-none tabular-nums">{time}</div>
        <div className="text-[1.8vh] text-fg-dim mt-[0.5vh]">{date}</div>
      </div>
    </div>
  );
}
