import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchFileServer, saveFileServer, installRclone, type FileServerStatus } from "../../lib/api";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row, TextRow, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";
import { invalidateSummary } from "../summary";

// Settings -> Network -> File server: the box's folders over WebDAV.
//
// Three things here are load-bearing and easy to lose in a redesign:
//
//  - **The shell not answering is not the same as the server being off.** Showing
//    "stopped" plus a full set of controls that would all fail is the wrong story,
//    so an unreachable box gets a retry and nothing else.
//  - **A stored password must be clearable.** An empty entry means "keep the stored
//    one" in every credential form here, so without an explicit clear there is no
//    path to "" at all - and no password means no server, which is the honest way
//    to switch the share off for good.
//  - **Without rclone there is nothing to start**, so the switch is greyed rather
//    than quietly accepting a configuration the box cannot honour.
//
// The folder list is NOT written down anywhere: the box discovers what can be
// shared and this only renders it, so a folder a future app introduces appears on
// its own. Each is listed under the exact name a computer will see, never a
// translated one - the name here is what to look for in a file manager.
const RCLONE_POLL_MS = 2000;

// Self-contained on purpose (see PushedPage): it reads and writes the shared set
// itself, because the page that opened it is unmounted while this one is up.
export function FoldersPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [st, setSt] = useState<FileServerStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await fetchFileServer();
    setUnreachable(!s);
    if (s) setSt(s);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const folders = st?.folders || [];
  const candidates = st?.candidates || [];
  const onToggle = async (id: string) => {
    const next = folders.includes(id) ? folders.filter((x) => x !== id) : [...folders, id];
    setSt((s) => s && { ...s, folders: next }); // the row answers the press, not the round trip
    invalidateSummary("fileserver");
    const r = await saveFileServer({ folders: next });
    // The box refuses some of these - un-sharing the last folder while the server is
    // enabled is `no_folders`, a share it cannot build is `share_failed` - and it has a
    // sentence for each. Swallowing them left the row flipped and the server stopped.
    setError(r.ok ? null : r.error || "failed");
    if (r.status) setSt(r.status);
    else void load(); // the optimistic flip was not accepted; show what the box has
  };

  // Not the same as "nothing to share": saying that about a box we cannot reach would
  // be stating a guess as a fact.
  if (unreachable)
    return (
      <SettingsPage id="fs-folders" title={t("fileserver.folders")} onBack={nav.pop} animate="push">
        <Note tone="warn">{t("app.shellUnreachable")}</Note>
        <Group>
          <Row id="retry" label={t("app.retry")} trailing="none" autoFocus onEnter={() => void load()} />
        </Group>
      </SettingsPage>
    );

  return (
    <SettingsPage
      id="fs-folders"
      title={t("fileserver.folders")}
      subtitle={t("fileserver.foldersHint")}
      onBack={nav.pop}
      animate="push"
    >
      {error && <Note tone="warn">{t("fileserver.err." + error)}</Note>}
      {!candidates.length ? (
        <Note>{t("fileserver.noFolders")}</Note>
      ) : (
        <Group>
          {candidates.map((c, i) => (
            <ToggleRow
              key={c.id}
              id={"folder-" + c.id}
              label={c.name}
              // The one folder that deserves a second thought carries the reason on
              // the row: ~/.tvbox holds the box's settings and the apps' logins.
              hint={c.warn ? t("fileserver.warnTvbox") : undefined}
              on={folders.includes(c.id)}
              onToggle={() => void onToggle(c.id)}
              onWord={t("fileserver.shared")}
              offWord={t("fileserver.notShared")}
              autoFocus={i === 0}
            />
          ))}
        </Group>
      )}
    </SettingsPage>
  );
}

