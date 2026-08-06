import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { useConfigStore } from "../../stores/config";
import { fetchPhotos, clearPhotos, deletePhoto, photoUrl } from "../../lib/ambient";
import { AmbientPhotos } from "../../components/AmbientPhotos";
import { useFocusableItem } from "../../lib/useFocusableItem";
import { SettingsPage } from "../SettingsPage";
import { ChoicePage } from "../ChoicePage";
import { Group, Note, Row, StepperRow, TextRow, ToggleRow, usePageId } from "../Rows";
import { useSettingsNav } from "../nav";

// Settings -> Screen saver. What shows when the box is idle, and when it turns the
// TV off afterwards.
//
// Minutes before the screensaver turns the TV off over CEC. 0 = never. A fixed
// list, because the useful answers are coarse and a stepper over 120 minutes is a
// lot of presses.
const SLEEP_STEPS = [0, 15, 30, 60, 120];

function PhotoTile({ name, onDelete }: { name: string; onDelete: () => void }) {
  // Page-scoped like every other focusable here: the page's focus watchdog decides
  // whether the focus is still on one of ITS rows by the key's prefix, and an
  // unscoped key reads as somebody else's.
  const key = usePageId() + ":photo-" + name;
  const { ref, focused } = useFocusableItem({ focusKey: key, onEnterPress: onDelete }, { block: "nearest" });
  return (
    <div
      ref={ref}
      data-sfocus={key}
      onClick={onDelete}
      className={[
        "relative w-[15vw] h-[14vh] rounded-[1.2vh] overflow-hidden bg-black/40",
        // An outline, not a scale: the tile holds a photo, and re-rasterising an
        // image at every D-pad move is the most expensive thing this screen could do.
        focused ? "outline outline-[0.4vh] outline-offset-[0.3vh] outline-[var(--color-focus)]" : "",
      ].join(" ")}
    >
      <img src={photoUrl(name)} alt="" className="absolute inset-0 w-full h-full object-cover" />
      <span className="absolute top-[0.8vh] right-[0.6vw] w-[3.4vh] h-[3.4vh] rounded-full bg-black/70 flex items-center justify-center">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-[2.1vh] h-[2.1vh]"
          aria-hidden="true"
        >
          <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
        </svg>
      </span>
    </div>
  );
}

function WallpapersPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  // Only the user's own uploads: cached Bing wallpapers come back as "bing/<file>",
  // are not deletable through the photo API and prune themselves shell-side.
  const alive = useRef(true);
  const refresh = useCallback(
    () => fetchPhotos().then((list) => alive.current && setPhotos(list.filter((n) => !n.startsWith("bing/")))),
    [],
  );
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  if (uploading)
    return (
      <AmbientPhotos
        onClose={() => {
          setUploading(false);
          void refresh();
        }}
      />
    );

  return (
    <SettingsPage id="wallpapers" title={t("ambient.photosUpload")} onBack={nav.pop} animate="push">
      <Group>
        <Row
          id="upload"
          label={t("ambient.photosUpload")}
          hint={t("ambient.photosHint")}
          value={t("ambient.photosCount", { n: photos.length })}
          trailing="none"
          autoFocus
          onEnter={() => setUploading(true)}
        />
        {photos.length > 0 && (
          <Row
            id="clear"
            label={t("ambient.photosClear")}
            trailing="none"
            onEnter={() => void clearPhotos().then(refresh)}
          />
        )}
      </Group>
      {photos.length > 0 && (
        <div>
          <Note>{t("ambient.photosManage")}</Note>
          <div className="flex flex-wrap gap-[1vh]">
            {photos.map((name) => (
              <PhotoTile key={name} name={name} onDelete={() => void deletePhoto(name).then(refresh)} />
            ))}
          </div>
        </div>
      )}
    </SettingsPage>
  );
}

export function AmbientPane() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const a = useConfigStore((s) => s.config?.ambient);
  const save = useConfigStore((s) => s.setAmbient);

  const enabled = a?.enabled ?? true;
  const idle = a?.idleMinutes ?? 5;
  const city = a?.city || "";
  const bing = a?.bing ?? false;
  const sleep = a?.sleepMinutes ?? 0;

  const sleepLabel = (min: number) => (min ? t("ambient.sleepAfter", { min: String(min) }) : t("ambient.sleepNever"));

  return (
    <SettingsPage id="ambient" focusPolicy="rail">
      <Group>
        <ToggleRow
          id="enabled"
          label={t("ambient.enable")}
          on={enabled}
          onToggle={() => void save({ enabled: !enabled })}
          onWord={t("common.on")}
          offWord={t("common.off")}
        />
        <StepperRow
          id="idle"
          label={t("ambient.idle")}
          display={t("ambient.minutes", { n: idle })}
          onStep={(d) => void save({ idleMinutes: Math.max(1, Math.min(60, idle + d)) })}
        />
        <Row
          id="sleep"
          label={t("ambient.sleep")}
          hint={t("ambient.sleepHint")}
          value={sleepLabel(sleep)}
          onEnter={() =>
            nav.push({
              id: "ambient-sleep",
              title: t("ambient.sleep"),
              render: () => (
                <ChoicePage
                  id="ambient-sleep"
                  title={t("ambient.sleep")}
                  subtitle={t("ambient.sleepHint")}
                  options={SLEEP_STEPS.map((m) => ({ id: String(m), label: sleepLabel(m) }))}
                  value={String(sleep)}
                  onPick={(v) => void save({ sleepMinutes: Number(v) })}
                />
              ),
            })
          }
        />
      </Group>

      <Group title={t("ambient.groupContent")}>
        <TextRow
          id="city"
          label={t("ambient.city")}
          title={t("ambient.cityPrompt")}
          value={city}
          emptyLabel={t("ambient.notSet")}
          onSubmit={(v) => void save({ city: v.trim() })}
        />
        <ToggleRow
          id="bing"
          label={t("ambient.bing")}
          hint={t("ambient.bingHint")}
          on={bing}
          // The listing call is what makes the shell start fetching the wallpapers, so
          // enabling this has to ask for them too or the first screensaver shows none.
          onToggle={() => void save({ bing: !bing }).then(() => fetchPhotos())}
          onWord={t("common.on")}
          offWord={t("common.off")}
        />
        <Row
          id="wallpapers"
          label={t("ambient.photosUpload")}
          hint={t("ambient.photosHint")}
          onEnter={() =>
            nav.push({ id: "wallpapers", title: t("ambient.photosUpload"), render: () => <WallpapersPage /> })
          }
        />
      </Group>
    </SettingsPage>
  );
}
