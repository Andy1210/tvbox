import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";
import {
  fetchShares,
  saveShare,
  removeShare,
  testShare,
  installRclone,
  type ShareInput,
  type ShareRow,
  type SharesStatus,
} from "../../lib/api";
import { SharePairing } from "../../components/SharePairing";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row, TextRow, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";
import { invalidateSummary } from "../summary";

// Settings -> Network -> Network shares: a NAS as a source, so a film can live on
// the network instead of on the box.
//
// SMB only, and the reason is worth carrying on the screen: mounting NFS goes
// through the mount syscall and therefore needs root, which this box never uses at
// runtime. rclone mounts SMB over FUSE as the ordinary user.
//
// The form is built around the box doing the finding. Typing a share name and a
// folder path on a TV is where this feature would be abandoned, so Test asks the
// server what it offers - the shares first, then the folders inside one - and each
// answer is a row that fills the field it belongs to.
const RCLONE_POLL_MS = 2000;

function errText(t: (k: string) => string, code: string): string {
  const key = "shares.err." + code;
  const msg = t(key);
  return msg === key ? code : msg; // the box's rclone errors are its own prose
}

// One share's form. Self-contained (see PushedPage): the page that opened it is
// unmounted while this one is up, so it owns its draft and reloads the list on the
// way out.
function ShareEditPage({ existing, onDone }: { existing?: ShareRow; onDone: () => void }) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [draft, setDraft] = useState<ShareInput>({
    original: existing?.name,
    name: existing?.name || "",
    host: existing?.host || "",
    share: existing?.share || "",
    path: existing?.path || "",
    cache: existing?.cache || "media",
    user: existing?.user || "",
  });
  const [passSet, setPassSet] = useState(!!existing?.hasPass);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<{ shares?: string[]; dirs?: string[] }>({});
  const [armRemove, setArmRemove] = useState(false);

  const set = (patch: ShareInput) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError("");
  };

  const test = async () => {
    setBusy(true);
    setError("");
    setFound({});
    const r = await testShare(draft);
    setBusy(false);
    if (!r.ok) return setError(r.error || "failed");
    // No share picked yet -> what the server offers. One picked -> what is inside.
    setFound(r.shares ? { shares: r.shares } : { dirs: r.dirs });
  };

  const save = async () => {
    setBusy(true);
    const r = await saveShare(draft);
    setBusy(false);
    if (!r.ok) return setError(r.error || "failed");
    invalidateSummary("shares");
    onDone();
    nav.pop();
  };

  const remove = async () => {
    if (!existing) return;
    if (!armRemove) return setArmRemove(true); // a TV has one button: arm, then do it
    setBusy(true);
    await removeShare(existing.name);
    setBusy(false);
    invalidateSummary("shares");
    onDone();
    nav.pop();
  };

  return (
    <SettingsPage
      id="share-edit"
      title={existing ? existing.name : t("shares.add")}
      subtitle={t("shares.editHint")}
      onBack={nav.pop}
      animate="push"
    >
      {error && <Note tone="warn">{errText(t, error)}</Note>}
      {existing && (
        <Note tone={existing.mounted ? "ok" : "dim"}>
          {existing.mounted ? t("shares.connected") : t("shares.offline")}
        </Note>
      )}

      <Group title={t("shares.groupServer")}>
        <TextRow
          id="host"
          label={t("shares.host")}
          title={t("shares.host")}
          value={draft.host}
          emptyLabel="-"
          autoFocus
          onSubmit={(v) => set({ host: v.trim() })}
        />
        <TextRow
          id="user"
          label={t("shares.user")}
          title={t("shares.user")}
          value={draft.user}
          emptyLabel={t("shares.guest")}
          onSubmit={(v) => set({ user: v.trim() })}
        />
        <TextRow
          id="pass"
          label={t("shares.pass")}
          title={t("shares.pass")}
          secret
          hasSecret={passSet}
          emptyLabel={t("shares.noPass")}
          onSubmit={(v) => {
            set({ pass: v });
            setPassSet(!!v);
          }}
        />
        {passSet && (
          <Row
            id="pass-clear"
            label={t("shares.passClear")}
            trailing="none"
            onEnter={() => {
              set({ pass: "" });
              setPassSet(false);
            }}
          />
        )}
      </Group>

      <Group title={t("shares.groupWhat")} hint={t("shares.whatHint")}>
        <TextRow
          id="share"
          label={t("shares.share")}
          title={t("shares.share")}
          value={draft.share}
          emptyLabel="-"
          onSubmit={(v) => set({ share: v.trim() })}
        />
        <TextRow
          id="path"
          label={t("shares.path")}
          title={t("shares.path")}
          value={draft.path}
          emptyLabel={t("shares.wholeShare")}
          onSubmit={(v) => set({ path: v.trim() })}
        />
        {/* What is on it, not how it is cached: the person setting this up knows
            what they put on the NAS. A film is streamed once and a disc image is
            read all over for hours, and over SMB that difference is a second of
            freezing in the middle of a game. */}
        <ToggleRow
          id="cache"
          label={t("shares.cacheLabel")}
          hint={draft.cache === "games" ? t("shares.cacheGamesHint") : t("shares.cacheMediaHint")}
          on={draft.cache === "games"}
          onToggle={() => set({ cache: draft.cache === "games" ? "media" : "games" })}
          onWord={t("shares.cacheGames")}
          offWord={t("shares.cacheMedia")}
        />
        <TextRow
          id="name"
          label={t("shares.name")}
          hint={t("shares.nameHint")}
          title={t("shares.name")}
          value={draft.name}
          emptyLabel={t("shares.nameAuto")}
          onSubmit={(v) => set({ name: v.trim() })}
        />
      </Group>

      <Group>
        <Row
          id="test"
          label={busy ? t("shares.testing") : t("shares.test")}
          trailing="none"
          onEnter={() => void test()}
        />
        <Row id="save" label={t("shares.save")} trailing="none" onEnter={() => void save()} />
        {existing && (
          <Row
            id="remove"
            label={armRemove ? t("shares.removeSure") : t("shares.remove")}
            trailing="none"
            onEnter={() => void remove()}
          />
        )}
      </Group>

      {/* What the server answered. Each row fills the field it belongs to, because
          typing a share name on a TV is where this would be given up on. */}
      {found.shares && (
        <Group title={t("shares.pickShare")}>
          {found.shares.map((s) => (
            <Row
              key={s}
              id={"pick-" + s}
              label={s}
              trailing="none"
              onEnter={() => {
                set({ share: s, path: "" });
                setFound({});
              }}
            />
          ))}
        </Group>
      )}
      {found.dirs && (
        <Group title={t("shares.pickFolder")} hint={t("shares.pickFolderHint")}>
          {found.dirs.map((d) => (
            <Row
              key={d}
              id={"dir-" + d}
              label={d}
              trailing="none"
              onEnter={() => {
                set({ path: (draft.path ? draft.path + "/" : "") + d });
                setFound({});
              }}
            />
          ))}
        </Group>
      )}
    </SettingsPage>
  );
}

