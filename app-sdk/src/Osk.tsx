import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useBackspace } from "./useBackspace";
import { FocusButton } from "./FocusButton";

// Shared on-screen keyboard (D-pad). Edits one string and calls onDone with the
// result (or onCancel on remote Back). QWERTY-ish with a digits row and a row of
// URL symbols so IPTV URLs/credentials are easy; Shift toggles case. A movable
// caret (◀ ▶) lets you insert/delete mid-string instead of only at the end.
//
// Two layers, because a search box needs what a URL does not: the letters keep
// the URL symbols they always had, and the second layer carries the punctuation
// there was none of (no comma existed anywhere) plus the letters a QWERTY row
// cannot produce. Shift applies to both layers - on the symbols it is the
// accent row that changes case, since nothing else there has a case.
//
// EVERY layer has the same row lengths, and that is load-bearing rather than
// tidy: a key is focused by position (`osk-<row>-<col>`), so a layer whose row
// ran short would unmount the focused key and leave the D-pad with nowhere to
// be - the one state a remote cannot get out of.
const ROWS_LOWER = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm", "@.:/-_?&=%"];
const ROWS_UPPER = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM", "@.:/-_?&=%"];
// The letters themselves follow the layout too, not only the accents: on a
// Hungarian or German keyboard the top row is QWERTZ, and an on-screen keyboard
// that spelled QWERTY while the box was set to one of those would be showing the
// wrong keyboard. Only the swap is modelled - the letters that MOVE between
// these layouts - because the rows are a fixed shape and inventing a full
// national layout inside it would be guessing.
const QWERTZ = ["1234567890", "qwertzuiop", "asdfghjkl", "yxcvbnm", "@.:/-_?&=%"];
const QWERTZ_UPPER = ["1234567890", "QWERTZUIOP", "ASDFGHJKL", "YXCVBNM", "@.:/-_?&=%"];
const LETTERS = {
  qwertz: [QWERTZ, QWERTZ_UPPER],
};
// Which layouts are QWERTZ rather than QWERTY. Left out deliberately: AZERTY
// (fr, be) moves a letter BETWEEN rows, which these fixed row shapes cannot
// express - so those keep QWERTY rather than get a half-right AZERTY.
const LETTER_STYLE: Record<string, keyof typeof LETTERS> = {
  hu: "qwertz",
  de: "qwertz",
  sk: "qwertz",
  hr: "qwertz",
  cz: "qwertz",
  sl: "qwertz",
  ch: "qwertz",
  at: "qwertz",
};
const SYM_TAIL = [";!?'\"()[]", "{}<>*+~", "€$£#|\\§°^`"];

// Which letters the symbol layer offers, by the box's KEYBOARD LAYOUT - the X11
// layout set in Settings → System → Region, the same one a plugged-in keyboard
// uses. Baking one language in would be choosing a country on behalf of everyone
// who runs this, and the setting already exists to be asked.
//
// Each entry is exactly as long as the row it replaces, for the reason above; a
// layout with fewer letters than that pads with punctuation rather than a
// shorter row. Unknown layouts get the punctuation row, which is strictly more
// than the keyboard offered before.
const PUNCT_ROW = ",;:!?'\"()*";
const ACCENT_ROWS: Record<string, [string, string]> = {
  hu: ["áéíóöőúüű,", "ÁÉÍÓÖŐÚÜŰ,"],
  de: ["äöüß,;:!?'", "ÄÖÜß,;:!?'"],
  fr: ["àâçéèêëîïô", "ÀÂÇÉÈÊËÎÏÔ"],
  es: ["áéíóúñü¿¡,", "ÁÉÍÓÚÑÜ¿¡,"],
  pl: ["ąćęłńóśźż,", "ĄĆĘŁŃÓŚŹŻ,"],
  it: ["àèéìòùç,;:", "ÀÈÉÌÒÙÇ,;:"],
  pt: ["ãáàâçéêíõ,", "ÃÁÀÂÇÉÊÍÕ,"],
  ro: ["ăâîșț,;:!?", "ĂÂÎȘȚ,;:!?"],
  sk: ["áäčďéíĺľňó", "ÁÄČĎÉÍĹĽŇÓ"],
  hr: ["čćđšž,;:!?", "ČĆĐŠŽ,;:!?"],
  tr: ["çğıöşü,;:!", "ÇĞİÖŞÜ,;:!"],
};

