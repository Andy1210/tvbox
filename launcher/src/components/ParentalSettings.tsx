import { useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useConfigStore } from "../stores/config";
import { FocusButton } from "./FocusButton";
import { PinPad } from "@sdk/PinPad";
import { PinGate } from "@sdk/PinGate";

// Parental-lock section of the HOME Settings screen. The box has ONE central
// PIN (stored salted+hashed by the shell); every app checks it through the
// sdk's verifyPin/PinGate, so setting it here covers Live TV's locked
// categories and any future app. This panel only manages the PIN itself -
// what gets locked (e.g. channel categories) lives in each app's settings.
type Step = null | "verify-change" | "verify-clear" | "new" | "confirm";

export function ParentalSettings() {
  const { t } = useI18n();
  const pinSet = useConfigStore((s) => !!s.config?.parental.pinSet);
  const requirePin = useConfigStore((s) => !!s.config?.parental.requirePin);
  const saveParental = useConfigStore((s) => s.setParental);
  const [step, setStep] = useState<Step>(null);
  const [firstPin, setFirstPin] = useState("");
  const [confirmError, setConfirmError] = useState<string | undefined>();
  const [msg, setMsg] = useState("");

  const done = (message: string, focus: string) => {
    setStep(null);
    setFirstPin("");
    setConfirmError(undefined);
    setMsg(message);
    setTimeout(() => setFocus(focus), 0);
  };
  const cancel = () => done("", pinSet ? "parental-change" : "parental-set");

  if (step === "verify-change") {
    return <PinGate onSuccess={() => setStep("new")} onCancel={cancel} />;
  }
  if (step === "verify-clear") {
    return (
      <PinGate
        onSuccess={async () => {
          await saveParental({ pin: "" });
          done(t("parental.cleared"), "parental-set");
        }}
        onCancel={cancel}
      />
    );
  }
  if (step === "new") {
    return (
      <PinPad
        title={t("parental.newPin")}
        onCancel={cancel}
        onSubmit={(pin) => {
          setFirstPin(pin);
          setConfirmError(undefined);
          setStep("confirm");
        }}
      />
    );
  }
  if (step === "confirm") {
    return (
      <PinPad
        title={t("parental.confirmPin")}
        error={confirmError}
        onCancel={cancel}
        onSubmit={async (pin) => {
          if (pin !== firstPin) {
            setConfirmError(t("parental.mismatch"));
            return;
          }
          await saveParental({ pin });
          done(t("parental.saved"), "parental-change");
        }}
      />
    );
  }

  return (
    <div className="mt-[3vh]">
      <div className="flex items-center gap-[1.5vw] mb-[1.4vh]">
        <div className="text-[2.4vh] font-semibold">{t("parental.title")}</div>
        {msg && <span className="text-[1.9vh] text-fg-dim">{msg}</span>}
      </div>
      <div className="flex flex-col gap-[1vh] max-w-[70vw]">
        {!pinSet ? (
          <FocusButton
            focusKey="parental-set"
            onEnter={() => setStep("new")}
            className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
          >
            <span className="min-w-0">
              <span className="text-[2.1vh]">{t("parental.set")}</span>
              <span className="block text-[1.7vh] text-fg-dim">{t("parental.hint")}</span>
            </span>
          </FocusButton>
        ) : (
          <>
            <FocusButton
              focusKey="parental-change"
              onEnter={() => setStep("verify-change")}
              className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
            >
              <span className="text-[2.1vh]">{t("parental.change")}</span>
            </FocusButton>
            <FocusButton
              focusKey="parental-require"
              onEnter={() => saveParental({ requirePin: !requirePin })}
              className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
            >
              <span className="min-w-0">
                <span className="text-[2.1vh]">{t("parental.require")}</span>
                <span className="block text-[1.7vh] text-fg-dim">{t("parental.requireHint")}</span>
              </span>
              <span
                className={["text-[1.9vh] font-semibold shrink-0", requirePin ? "text-accent" : "text-fg-dim"].join(
                  " ",
                )}
              >
                {requirePin ? t("display.on") : t("display.off")}
              </span>
            </FocusButton>
            <FocusButton
              focusKey="parental-clear"
              onEnter={() => setStep("verify-clear")}
              className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
            >
              <span className="text-[2.1vh]">{t("parental.clear")}</span>
            </FocusButton>
          </>
        )}
      </div>
    </div>
  );
}