export function SharesPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [st, setSt] = useState<SharesStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [phone, setPhone] = useState(false);

  const load = useCallback(async () => {
    const s = await fetchShares();
    setUnreachable(!s);
    invalidateSummary("shares");
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

  const edit = (existing?: ShareRow) =>
    nav.push({
      id: "share-edit",
      title: existing ? existing.name : t("shares.add"),
      render: () => <ShareEditPage existing={existing} onDone={() => void load()} />,
    });

  if (unreachable)
    return (
      <SettingsPage id="shares" title={t("shares.title")} onBack={nav.pop} animate="push">
        <Note tone="warn">{t("app.shellUnreachable")}</Note>
        <Group>
          <Row id="retry" label={t("app.retry")} trailing="none" autoFocus onEnter={() => void load()} />
        </Group>
      </SettingsPage>
    );

  // Nothing is drawn from a status we do not have yet: a form built out of nulls
  // claims there are no shares and no rclone, and the first row to ask for the
  // focus wins it.
  if (!st)
    return (
      <SettingsPage id="shares" title={t("shares.title")} subtitle={t("shares.hint")} onBack={nav.pop} animate="push" />
    );

  return (
    <SettingsPage id="shares" title={t("shares.title")} subtitle={t("shares.hint")} onBack={nav.pop} animate="push">
      {!st.rclone && (
        <Group>
          <Row
            id="rclone"
            label={t("shares.installRclone")}
            hint={t("shares.needRclone")}
            value={st.installing ? t("shares.installing") : undefined}
            trailing="none"
            autoFocus
            onEnter={() => void installRclone().then(load)}
          />
        </Group>
      )}

      <Group>
        {st.shares.map((s, i) => (
          <Row
            key={s.name}
            id={"share-" + s.name}
            label={s.name}
            hint={s.host + " / " + s.share + (s.path ? "/" + s.path : "")}
            value={s.mounted ? t("shares.connected") : t("shares.offline")}
            autoFocus={i === 0 && st.rclone}
            onEnter={() => edit(s)}
          />
        ))}
        {!st.shares.length && <InfoRow label={t("shares.none")} value="" />}
      </Group>

      {st.shares.length < st.max && (
        <Group>
          {/* The phone first: an address, a user and a password are three things
              nobody should spell out on a keyboard grid. */}
          <Row
            id="add-phone"
            label={t("shares.addPhone")}
            hint={t("shares.addPhoneHint")}
            trailing="none"
            autoFocus={!st.shares.length && st.rclone}
            onEnter={() => setPhone(true)}
          />
          <Row id="add" label={t("shares.add")} trailing="none" onEnter={() => edit(undefined)} />
        </Group>
      )}
      {phone && (
        <SharePairing
          onClose={() => {
            setPhone(false);
            void load();
          }}
        />
      )}
      <Note>{t("shares.playHint")}</Note>
    </SettingsPage>
  );
}