// The X11 layout string can carry a variant ("hu(101_qwertz_comma_dead)") or a
// list ("us,hu"); the first token before a comma or bracket is the layout.
export function layoutKey(raw?: string | null): string {
  return String(raw || "")
    .split(/[,(]/)[0]
    .trim()
    .toLowerCase();
}

export function oskLayers(layout?: string | null) {
  const key = layoutKey(layout);
  const pair = ACCENT_ROWS[key];
  const first = pair ? pair[0] : PUNCT_ROW;
  const second = pair ? pair[1] : PUNCT_ROW;
  const letters = LETTERS[LETTER_STYLE[key]] || [ROWS_LOWER, ROWS_UPPER];
  return {
    ROWS_LOWER: letters[0],
    ROWS_UPPER: letters[1],
    ROWS_SYM: ["1234567890", first, ...SYM_TAIL],
    ROWS_SYM_UPPER: ["1234567890", second, ...SYM_TAIL],
  };
}

// Every layout this ships with, for the test that pins their shapes together:
// they are hand-written constants and the focus keys are positional, so "these
// all agree" is a real invariant with no other way to check it.
export const OSK_LAYOUTS = Object.keys(ACCENT_ROWS);

// Asked once per page, not once per keyboard: the shell answers this by running
// `localectl`, and a keyboard that forks a process every time it opens would be
// paying for a value that changes about once in a box's life. A failed read is
// cached as "" so a box whose shell is older does not retry on every field.
let cachedLayout: string | null = null;
let inFlight: Promise<string> | null = null;
let told = 0; // bumped whenever someone tells us the layout outright

// Told, rather than re-read. Settings changes the layout on a page that is
// already loaded, and this value is cached for the life of that page - so
// without this the keyboard would keep the layout the box had when the launcher
// started, which looks exactly like the setting having done nothing.
export function noteOskLayout(layout: string) {
  cachedLayout = layoutKey(layout);
  // A read started before this can still be in flight, and it would land on the
  // value the box had a moment ago. Bumping the generation is what makes that
  // answer arrive too late to matter.
  told++;
}
function fetchLayout(): Promise<string> {
  if (cachedLayout !== null) return Promise.resolve(cachedLayout);
  if (!inFlight) {
    const started = told;
    inFlight = fetch("/tvbox/api/system/region", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (started === told ? (cachedLayout = layoutKey(d && d.keymap)) : cachedLayout || ""))
      .catch(() => (started === told ? (cachedLayout = "") : cachedLayout || ""))
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

function Key({
  focusKey,
  onEnter,
  wide,
  children,
}: {
  focusKey: string;
  onEnter: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <FocusButton
      focusKey={focusKey}
      onEnter={onEnter}
      className={[
        "h-[7vh] rounded-[1vh] bg-white/5 flex items-center justify-center text-[2.6vh] font-medium",
        wide ? "px-[6vw]" : "w-[5.2vw] max-w-[64px]",
      ].join(" ")}
    >
      {children}
    </FocusButton>
  );
}

// Inline-SVG key glyphs (shift/arrows/space/backspace/done): the box's Chromium
// has no guarantee of font coverage for symbol codepoints (same reason the
// launcher bans emoji), so draw them like every other launcher icon.
const G = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
export function KeyGlyph({
  name,
  className,
}: {
  name: "shift" | "left" | "right" | "space" | "backspace" | "done";
  className?: string;
}) {
  const cls = className || "w-[2.6vh] h-[2.6vh]";
  if (name === "shift")
    return (
      <svg viewBox="0 0 24 24" {...G} className={cls}>
        <path d="M12 4l7 8h-4v7h-6v-7H5z" />
      </svg>
    );
  if (name === "left")
    return (
      <svg viewBox="0 0 24 24" {...G} className={cls}>
        <path d="M14 6l-6 6 6 6" />
      </svg>
    );
  if (name === "right")
    return (
      <svg viewBox="0 0 24 24" {...G} className={cls}>
        <path d="M10 6l6 6-6 6" />
      </svg>
    );
  if (name === "space")
    return (
      <svg viewBox="0 0 24 24" {...G} className={cls}>
        <path d="M5 13v3h14v-3" />
      </svg>
    );
  if (name === "backspace")
    return (
      <svg viewBox="0 0 24 24" {...G} className={cls}>
        <path d="M8.5 5h11a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-11L3 12z" />
        <path d="M12 9.5l5 5M17 9.5l-5 5" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" {...G} className={cls}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function Osk({
  title,
  initial,
  onDone,
  onCancel,
  extra,
  layout,
}: {
  title: string;
  initial?: string;
  onDone: (value: string) => void;
  onCancel: () => void;
  // An optional extra action in the key row (e.g. "type on your phone"). It lives
  // INSIDE the keyboard because the OSK is a focus boundary - a button outside it
  // could never be reached with the arrows.
  extra?: { label: string; onPress: () => void };
  // The box's keyboard layout, if the caller already knows it. Left out, the
  // keyboard asks the shell once and caches the answer for the session.
  layout?: string;
}) {
  const [text, setText] = useState(initial || "");
  const [cursor, setCursor] = useState((initial || "").length); // caret index into text
  const [upper, setUpper] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const [detected, setDetected] = useState<string | null>(cachedLayout);
  const { ref, focusKey } = useFocusable({ focusKey: "osk", isFocusBoundary: true });

  // Which letters the symbol layer shows follows Settings → System → Region, so
  // it is never asked before the keyboard is on screen and never asked twice.
  useEffect(() => {
    if (layout !== undefined || detected !== null) return;
    let alive = true;
    void fetchLayout().then((l) => alive && setDetected(l));
    return () => {
      alive = false;
    };
  }, [layout, detected]);

  useEffect(() => {
    const id = setTimeout(() => setFocus("osk-1-0"), 0);
    return () => clearTimeout(id);
  }, []);
  useBackspace(onCancel);

  const insert = (ch: string) => {
    setText((t) => t.slice(0, cursor) + ch + t.slice(cursor));
    setCursor((c) => c + ch.length);
  };
  const backspace = () => {
    if (cursor > 0) {
      setText((t) => t.slice(0, cursor - 1) + t.slice(cursor));
      setCursor((c) => c - 1);
    }
  };
  const left = () => setCursor((c) => Math.max(0, c - 1));
  const right = () => setCursor((c) => Math.min(text.length, c + 1));

  const L = oskLayers(layout !== undefined ? layout : detected);
  // Two toggles that mean different things: `symbols` picks the LAYER, `upper`
  // picks the case within it. Named rather than nested, so the two do not read
  // as one condition.
  const layer = symbols ? { plain: L.ROWS_SYM, caps: L.ROWS_SYM_UPPER } : { plain: L.ROWS_LOWER, caps: L.ROWS_UPPER };
  const rows = upper ? layer.caps : layer.plain;

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center gap-[2.5vh] px-[4vw]"
      >
        <div className="text-[2.4vh] font-semibold text-fg-dim">{title}</div>
        <div className="min-w-[60vw] max-w-[80vw] px-[2vw] py-[1.6vh] rounded-[1vh] bg-white/5 text-[3vh] min-h-[6vh] flex items-center break-all">
          {text.slice(0, cursor)}
          <span className="inline-block w-[0.2vw] h-[3vh] bg-white/70 align-middle animate-pulse" />
          {text.slice(cursor)}
        </div>
        <div className="flex flex-col gap-[1vh] items-center">
          {rows.map((row, r) => (
            <div key={r} className="flex gap-[1vw]">
              {/* The string ITERATOR, not split(""): split cuts UTF-16 code
                  units, so a character outside the basic plane would become two
                  broken halves - two keys where the shape check counted one,
                  which is exactly the off-by-one the positional focus keys
                  cannot survive. Nothing here needs it today; agreeing with the
                  test's measure is what keeps that true. */}
              {[...row].map((ch, c) => (
                <Key key={ch} focusKey={`osk-${r}-${c}`} onEnter={() => insert(ch)}>
                  {ch}
                </Key>
              ))}
            </div>
          ))}
          <div className="flex gap-[1vw] mt-[0.5vh]">
            <Key focusKey="osk-shift" onEnter={() => setUpper((u) => !u)}>
              <KeyGlyph name="shift" />
            </Key>
            {/* Text rather than a glyph: these are ASCII, which the box's
                Chromium is certain to have - the reason every other key face
                here is drawn. The label says where the key GOES, the way a
                phone's does, so it reads as one switch and not two states. */}
            <Key focusKey="osk-layer" onEnter={() => setSymbols((s) => !s)}>
              <span className="text-[1.9vh] font-semibold tracking-tight">{symbols ? "abc" : "#+="}</span>
            </Key>
            <Key focusKey="osk-left" onEnter={left}>
              <KeyGlyph name="left" />
            </Key>
            <Key focusKey="osk-right" onEnter={right}>
              <KeyGlyph name="right" />
            </Key>
            <Key focusKey="osk-space" wide onEnter={() => insert(" ")}>
              <KeyGlyph name="space" />
            </Key>
            <Key focusKey="osk-del" onEnter={backspace}>
              <KeyGlyph name="backspace" />
            </Key>
            {extra && (
              <FocusButton
                focusKey="osk-extra"
                onEnter={extra.onPress}
                className="h-[7vh] px-[2vw] rounded-[1vh] bg-white/10 flex items-center justify-center text-[2vh] font-semibold"
              >
                {extra.label}
              </FocusButton>
            )}
            <FocusButton
              focusKey="osk-done"
              onEnter={() => onDone(text)}
              className="h-[7vh] px-[3vw] rounded-[1vh] bg-white/10 flex items-center justify-center text-[2.6vh] font-semibold"
            >
              <KeyGlyph name="done" />
            </FocusButton>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
