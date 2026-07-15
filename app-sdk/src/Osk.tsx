import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useBackspace } from "./useBackspace";
import { FocusButton } from "./FocusButton";

// Shared on-screen keyboard (D-pad). Edits one string and calls onDone with the
// result (or onCancel on remote Back). QWERTY-ish with a digits row and a row of
// URL symbols so IPTV URLs/credentials are easy; Shift toggles case. A movable
// caret (◀ ▶) lets you insert/delete mid-string instead of only at the end.
const ROWS_LOWER = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm", "@.:/-_?&=%"];
const ROWS_UPPER = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM", "@.:/-_?&=%"];

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
}: {
  title: string;
  initial?: string;
  onDone: (value: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial || "");
  const [cursor, setCursor] = useState((initial || "").length); // caret index into text
  const [upper, setUpper] = useState(false);
  const { ref, focusKey } = useFocusable({ focusKey: "osk", isFocusBoundary: true });

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

  const rows = upper ? ROWS_UPPER : ROWS_LOWER;

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
              {row.split("").map((ch, c) => (
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
