import { useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { useConfigStore } from "../stores/config";
import { fetchPhotos, clearPhotos, deletePhoto, photoUrl } from "../lib/ambient";
import { FocusButton } from "./FocusButton";
import { Osk } from "./Osk";
import { AmbientPhotos } from "./AmbientPhotos";

// Ambient/screensaver section of the HOME Settings screen: enable, idle timeout,
// and the weather city. Renders inside the parent Settings FocusContext.
export function AmbientSettings() {
  const { t } = useI18n();
  const config = useConfigStore((s) => s.config);
  const save = useConfigStore((s) => s.setAmbient);
  const [editingCity, setEditingCity] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);

  const a = config?.ambient;
  const enabled = a?.enabled ?? true;
  const idle = a?.idleMinutes ?? 5;
  const city = a?.city || "";

  const refreshPhotos = () => fetchPhotos().then(setPhotos);
  useEffect(() => {
    refreshPhotos();
  }, []);

  const setIdle = (n: number) => save({ idleMinutes: Math.max(1, Math.min(60, n)) });
  const removePhoto = (name: string) => {
    deletePhoto(name).then(refreshPhotos);
    setTimeout(() => setFocus("ambient-photos-upload"), 0);
  };

  if (uploading) {
    return (
      <AmbientPhotos
        onClose={() => {
          setUploading(false);
          refreshPhotos();
          setTimeout(() => setFocus("ambient-photos-upload"), 0);
        }}
      />
    );
  }
  if (editingCity) {
    return (
      <Osk
        title={t("ambient.cityPrompt")}
        initial={city}
        onDone={(v) => {
          setEditingCity(false);
          setTimeout(() => setFocus("ambient-city"), 0);
          save({ city: v.trim() });
        }}
        onCancel={() => {
          setEditingCity(false);
          setTimeout(() => setFocus("ambient-city"), 0);
        }}
      />
    );
  }

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[1.4vh]">{t("ambient.title")}</div>
      <div className="flex flex-col gap-[1vh] max-w-[70vw]">
        <FocusButton
          focusKey="ambient-enable"
          onEnter={() => save({ enabled: !enabled })}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="text-[2.1vh]">{t("ambient.enable")}</span>
          <span className={["text-[1.9vh] font-semibold", enabled ? "text-[#39c0d6]" : "text-fg-dim"].join(" ")}>
            {enabled ? t("display.on") : t("display.off")}
          </span>
        </FocusButton>

        <div className="flex items-center gap-[1.5vw]">
          <span className="text-[2vh] text-fg-dim flex-1">{t("ambient.idle")}</span>
          <FocusButton
            focusKey="ambient-idle-down"
            onEnter={() => setIdle(idle - 1)}
            className="w-[5.4vh] h-[5.4vh] rounded-[1vh] bg-white/5 flex items-center justify-center text-[3vh]"
          >
            −
          </FocusButton>
          <span className="text-[2.4vh] font-semibold tabular-nums w-[6vw] text-center">{idle}</span>
          <FocusButton
            focusKey="ambient-idle-up"
            onEnter={() => setIdle(idle + 1)}
            className="w-[5.4vh] h-[5.4vh] rounded-[1vh] bg-white/5 flex items-center justify-center text-[3vh]"
          >
            ＋
          </FocusButton>
        </div>

        <FocusButton
          focusKey="ambient-city"
          onEnter={() => setEditingCity(true)}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="text-[2.1vh]">{t("ambient.city")}</span>
          <span className="text-[1.9vh] text-fg-dim truncate">{city || t("ambient.notSet")}</span>
        </FocusButton>

        <div className="flex items-center gap-[1.5vw]">
          <FocusButton
            focusKey="ambient-photos-upload"
            onEnter={() => setUploading(true)}
            className="flex-1 px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
          >
            <span className="text-[2.1vh]">{t("ambient.photosUpload")}</span>
            <span className="text-[1.9vh] text-fg-dim">{t("ambient.photosCount", { n: photos.length })}</span>
          </FocusButton>
          {photos.length > 0 && (
            <FocusButton
              focusKey="ambient-photos-clear"
              onEnter={() => clearPhotos().then(refreshPhotos)}
              className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 text-[1.9vh] font-semibold shrink-0"
            >
              {t("ambient.photosClear")}
            </FocusButton>
          )}
        </div>

        {photos.length > 0 && (
          <>
            <div className="text-[1.7vh] text-fg-dim mt-[0.4vh]">{t("ambient.photosManage")}</div>
            <div className="flex flex-wrap gap-[1vh] max-h-[34vh] overflow-y-auto no-scrollbar">
              {photos.map((name, i) => (
                <FocusButton
                  key={name}
                  focusKey={"ambient-photo-" + i}
                  onEnter={() => removePhoto(name)}
                  className="relative w-[22vw] h-[15vh] rounded-[1.2vh] overflow-hidden bg-black/40"
                >
                  <img src={photoUrl(name)} alt="" className="absolute inset-0 w-full h-full object-contain" />
                  <span className="absolute top-[0.8vh] right-[0.6vw] w-[3.4vh] h-[3.4vh] rounded-full bg-black/65 flex items-center justify-center">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-[2.1vh] h-[2.1vh]"
                    >
                      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
                    </svg>
                  </span>
                </FocusButton>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
