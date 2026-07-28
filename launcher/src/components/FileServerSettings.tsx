import { useCallback, useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "../lib/i18n";
import { fetchFileServer, saveFileServer, installRclone, type FileServerStatus } from "../lib/api";
import { FocusButton } from "./FocusButton";
import { Osk } from "./Osk";

// Settings → Network: reach the box's folders from a computer (WebDAV).
//
// The folder list is NOT written down anywhere - the box reports what it found
// (screensaver images, games, an installed emulator's data folder where its BIOS
// goes, the home folder's own directories) and this only renders it, so a folder a
// future app introduces appears here on its own. `warn` marks the one folder that
// deserves a second thought: ~/.tvbox holds the box's settings and the apps' logins.
//
// A folder is listed under the exact name it will have over the network, never a
// translated one: the name here is what to look for in the computer's file manager,
// and a label the share does not carry would send someone hunting for it. The box
// settles name clashes (`Videos-2`) when it discovers a folder, so what it reports is
// already that name - there is nothing to adjust for here.
//
// A password is mandatory on the box's side; the row shows only whether one is set
// and an empty entry keeps the stored one, like the other credential forms. Saving
// applies immediately - the box starts or stops the server - so there is nothing to
// press afterwards, and the status line is the answer.

type Field = "user" | "pass";

export function FileServerSettings() {
  const { t } = useI18n();
  const [st, setSt] = useState<FileServerStatus | null>(null);
  const [editing, setEditing] = useState<Field | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    const s = await fetchFileServer();
    setUnreachable(!s);
    if (s) setSt(s);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // rclone arrives out of process; poll only while that is happening.
  useEffect(() => {
    if (!st?.installing) return;
    const iv = setInterval(load, 2000);
    return () => clearInterval(iv);
  }, [st?.installing, load]);

  const apply = async (patch: Parameters<typeof saveFileServer>[0]) => {
    const r = await saveFileServer(patch);
    setError(r.ok ? null : r.error || "failed");
    if (r.status) setSt(r.status);
    else load();
  };

  // The shell not answering is not the same as the server being off, and the controls
  // below would all fail: offer the way out instead, like the store does.
  if (unreachable)
    return (
      <div className="mt-[3vh]">
        <div className="text-[2.4vh] font-semibold mb-[0.6vh]">{t("fileserver.title")}</div>
        <div className="flex items-center gap-[1.5vw]">
          <span className="text-[1.9vh] text-warn">{t("app.shellUnreachable")}</span>
          <FocusButton
            focusKey="fsrv-retry"
            onEnter={load}
            className="px-[1.6vw] h-[5vh] rounded-[1vh] bg-white/5 flex items-center justify-center text-[1.9vh] font-semibold"
          >
            {t("app.retry")}
          </FocusButton>
        </div>
      </div>
    );

  if (editing) {
    const f = editing;
    const close = () => {
      setEditing(null);
      setTimeout(() => setFocus("fsrv-" + f), 0);
    };
    return (
      <Osk
        key={"fsrv-" + f}
        title={t(f === "user" ? "fileserver.user" : "fileserver.pass")}
        initial={f === "user" ? st?.user || "" : ""}
        onDone={(v) => {
          close();
          const val = v.trim();
          if (f === "user") apply({ user: val || undefined });
          else if (val) apply({ pass: val }); // empty keeps the stored one
        }}
        onCancel={close}
      />
    );
  }

  const on = !!st?.enabled;
  // Without rclone there is nothing to start, so that control is greyed rather than
  // quietly accepting a configuration the box cannot honour.
  const needsRclone = !!st && !st.rclone;
  const folders = st?.folders || [];
  const toggle = (id: string) =>
    apply({ folders: folders.includes(id) ? folders.filter((x) => x !== id) : [...folders, id] });

  return (
    <div className="mt-[3vh]">
      <div className="text-[2.4vh] font-semibold mb-[0.6vh]">
        {t("fileserver.title")}
        <span className={["text-[1.9vh] ml-[1.2vw]", st?.running ? "text-accent" : "text-fg-dim"].join(" ")}>
          {st?.running ? t("fileserver.running") : t("fileserver.stopped")}
        </span>
      </div>
      <div className="text-[1.9vh] text-fg-dim mb-[1.4vh] max-w-[70vw]">{t("fileserver.hint")}</div>

      {/* the address to type on a computer - the whole point of the feature */}
      {st?.running && st.url && (
        <div className="mb-[1.4vh] px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 max-w-[70vw]">
          <div className="text-[2.4vh] font-semibold tabular-nums">{st.url}</div>
          <div className="text-[1.7vh] text-fg-dim mt-[0.4vh]">{t("fileserver.urlHint", { user: st.user })}</div>
        </div>
      )}
      {error && <div className="text-[1.9vh] text-warn mb-[1vh] max-w-[70vw]">{t("fileserver.err." + error)}</div>}

      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {/* rclone is what serves it; on a box that never installed it, offer to fetch */}
        {st && !st.rclone && (
          <FocusButton
            focusKey="fsrv-rclone"
            onEnter={() => installRclone().then(load)}
            className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-sky-500/15 text-sky-200 flex items-center justify-between gap-[1.5vw]"
          >
            <span className="text-[2.1vh]">{t("fileserver.installRclone")}</span>
            <span className="text-[1.9vh]">{st.installing ? t("fileserver.installing") : ""}</span>
          </FocusButton>
        )}

        <FocusButton
          focusKey="fsrv-enabled"
          onEnter={() => (needsRclone ? setError("rclone_missing") : apply({ enabled: !on }))}
          className={[
            "px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]",
            needsRclone ? "opacity-40" : "",
          ].join(" ")}
        >
          <span className="text-[2.1vh]">{t("fileserver.enabled")}</span>
          <span className={["text-[1.9vh]", on ? "text-accent" : "text-fg-dim"].join(" ")}>
            {on ? t("fileserver.onWord") : t("fileserver.offWord")}
          </span>
        </FocusButton>

        <FocusButton
          focusKey="fsrv-user"
          onEnter={() => setEditing("user")}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="text-[2.1vh]">{t("fileserver.user")}</span>
          <span className="text-[1.9vh] text-fg-dim truncate">{st?.user || "-"}</span>
        </FocusButton>

        {/* Clearing it is a shell-side capability the form had no way to reach, and it
            is the honest way to switch the share off for good: no password, no server. */}
        {st?.hasPass && (
          <FocusButton
            focusKey="fsrv-pass-clear"
            onEnter={() => apply({ pass: "" })}
            className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
          >
            <span className="text-[2.1vh]">{t("fileserver.passClear")}</span>
            <span className="text-[1.7vh] text-fg-dim">{t("fileserver.passClearHint")}</span>
          </FocusButton>
        )}
        <FocusButton
          focusKey="fsrv-pass"
          onEnter={() => setEditing("pass")}
          className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
        >
          <span className="text-[2.1vh]">{t("fileserver.pass")}</span>
          <span className={["text-[1.9vh]", st?.hasPass ? "text-fg-dim" : "text-warn"].join(" ")}>
            {st?.hasPass ? "••••" : t("fileserver.passMissing", { n: st?.minPassword ?? 8 })}
          </span>
        </FocusButton>
      </div>

      <div className="text-[2.1vh] font-semibold mt-[2.4vh] mb-[0.6vh]">{t("fileserver.folders")}</div>
      <div className="text-[1.8vh] text-fg-dim mb-[1.2vh] max-w-[70vw]">{t("fileserver.foldersHint")}</div>
      <div className="flex flex-col gap-[0.8vh] max-w-[70vw]">
        {(st?.candidates || []).map((c) => {
          const picked = folders.includes(c.id);
          return (
            <FocusButton
              key={c.id}
              focusKey={"fsrv-folder-" + c.id}
              onEnter={() => toggle(c.id)}
              className="px-[2vw] py-[1.5vh] rounded-[1.1vh] bg-white/5 flex items-center justify-between gap-[1.5vw]"
            >
              <span className="text-[2.1vh] truncate">
                {c.name}
                {c.warn && <span className="text-[1.7vh] text-warn ml-[1vw]">{t("fileserver.warnTvbox")}</span>}
              </span>
              <span className={["text-[1.9vh]", picked ? "text-accent" : "text-fg-dim"].join(" ")}>
                {picked ? t("fileserver.shared") : t("fileserver.notShared")}
              </span>
            </FocusButton>
          );
        })}
        {st && !st.candidates.length && <div className="text-[1.9vh] text-fg-dim">{t("fileserver.noFolders")}</div>}
      </div>
    </div>
  );
}
