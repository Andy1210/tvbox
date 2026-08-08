import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { fetchStore, saveStoreSources, type StoreSource } from "../../lib/api";
import { sourceLabel } from "../../lib/storesource";
import { SettingsPage } from "../SettingsPage";
import { Group, InfoRow, Note, Row, TextRow, ToggleRow } from "../Rows";
import { useSettingsNav } from "../nav";

// Settings -> Apps -> Store -> Sources: which registries the store is built from.
//
// The box ships one, and the owner may add more. An added registry is trusted
// like the official one, because there is no weaker way to install an app that
// would still be worth having: a manifest-only remote app already gets an origin
// on the box. So the trust decision is made once, here, and the screen says what
// it means instead of pretending a setting could contain it.
//
// The one thing kept apart is UNATTENDED updates, per source. That is the moment
// a source acts on the box with nobody in the room, and an owner who wants the
// official catalogue to keep updating itself while reviewing a homebrew registry
// by hand can have exactly that. Both are still under the box's overall apps
// auto-update switch (Settings -> Apps), which turns the nightly run off entirely.

type Draft = { url: string; name: string; autoUpdate: boolean };

// One added source. Self-contained (a pushed page is unmounted while another is
// on top of it), so it owns its draft and asks the list to reload on the way out.
function SourceEditPage({
  existing,
  others,
  onDone,
}: {
  existing?: StoreSource;
  others: StoreSource[];
  onDone: () => void;
}) {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [draft, setDraft] = useState<Draft>({
    url: existing?.url || "",
    name: existing?.name || "",
    autoUpdate: !!existing?.autoUpdate,
  });
  const [armed, setArmed] = useState(false); // adding a source is one press away from running its code
  const [armRemove, setArmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  // A ref, not the state, is what refuses the second press: two presses inside
  // one render tick both read the same `busy` from their own closure, and the
  // `disabled` prop only takes effect once React has re-rendered.
  const writing = useRef(false);
  const [error, setError] = useState("");

  // `expect` is the url this write is supposed to end up storing, and only a save
  // has one: on a removal the address is meant to be gone, so checking for it
  // there would report a successful removal as a refused address.
  const write = async (list: Draft[], expect?: string) => {
    if (writing.current) return; // one write at a time: each one replaces the WHOLE list
    writing.current = true;
    setBusy(true);
    const r = await saveStoreSources(list.map((d) => ({ url: d.url, name: d.name || null, autoUpdate: d.autoUpdate })));
    writing.current = false;
    setBusy(false);
    // The box answers with what it stored. A url it refused (not https, and not a
    // LAN address) comes back missing, and saying so beats a page that closes as
    // if it had worked.
    if (!r.ok) return setError(t("storeSources.saveFailed"));
    if (expect && !r.sources.some((s) => s.url === expect)) return setError(t("storeSources.badUrl"));
    onDone();
    nav.pop();
  };

  const save = () => {
    const url = draft.url.trim();
    if (!url) return setError(t("storeSources.needUrl"));
    if (!existing && !armed) return setArmed(true);
    const rest = others.map((s) => ({ url: s.url, name: s.name || "", autoUpdate: !!s.autoUpdate }));
    void write([...rest, { ...draft, url }], url);
  };

  const remove = () => {
    if (!armRemove) return setArmRemove(true);
    void write(others.map((s) => ({ url: s.url, name: s.name || "", autoUpdate: !!s.autoUpdate })));
  };

  return (
    <SettingsPage
      id="store-source-edit"
      title={existing ? sourceLabel(existing) : t("storeSources.add")}
      subtitle={t("storeSources.editHint")}
      onBack={nav.pop}
      animate="push"
    >
      {error && <Note tone="warn">{error}</Note>}
      <Note tone="warn">{t("storeSources.risk")}</Note>

      <Group>
        <TextRow
          id="url"
          label={t("storeSources.url")}
          hint={t("storeSources.urlHint")}
          title={t("storeSources.url")}
          value={draft.url}
          emptyLabel="-"
          autoFocus
          onSubmit={(v) => {
            setDraft((d) => ({ ...d, url: v.trim() }));
            setError("");
            setArmed(false); // a changed address is a different source than the one just armed
          }}
        />
        <TextRow
          id="name"
          label={t("storeSources.name")}
          title={t("storeSources.name")}
          value={draft.name}
          emptyLabel={t("storeSources.nameAuto")}
          onSubmit={(v) => setDraft((d) => ({ ...d, name: v.trim().slice(0, 60) }))}
        />
        <ToggleRow
          id="auto"
          label={t("storeSources.auto")}
          hint={t("storeSources.autoHint")}
          on={draft.autoUpdate}
          onWord={t("common.on")}
          offWord={t("common.off")}
          onToggle={() => setDraft((d) => ({ ...d, autoUpdate: !d.autoUpdate }))}
        />
      </Group>

      <Group>
        <Row
          id="save"
          label={busy ? t("storeSources.saving") : armed ? t("storeSources.addSure") : t("storeSources.save")}
          trailing="none"
          disabled={busy}
          onEnter={save}
        />
        {existing && (
          <Row
            id="remove"
            label={armRemove ? t("storeSources.removeSure") : t("storeSources.remove")}
            hint={t("storeSources.removeHint")}
            trailing="none"
            disabled={busy}
            onEnter={remove}
          />
        )}
      </Group>
    </SettingsPage>
  );
}

export function StoreSourcesPage() {
  const { t } = useI18n();
  const nav = useSettingsNav();
  const [sources, setSources] = useState<StoreSource[] | null>(null);
  // The cap belongs to the box (it is what refuses the eleventh on save), so the
  // Add row asks for it rather than keeping a second copy that could drift.
  const [maxSources, setMaxSources] = useState(10);
  const [unreachable, setUnreachable] = useState(false);
  // Every save replaces the WHOLE list, so a second press before the first answer
  // lands would write a state nobody asked for. Same guard the apps auto-update
  // toggle uses, for the same reason.
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // The list comes from the store itself rather than from the config: it is the
  // only answer that also carries what each registry ANSWERED (how many apps, or
  // why it did not), which is the difference between a typo and a dead host.
  const load = useCallback(async () => {
    const d = await fetchStore(true);
    setUnreachable(!d);
    if (d && d.sources) setSources(d.sources);
    if (d && typeof d.maxSources === "number") setMaxSources(d.maxSources);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (unreachable)
    return (
      <SettingsPage id="store-sources" title={t("storeSources.title")} onBack={nav.pop} animate="push">
        <Note tone="warn">{t("app.shellUnreachable")}</Note>
        <Group>
          <Row id="retry" label={t("app.retry")} trailing="none" autoFocus onEnter={() => void load()} />
        </Group>
      </SettingsPage>
    );
  if (!sources)
    return (
      <SettingsPage
        id="store-sources"
        title={t("storeSources.title")}
        subtitle={t("storeSources.hint")}
        onBack={nav.pop}
        animate="push"
      />
    );

  // The box returns the primary first, and it is the only one that cannot be
  // removed from here: without it the store would have nothing to fall back to.
  const [primary, ...extras] = sources;
  const status = (s: StoreSource) =>
    s.error ? t("storeSources.failed") : t("storeSources.appCount", { n: s.count ?? 0 });
  const edit = (existing?: StoreSource) =>
    nav.push({
      id: "store-source-edit",
      title: existing ? sourceLabel(existing) : t("storeSources.add"),
      render: () => (
        <SourceEditPage
          existing={existing}
          others={extras.filter((s) => s.url !== existing?.url)}
          onDone={() => void load()}
        />
      ),
    });
  const setPrimaryAuto = async (on: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await saveStoreSources(
        extras.map((s) => ({ url: s.url, name: s.name, autoUpdate: !!s.autoUpdate })),
        on,
      );
      await load();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <SettingsPage
      id="store-sources"
      title={t("storeSources.title")}
      subtitle={t("storeSources.hint")}
      onBack={nav.pop}
      animate="push"
    >
      <Group title={primary.official ? t("storeSources.official") : t("storeSources.primary")}>
        <InfoRow label={sourceLabel(primary)} value={status(primary)} />
        <ToggleRow
          id="primary-auto"
          label={t("storeSources.auto")}
          hint={t("storeSources.autoHint")}
          on={primary.autoUpdate}
          onWord={t("common.on")}
          offWord={t("common.off")}
          disabled={saving}
          autoFocus
          onToggle={() => void setPrimaryAuto(!primary.autoUpdate)}
        />
      </Group>

      <Group title={t("storeSources.added")}>
        {extras.map((s) => (
          <Row
            key={s.url}
            id={"src-" + s.url}
            label={sourceLabel(s)}
            hint={s.url}
            value={status(s) + (s.autoUpdate ? " " + t("storeSources.autoShort") : "")}
            onEnter={() => edit(s)}
          />
        ))}
        {!extras.length && <InfoRow label={t("storeSources.none")} value="" />}
      </Group>

      {extras.length < maxSources && (
        <Group>
          <Row id="add" label={t("storeSources.add")} trailing="none" onEnter={() => edit(undefined)} />
        </Group>
      )}
      <Note tone="warn">{t("storeSources.risk")}</Note>
      <Note>{t("storeSources.devHint")}</Note>
    </SettingsPage>
  );
}
