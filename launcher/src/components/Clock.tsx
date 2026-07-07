import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { greetingKey } from "../lib/greeting";

// Locale-correct clock + greeting. Date/time names come from Intl (no hardcoded
// month/weekday tables), so a new locale needs zero extra date strings.
export function Clock() {
  const { t, tag } = useI18n();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);

  const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }).format(now);
  const date = new Intl.DateTimeFormat(tag, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);

  return (
    <div className="flex items-start justify-between w-full">
      <div className="text-[2.4vh] font-semibold">{t(`greeting.${greetingKey(now.getHours())}`)}</div>
      <div className="text-right">
        <div className="text-[3.4vh] font-bold leading-none tabular-nums">{time}</div>
        <div className="text-[1.8vh] text-fg-dim mt-[0.5vh] capitalize">{date}</div>
      </div>
    </div>
  );
}
