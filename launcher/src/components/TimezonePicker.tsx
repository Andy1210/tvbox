import { useEffect, useMemo, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { fetchRegion, setTimezone } from "../lib/region";
import { FocusButton } from "./FocusButton";

// Region -> City drill-down over the ~485 IANA zones ("Region/City", some
// "Region/Sub/City"). Self-fetching + self-posting so it drops into both the
// wizard (inline) and Settings (inside an overlay). Zones with no "/" (e.g.
// "UTC") become their own single-entry region. Fills its parent's height and
// scrolls the long lists internally.
//
// Back handling: in the city list a Back row (and Backspace) returns to the
// region list; at the region list the Backspace handler is disabled, so the
// parent (wizard step -> previous step; settings overlay -> close) owns Back.
interface City {
  label: string; // display text (rest of the zone, "_" -> space)
  tz: string; // full IANA id to POST
}

function group(zones: string[]): { regions: string[]; byRegion: Map<string, City[]> } {
  const byRegion = new Map<string, City[]>();
  for (const tz of zones) {
    const i = tz.indexOf("/");
    const region = i === -1 ? tz : tz.slice(0, i);
    const rest = i === -1 ? tz : tz.slice(i + 1);
    const list = byRegion.get(region) ?? [];
    list.push({ label: rest.replace(/_/g, " "), tz });
    byRegion.set(region, list);
  }
  const regions = [...byRegion.keys()].sort((a, b) => a.localeCompare(b));
  for (const r of regions) byRegion.get(r)!.sort((a, b) => a.label.localeCompare(b.label));
  return { regions, byRegion };
}

export function TimezonePicker({ onChange, autoFocus }: { onChange?: (tz: string) => void; autoFocus?: boolean }) {
  const { t } = useI18n();
  const [zones, setZones] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [selected, setSelected] = useState<string | null>(null); // region being drilled into (null = region list)
  const [pending, setPending] = useState<string | null>(null); // tz whose POST is in flight
  const [picked, setPicked] = useState<string | null>(null); // last chosen, even if the POST was refused
  const [saved, setSaved] = useState(false); // brief "set" confirmation on the Current line
  const [deferred, setDeferred] = useState(false); // POST returned false -> "applies later"

  // Fetch exactly once per mount (empty deps). autoFocus is read here but is a
  // stable prop, so it does not need to be a dependency - a refetch loop would
  // be a bug on this endpoint.
  useEffect(() => {
    fetchRegion().then((r) => {
      if (!r) return;
      setZones(r.timezones);
      setCurrent(r.timezone);
      // Move focus into the list once the (async) zones arrive. Without this a
      // picker step could show nothing focused if the parent focused it before
      // the data loaded.
      if (autoFocus) {
        const first = group(r.timezones).regions[0];
        if (first) setTimeout(() => setFocus("tz-region-" + first), 0);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { regions, byRegion } = useMemo(() => group(zones), [zones]);
  // `active` reflects the pick immediately, even on a box whose image predates
  // the polkit grant (the POST is refused there) - so the choice is never silent.
  const active = picked ?? current;
  const currentRegion = active.includes("/") ? active.slice(0, active.indexOf("/")) : active;

  const toRegions = () => {
    const from = selected;
    setSelected(null);
    setTimeout(() => setFocus(from ? "tz-region-" + from : "tz-region-" + regions[0]), 0);
  };
  useBackspace(toRegions, selected !== null);

  const openRegion = (region: string) => {
    setSelected(region);
    setSaved(false);
    const first = byRegion.get(region)?.[0];
    setTimeout(() => setFocus(first ? "tz-city-" + first.tz : "tz-city-back"), 0);
  };

  const pickCity = async (c: City) => {
    if (pending) return; // one POST at a time; ignore taps while it lands
    setSaved(false);
    setPicked(c.tz); // reflect the choice immediately, even if the POST is refused
    setPending(c.tz); // show a spinner on the tapped row so a slow POST isn't silent
    const ok = await setTimezone(c.tz);
    setPending(null);
    if (ok) {
      setCurrent(c.tz);
      setDeferred(false);
      onChange?.(c.tz);
      setSaved(true);
    } else {
      setDeferred(true); // still selected, just applies after the next box update
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-[1.2vw] mb-[1.4vh]">
        <span className="text-[2vh] text-fg-dim">{t("region.current")}</span>
        <span className="text-[2.2vh] font-semibold tabular-nums">{active || "-"}</span>
        {saved && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-[2.4vh] h-[2.4vh] text-[#39c0d6]"
            aria-hidden
          >
            <path d="M5 12.5l4.5 4.5L19 7" />
          </svg>
        )}
      </div>
      {deferred && <div className="text-[1.9vh] text-[#e0b64a] mb-[1vh]">{t("region.tzLater")}</div>}

      {selected === null ? (
        <>
          <div className="text-[1.9vh] text-fg-dim mb-[0.8vh]">{t("region.region")}</div>
          <div className="flex flex-col gap-[0.8vh] flex-1 min-h-0 overflow-y-auto no-scrollbar max-w-[64vw]">
            {regions.map((r) => (
              <FocusButton
                key={r}
                focusKey={"tz-region-" + r}
                onEnter={() => openRegion(r)}
                className="px-[2vw] py-[1.4vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
              >
                <span className="text-[2.1vh]">{r}</span>
                <span className="flex items-center gap-[1.2vw] shrink-0 text-[1.7vh] text-fg-dim">
                  {r === currentRegion && <span className="text-[#39c0d6]">●</span>}
                  {byRegion.get(r)?.length}
                </span>
              </FocusButton>
            ))}
            {!regions.length && <div className="text-[1.9vh] text-fg-dim">-</div>}
          </div>
        </>
      ) : (
        <>
          <div className="text-[1.9vh] text-fg-dim mb-[0.8vh]">
            {selected} · {t("region.city")}
          </div>
          <div className="flex flex-col gap-[0.8vh] flex-1 min-h-0 overflow-y-auto no-scrollbar max-w-[64vw]">
            <FocusButton
              focusKey="tz-city-back"
              onEnter={toRegions}
              className="px-[2vw] py-[1.4vh] rounded-[1.1vh] bg-white/10 text-[2vh] font-semibold flex items-center gap-[1vw]"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-[2.2vh] h-[2.2vh]"
              >
                <path d="M15 6l-6 6 6 6" />
              </svg>
              {t("region.back")}
            </FocusButton>
            {(byRegion.get(selected) ?? []).map((c) => (
              <FocusButton
                key={c.tz}
                focusKey={"tz-city-" + c.tz}
                onEnter={() => pickCity(c)}
                className="px-[2vw] py-[1.4vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
              >
                <span className="text-[2.1vh]">{c.label}</span>
                {pending === c.tz ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    className="w-[2.2vh] h-[2.2vh] shrink-0 animate-spin text-[#39c0d6]"
                    aria-hidden
                  >
                    <path d="M12 3a9 9 0 1 0 9 9" />
                  </svg>
                ) : (
                  c.tz === active && <span className="text-[1.7vh] text-[#39c0d6] shrink-0">●</span>
                )}
              </FocusButton>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
