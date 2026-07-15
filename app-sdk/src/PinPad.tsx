import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useBackspace } from "./useBackspace";
import { KeyGlyph } from "./Osk";
import { FocusButton } from "./FocusButton";

// D-pad numeric PIN entry (modal). Auto-submits at 4 digits. Remote Back cancels.
// Used both to set a PIN and to unlock a locked category.
export function PinPad({
  title,
  onSubmit,
  onCancel,
  error,
}: {
  title: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
  error?: string;
}) {
  const [pin, setPin] = useState("");
  const { ref, focusKey } = useFocusable({ focusKey: "pinpad" });

  useEffect(() => {
    const id = setTimeout(() => setFocus("pin-1"), 0);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (pin.length === 4) {
      const p = pin;
      setPin("");
      onSubmit(p);
    }
  }, [pin, onSubmit]);

  useBackspace(onCancel);

  const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center gap-[3vh]">
        <div className="text-[3vh] font-bold">{title}</div>
        <div className="flex gap-[1.5vw]">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={[
                "w-[3vh] h-[3vh] rounded-full border-[0.3vh]",
                i < pin.length ? "bg-white border-white" : "border-white/40",
              ].join(" ")}
            />
          ))}
        </div>
        {error && <div className="text-[2vh] text-red-400">{error}</div>}
        <div className="grid grid-cols-3 gap-[1.2vw]">
          {digits.map((d) => (
            <FocusButton
              key={d}
              focusKey={"pin-" + d}
              onEnter={() => setPin((p) => (p.length < 4 ? p + d : p))}
              className="w-[9vw] max-w-[120px] aspect-square rounded-full bg-white/5 flex items-center justify-center text-[3.5vh] font-semibold"
            >
              {d}
            </FocusButton>
          ))}
          <FocusButton
            focusKey="pin-del"
            label="delete"
            onEnter={() => setPin((p) => p.slice(0, -1))}
            className="w-[9vw] max-w-[120px] aspect-square rounded-full bg-white/5 flex items-center justify-center text-[3vh]"
          >
            <KeyGlyph name="backspace" className="w-[3vh] h-[3vh]" />
          </FocusButton>
          <FocusButton
            focusKey="pin-0"
            onEnter={() => setPin((p) => (p.length < 4 ? p + "0" : p))}
            className="w-[9vw] max-w-[120px] aspect-square rounded-full bg-white/5 flex items-center justify-center text-[3.5vh] font-semibold"
          >
            0
          </FocusButton>
          <div />
        </div>
      </div>
    </FocusContext.Provider>
  );
}
