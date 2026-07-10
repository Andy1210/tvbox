import { useState } from "react";
import { PinPad } from "./PinPad";
import { verifyPin } from "./config";
import { useI18n } from "./i18n";

// Reusable parental-PIN gate over the box's ONE central PIN (set in HOME
// Settings, stored salted+hashed in the shell, verified server-side). Apps
// gate any action with <PinGate onSuccess onCancel /> instead of re-wiring
// PinPad + verifyPin + error state themselves - so every app shares the PIN
// the user set once. Strings default to the `parental.enterPin` /
// `parental.wrongPin` i18n keys (pass title/wrongText to override).
export function PinGate({
  title,
  wrongText,
  onSuccess,
  onCancel,
}: {
  title?: string;
  wrongText?: string;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | undefined>();
  return (
    <PinPad
      title={title || t("parental.enterPin")}
      error={error}
      onCancel={onCancel}
      onSubmit={async (pin) => {
        if (await verifyPin(pin)) onSuccess();
        else setError(wrongText || t("parental.wrongPin"));
      }}
    />
  );
}
