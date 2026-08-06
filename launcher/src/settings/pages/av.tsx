import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchDisplayStatus, refreshDisplayMode, type DisplayModeInfo, type DisplayStatus } from "../../lib/display";
import { fetchSinks, setDefaultSink, setSinkVolume, type AudioState } from "../../lib/audio";
import { useConfigStore } from "../../stores/config";
import { SettingsPage } from "../SettingsPage";
import { ChoicePage } from "../ChoicePage";
import { Group, InfoRow, Note, Row, StepperRow, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";
import { useSummary, invalidateSummary } from "../summary";

// Settings -> Picture & sound. Three pages: what the output is doing, where the
// sound goes, and which track languages a film should prefer. The last of those
// used to sit at the bottom of the audio column, which is where nobody looked for
// it - it is a playback preference, not an output setting.
const VOL_STEP = 5; // percent per press

const hz = (r: number) => (Math.abs(r - Math.round(r)) < 0.01 ? String(Math.round(r)) : r.toFixed(3));
const modeLabel = (m: DisplayModeInfo) => `${m.width} × ${m.height} · ${hz(m.refresh)} Hz`;

// Offered for mpv --alang/--slang; "" = the stream's own default. Names come from
// the platform in the UI language, so adding a code costs no translation.
const TRACK_LANGS = [
  "",
  "hu",
  "en",
  "de",
  "fr",
  "it",
  "es",
  "pt",
  "pl",
  "cs",
  "sk",
  "ro",
  "hr",
  "sr",
  "ru",
  "uk",
  "tr",
];

function langName(tag: string, code: string, autoLabel: string): string {
  if (!code) return autoLabel;
  try {
    return new Intl.DisplayNames([tag], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

function DisplayPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [st, setSt] = useState<DisplayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const alive = useRef(true);

  const load = useCallback(() => {
    invalidateSummary("display");
    void fetchDisplayStatus().then((d) => d && alive.current && setSt(d));
  }, []);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  return (
    <SettingsPage id="display" title={t("display.title")} onBack={nav.pop} animate="push">
      {msg && <Note tone="warn">{msg}</Note>}
      {/* There is deliberately no mode picker: the UI runs at up to 1080p and video
          claims the mode its content needs, then releases it. A stored mode and a
          live claim fight each other on every hotplug. */}
      <Note>{t("display.autoHint")}</Note>
      <Group>
        <InfoRow
          label={t("display.resolution")}
          value={st?.current ? modeLabel(st.current) : st ? t("display.none") : "-"}
        />
        <Row
          id="redetect"
          label={t("display.redetect")}
          hint={t("display.redetectHint")}
          value={busy ? t("display.applying") : undefined}
          trailing="none"
          autoFocus
          onEnter={async () => {
            if (busy) return;
            setBusy(true);
            setMsg("");
            const r = await refreshDisplayMode();
            if (!alive.current) return;
            setBusy(false);
            if (!r.ok) setMsg(t("display.failed"));
            load();
          }}
        />
      </Group>
    </SettingsPage>
  );
}

// The sink list is a snapshot for display (see PushedPage) - picking one pops this
// page, and the sound page reloads as it remounts.
function OutputPage({ state }: { state: AudioState }) {
  const { t } = useI18n();
  return (
    <ChoicePage
      id="audio-out"
      title={t("audio.output")}
      options={[
        { id: "", label: t("audio.auto"), hint: t("audio.autoHint") },
        ...state.sinks.map((s) => ({
          id: s.name,
          label: s.description || s.name,
          hint: s.isDefault ? t("audio.default") : undefined,
        })),
      ]}
      value={state.override || ""}
      onPick={(sink) => {
        invalidateSummary("audio");
        void setDefaultSink(sink);
      }}
    />
  );
}

function SoundPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [state, setState] = useState<AudioState | null>(null);
  const navSounds = useConfigStore((s) => s.config?.ui.navSounds ?? true);
  const setUi = useConfigStore((s) => s.setUi);

  const alive = useRef(true);
  const load = useCallback(() => {
    invalidateSummary("audio");
    void fetchSinks().then((s) => s && alive.current && setState(s));
  }, []);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const def = state?.sinks.find((s) => s.isDefault) || null;
  const bump = async (steps: number) => {
    if (!def || def.volume == null) return;
    const v = Math.max(0, Math.min(1, def.volume + (steps * VOL_STEP) / 100));
    // Optimistic: the row has to answer the press, not the round trip to wpctl.
    setState((s) => s && { ...s, sinks: s.sinks.map((x) => (x.id === def.id ? { ...x, volume: v } : x)) });
    await setSinkVolume(def.id, v);
  };

  const outName = !state
    ? undefined
    : state.override
      ? state.sinks.find((s) => s.name === state.override)?.description || state.override
      : t("audio.auto");

  return (
    <SettingsPage id="sound" title={t("audio.title")} onBack={nav.pop} animate="push">
      <Group>
        <Row
          id="output"
          label={t("audio.output")}
          hint={t("audio.outputHint")}
          value={outName}
          autoFocus
          onEnter={() =>
            state && nav.push({ id: "audio-out", title: t("audio.output"), render: () => <OutputPage state={state} /> })
          }
        />
        {def && def.volume != null && (
          <StepperRow
            id="volume"
            label={t("audio.volume")}
            display={def.muted ? t("audio.muted") : Math.round(def.volume * 100) + "%"}
            onStep={(d) => void bump(d)}
          />
        )}
        {!state?.sinks.length && <InfoRow label={t("audio.none")} value="" />}
      </Group>
      <Group>
        <ToggleRow
          id="nav-sounds"
          label={t("audio.navSounds")}
          on={navSounds}
          onToggle={() => void setUi({ navSounds: !navSounds })}
          onWord={t("common.on")}
          offWord={t("common.off")}
        />
      </Group>
    </SettingsPage>
  );
}

function LanguagesPage() {
  const { t, tag } = useI18n();
  const nav = useSettingsNav();
  const audioLang = useConfigStore((s) => s.config?.player.audioLang) || "";
  const subLang = useConfigStore((s) => s.config?.player.subLang) || "";
  const setPlayer = useConfigStore((s) => s.setPlayer);

  const options = TRACK_LANGS.map((code) => ({ id: code, label: langName(tag, code, t("audio.langAuto")) }));
  const pushPicker = (which: "audio" | "sub") =>
    nav.push({
      id: "track-" + which,
      title: t(which === "audio" ? "audio.trackLang" : "audio.subLang"),
      render: () => (
        <ChoicePage
          id={"track-" + which}
          title={t(which === "audio" ? "audio.trackLang" : "audio.subLang")}
          subtitle={t(which === "audio" ? "audio.trackLangHint" : "audio.subLangHint")}
          options={options}
          value={which === "audio" ? audioLang : subLang}
          onPick={(code) => void setPlayer(which === "audio" ? { audioLang: code } : { subLang: code })}
        />
      ),
    });

  return (
    <SettingsPage
      id="tracks"
      title={t("audio.tracksTitle")}
      subtitle={t("audio.tracksHint")}
      onBack={nav.pop}
      animate="push"
    >
      <Group>
        <Row
          id="audio"
          label={t("audio.trackLang")}
          hint={t("audio.trackLangHint")}
          value={langName(tag, audioLang, t("audio.langAuto"))}
          autoFocus
          onEnter={() => pushPicker("audio")}
        />
        <Row
          id="sub"
          label={t("audio.subLang")}
          hint={t("audio.subLangHint")}
          value={langName(tag, subLang, t("audio.langAuto"))}
          onEnter={() => pushPicker("sub")}
        />
      </Group>
    </SettingsPage>
  );
}

export function AvPane() {
  const { t, tag } = useI18n();
  const nav = useSettingsNav();
  const display = useSummary("display", fetchDisplayStatus);
  const audio = useSummary("audio", fetchSinks);
  const audioLang = useConfigStore((s) => s.config?.player.audioLang) || "";

  const outName = !audio
    ? undefined
    : audio.override
      ? audio.sinks.find((s) => s.name === audio.override)?.description || audio.override
      : t("audio.auto");

  return (
    <SettingsPage id="av" focusPolicy="rail">
      <Group>
        <Row
          id="display"
          label={t("display.title")}
          hint={t("av.displayHint")}
          value={display?.current ? modeLabel(display.current) : undefined}
          onEnter={() => nav.push({ id: "display", title: t("display.title"), render: () => <DisplayPage /> })}
        />
        <Row
          id="sound"
          label={t("audio.title")}
          hint={t("av.soundHint")}
          value={outName}
          onEnter={() => nav.push({ id: "sound", title: t("audio.title"), render: () => <SoundPage /> })}
        />
        <Row
          id="tracks"
          label={t("audio.tracksTitle")}
          hint={t("audio.tracksHint")}
          value={langName(tag, audioLang, t("audio.langAuto"))}
          onEnter={() => nav.push({ id: "tracks", title: t("audio.tracksTitle"), render: () => <LanguagesPage /> })}
        />
      </Group>
    </SettingsPage>
  );
}