export function FileServerPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [st, setSt] = useState<FileServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    const s = await fetchFileServer();
    setUnreachable(!s);
    invalidateSummary("fileserver");
    if (s) setSt(s);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // rclone arrives out of process; poll only while that is happening.
  useEffect(() => {
    if (!st?.installing) return;
    const iv = setInterval(() => void load(), RCLONE_POLL_MS);
    return () => clearInterval(iv);
  }, [st?.installing, load]);

  const apply = useCallback(
    async (patch: Parameters<typeof saveFileServer>[0]) => {
      const r = await saveFileServer(patch);
      setError(r.ok ? null : r.error || "failed");
      invalidateSummary("fileserver");
      if (r.status) setSt(r.status);
      else void load();
    },
    [load],
  );

  if (unreachable)
    return (
      <SettingsPage id="fs" title={t("fileserver.title")} onBack={nav.pop} animate="push">
        <Note tone="warn">{t("app.shellUnreachable")}</Note>
        <Group>
          <Row id="retry" label={t("app.retry")} trailing="none" autoFocus onEnter={() => void load()} />
        </Group>
      </SettingsPage>
    );

  // Nothing is drawn from a status we do not have yet: a form built out of nulls
  // claims the switch is off and the share count is zero, and the first row to ask for
  // the focus wins it - which would be the toggle, not the "install rclone" row that
  // appears a moment later.
  if (!st)
    return (
      <SettingsPage
        id="fs"
        title={t("fileserver.title")}
        subtitle={t("fileserver.hint")}
        onBack={nav.pop}
        animate="push"
      />
    );

  const on = st.enabled;
  const needsRclone = !st.rclone;
  const folders = st.folders;

  return (
    <SettingsPage id="fs" title={t("fileserver.title")} subtitle={t("fileserver.hint")} onBack={nav.pop} animate="push">
      <Note tone={st.running ? "accent" : "dim"}>{st.running ? t("fileserver.running") : t("fileserver.stopped")}</Note>
      {error && <Note tone="warn">{t("fileserver.err." + error)}</Note>}

      {!st.rclone && (
        <Group>
          <Row
            id="rclone"
            label={t("fileserver.installRclone")}
            value={st.installing ? t("fileserver.installing") : undefined}
            trailing="none"
            autoFocus
            onEnter={() => void installRclone().then(load)}
          />
        </Group>
      )}

      <Group>
        <ToggleRow
          id="enabled"
          label={t("fileserver.enabled")}
          // Say why it will not hold rather than leaving the user to press it and find
          // out. Still pressable: a control that does nothing at all reads as broken.
          hint={needsRclone ? t("fileserver.err.rclone_missing") : undefined}
          on={on}
          // Greyed, but it still answers the press with a reason - a control that
          // does nothing at all reads as a broken box.
          onToggle={() => (needsRclone ? setError("rclone_missing") : void apply({ enabled: !on }))}
          onWord={t("fileserver.onWord")}
          offWord={t("fileserver.offWord")}
          autoFocus={!needsRclone}
        />
        {/* The address to type on a computer - the whole point of the feature. */}
        {st.running && st.url && <InfoRow label={t("fileserver.address")} value={st.url} />}
      </Group>
      {st.running && st.url && <Note>{t("fileserver.urlHint", { user: st.user })}</Note>}

      <Group title={t("fileserver.groupAccess")}>
        <TextRow
          id="user"
          label={t("fileserver.user")}
          title={t("fileserver.user")}
          value={st.user}
          emptyLabel="-"
          onSubmit={(v) => void apply({ user: v.trim() || undefined })}
        />
        <TextRow
          id="pass"
          label={t("fileserver.pass")}
          title={t("fileserver.pass")}
          secret
          hasSecret={st.hasPass}
          emptyLabel={t("fileserver.passMissing", { n: st.minPassword })}
          onSubmit={(v) => v.trim() && void apply({ pass: v.trim() })}
        />
        {st.hasPass && (
          <Row
            id="pass-clear"
            label={t("fileserver.passClear")}
            hint={t("fileserver.passClearHint")}
            trailing="none"
            onEnter={() => void apply({ pass: "" })}
          />
        )}
      </Group>

      <Group>
        <Row
          id="folders"
          label={t("fileserver.folders")}
          hint={t("fileserver.foldersHint")}
          value={String(folders.length)}
          onEnter={() => nav.push({ id: "fs-folders", title: t("fileserver.folders"), render: () => <FoldersPage /> })}
        />
      </Group>
    </SettingsPage>
  );
}
