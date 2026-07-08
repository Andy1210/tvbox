import { useEffect, useState, type ReactNode } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { AVAILABLE_LOCALES, useI18n } from "../lib/i18n";
import { useBackspace } from "../lib/useBackspace";
import { FocusButton } from "./FocusButton";
import { LanguagePicker } from "./LanguagePicker";
import { WifiSettings } from "./WifiSettings";
import { TimezonePicker } from "./TimezonePicker";
import { KeymapPicker } from "./KeymapPicker";

// First-boot setup wizard: Language -> WiFi -> Timezone -> Keyboard -> All set.
// Replaces the old single language screen (App gates on it until setup is
// marked done). CRITICAL: every step is skippable, so a step that fails to load
// (no shell, empty list) can never strand first boot - there is always a
// focusable Next/Skip/Finish, and the picker steps focus Next first, then move
// focus into the list once their data arrives.
const SETUP_DONE_KEY = "tvbox.setup.done";
export function markSetupDone(): void {
  try {
    localStorage.setItem(SETUP_DONE_KEY, "1");
  } catch {
    /* private mode / no storage - the wizard just reappears next boot */
  }
}

type StepId = "language" | "wifi" | "timezone" | "keyboard" | "finish";
const STEPS: StepId[] = ["language", "wifi", "timezone", "keyboard", "finish"];

const check = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-full h-full"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </svg>
);

// The primary footer button keeps ONE stable focusKey across every step. It
// used to swap between "wizard-next"/"wizard-finish", but norigin does not
// handle a focusKey that mutates on a mounted element - the previously focused
// key went stale, which is why the Finish button could not be selected and
// Enter did nothing. A stable key also means focus naturally carries onto it
// when the label flips to "Finish".
const PRIMARY = "wizard-primary";

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  // isFocusBoundary keeps D-pad focus inside the wizard (nothing behind it is
  // focusable, but this also guards against focus escaping to a stray element).
  const { ref, focusKey } = useFocusable({ focusKey: "wizard", isFocusBoundary: true });
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const isFinish = step === "finish";

  const complete = () => {
    markSetupDone();
    onDone();
  };
  const advance = () => {
    if (i < STEPS.length - 1) setI(i + 1);
    else complete(); // last step: Finish -> markSetupDone() + onDone() -> HOME
  };
  const back = () => {
    if (i > 0) setI(i - 1);
  };
  // Back steps back a wizard step; the Timezone city list swallows Back itself
  // (returns to its region list) while open. Disabled on the first step so
  // first boot can't be escaped.
  useBackspace(back, i > 0);

  // Auto-focus a sensible, guaranteed-present element on every step entry.
  // Language/WiFi have a synchronous first control; the picker steps and the
  // finish step focus the primary footer button first - so the step is always
  // navigable even if async content is empty or still loading (#4c). The picker
  // then pulls focus into its own list once its data arrives (autoFocus).
  useEffect(() => {
    const first = AVAILABLE_LOCALES[0]?.id;
    const target: Record<StepId, string> = {
      language: first ? "lang-" + first : PRIMARY,
      wifi: "wifi-rescan",
      timezone: PRIMARY,
      keyboard: PRIMARY,
      finish: PRIMARY,
    };
    const id = setTimeout(() => setFocus(target[step]), 0);
    return () => clearTimeout(id);
  }, [step]);

  const titles: Record<StepId, string> = {
    language: t("settings.language"),
    wifi: t("settings.wifi"),
    timezone: t("region.timezone"),
    keyboard: t("region.keyboard"),
    finish: t("region.allSet"),
  };

  let control: ReactNode;
  if (step === "language")
    control = (
      <div>
        <div className="text-[2.2vh] text-fg-dim mb-[2vh]">{t("region.welcome")}</div>
        {/* On select, jump focus to Next so the pick is obviously registered
            and the user just presses OK to continue. */}
        <LanguagePicker size="lg" onPicked={() => setTimeout(() => setFocus(PRIMARY), 0)} />
      </div>
    );
  else if (step === "wifi") control = <WifiSettings />;
  else if (step === "timezone") control = <TimezonePicker autoFocus />;
  else if (step === "keyboard") control = <KeymapPicker autoFocus />;
  else
    control = (
      <div className="h-full flex flex-col items-center justify-center text-center gap-[2vh]">
        <span className="w-[10vh] h-[10vh] text-[#39c0d6]">{check}</span>
        <div className="text-[2.4vh] text-fg-dim max-w-[52vw]">{t("region.allSetHint")}</div>
      </div>
    );

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[8vw] py-[5vh]">
        <div className="text-[1.9vh] tracking-[0.4vh] uppercase text-fg-dim">
          {t("region.title")} · {i + 1}/{STEPS.length}
        </div>
        <div className="text-[3.6vh] font-bold mt-[0.6vh] mb-[2vh]">{titles[step]}</div>

        <div className="flex-1 min-h-0">{control}</div>

        <div className="flex items-center gap-[1.5vw] pt-[2.5vh]">
          {i > 0 && (
            <FocusButton
              focusKey="wizard-back"
              onEnter={back}
              className="px-[2.6vw] py-[1.6vh] rounded-[1.2vh] bg-white/5 text-[2.2vh] font-semibold"
            >
              {t("region.back")}
            </FocusButton>
          )}
          <div className="flex-1" />
          {!isFinish && (
            <FocusButton
              focusKey="wizard-skip"
              onEnter={advance}
              className="px-[2.6vw] py-[1.6vh] rounded-[1.2vh] bg-white/5 text-[2.2vh] font-semibold text-fg-dim"
            >
              {t("region.skip")}
            </FocusButton>
          )}
          <FocusButton
            focusKey={PRIMARY}
            onEnter={advance}
            className="px-[3.2vw] py-[1.6vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-bold"
          >
            {isFinish ? t("region.finish") : t("region.next")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
