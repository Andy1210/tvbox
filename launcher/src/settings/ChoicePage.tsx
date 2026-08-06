import { useI18n } from "../lib/i18n";
import { SettingsPage } from "./SettingsPage";
import { Group, Note, Row } from "./Rows";
import { useSettingsNav } from "./nav";

// Pick one of a list. Five settings are this shape (the Wi-Fi country, the audio
// and subtitle track languages, the keyboard layout, the time zone) and each used
// to be its own full-screen overlay with its own focus handling.
//
// As a page rather than an overlay it inherits the two things those overlays each
// solved separately: Back returns to the row that opened it with focus intact, and
// the current value is what opens focused - so pressing OK twice is a no-op instead
// of a change. A stored value that is not in the list (a hand-edited config) simply
// focuses the first row, because SettingsPage falls back rather than trying to focus
// a key that does not exist - which is what used to strand spatial nav in a state
// where neither arrows nor Enter did anything.
export interface Choice {
  id: string;
  label: string;
  hint?: string;
}

export function ChoicePage({
  id,
  title,
  subtitle,
  note,
  options,
  value,
  onPick,
}: {
  id: string;
  title: string;
  subtitle?: string;
  note?: string;
  options: Choice[];
  value: string;
  onPick: (id: string) => void;
}) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  return (
    <SettingsPage id={id} title={title} subtitle={subtitle} onBack={nav.pop} animate="push">
      {note && <Note>{note}</Note>}
      <Group>
        {options.map((o) => (
          <Row
            key={o.id}
            id={"opt-" + (o.id || "auto")}
            label={o.label}
            hint={o.hint}
            value={o.id === value ? t("common.selected") : undefined}
            trailing="none"
            autoFocus={o.id === value}
            onEnter={() => {
              onPick(o.id);
              nav.pop();
            }}
          />
        ))}
      </Group>
    </SettingsPage>
  );
}
