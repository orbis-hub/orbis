import { useState } from "react";
import { defineClient, useModuleApi, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Empty, Field, Icon, Input, Modal, Select, Window, iconNames } from "@orbis/ui";
import type { Link } from "./server";

const URL_MAX = 2048;
const TITLE_MAX = 200;
const GROUP_MAX = 100;

/** server validation errors carry the first issue's message (e.g. "url must start with http:// or https://") */
const errorMessage = (err: unknown) => {
  const data = (err as { data?: { issues?: Array<{ message?: string }> } })?.data;
  return data?.issues?.[0]?.message ?? (err as Error)?.message ?? String(err);
};

function useLinks(group?: string) {
  return useModuleQuery<Link[]>(`/links${group ? `?group=${encodeURIComponent(group)}` : ""}`, { refetchOn: ["changed"] });
}

function Tile({ l, size, label }: { l: Link; size: number; label: boolean }) {
  return (
    <a href={l.url} target="_blank" rel="noreferrer" title={l.url} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, width: size, minHeight: size, padding: 6, border: "1.5px solid var(--line)", background: "var(--paper-2)", boxShadow: "2px 2px 0 var(--line)", textDecoration: "none", color: "var(--ink)" }} className="tile">
      {l.favicon ? <img src={l.favicon} alt="" width={size * 0.4} height={size * 0.4} style={{ imageRendering: "auto" }} /> : <Icon name={l.icon ?? "link"} size={size * 0.4} style={{ color: "var(--accent)" }} />}
      {label ? <span style={{ fontSize: Math.max(9, size * 0.14), textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{l.title}</span> : null}
    </a>
  );
}

function LinksWidget({ config }: WidgetProps<{ group?: string; size?: "small" | "medium" | "large"; labels?: boolean }>) {
  const t = useT();
  const q = useLinks(config.group || undefined);
  const list = q.data ?? [];
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("loading")}</span>;
  if (!list.length) return <Empty icon="bookmark" title={t("widget.links.empty")}>{t("widget.links.emptyHint")}</Empty>;
  const size = config.size === "small" ? 56 : config.size === "large" ? 96 : 72;
  return (
    <div className="scroll-y" style={{ height: "100%", display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start" }}>
      <style>{`.tile:hover { transform: translate(1px,1px); box-shadow: 1px 1px 0 var(--line); background: var(--accent-soft); }`}</style>
      {list.map((l) => <Tile key={l.id} l={l} size={size} label={config.labels !== false} />)}
    </div>
  );
}

function BookmarksPage(_p: PageProps) {
  const t = useT();
  const api = useModuleApi();
  const q = useLinks();
  const [editing, setEditing] = useState<Partial<Link> | null>(null);
  const [deleting, setDeleting] = useState<Link | null>(null);
  const groups = [...new Set((q.data ?? []).map((l) => l.group))].sort();
  const save = async (l: Partial<Link>) => {
    if (l.id) await api(`/links/${l.id}`, { method: "PATCH", json: { title: l.title, url: l.url, group: l.group, icon: l.icon ?? null } });
    else await api("/links", { method: "POST", json: { title: l.title, url: l.url, group: l.group, icon: l.icon ?? null } });
    setEditing(null);
    q.refetch();
  };
  const remove = async (l: Link) => {
    await api(`/links/${l.id}`, { method: "DELETE" }).catch(() => undefined);
    setDeleting(null);
    q.refetch();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button onClick={() => setEditing({ group: groups[0] ?? "" })}><Icon name="plus" size={12} /> {t("page.addLink")}</Button>
        <span className="soft" style={{ fontSize: 11 }}>{t("page.faviconHint")}</span>
      </div>
      {(q.data ?? []).length === 0 ? <Empty icon="bookmark" title={t("page.empty")}>{t("page.emptyHint")}</Empty> : null}
      {groups.map((g) => (
        <Window key={g || "_"} title={g || t("group.default")} right={<span className="soft" style={{ fontSize: 10 }}>{(q.data ?? []).filter((l) => l.group === g).length}</span>}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {(q.data ?? []).filter((l) => l.group === g).map((l) => (
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: "1px dashed var(--line)", fontSize: 12 }}>
                <div style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                  {l.favicon ? <img src={l.favicon} alt="" width={16} height={16} /> : <Icon name={l.icon ?? "link"} size={14} style={{ color: "var(--accent)" }} />}
                </div>
                <a href={l.url} target="_blank" rel="noreferrer" style={{ flex: "0 1 auto", color: "var(--ink)", textDecoration: "none" }}>{l.title}</a>
                <span className="soft" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{l.url.replace(/^https?:\/\//, "")}</span>
                <Button icon size="sm" variant="ghost" onClick={() => setEditing(l)} aria-label={t("action.edit")}><Icon name="edit" size={12} /></Button>
                <Button icon size="sm" variant="ghost" onClick={() => setDeleting(l)} aria-label={t("action.delete")}><Icon name="trash" size={12} /></Button>
              </div>
            ))}
          </div>
        </Window>
      ))}
      {editing ? <EditModal link={editing} groups={groups} onClose={() => setEditing(null)} onSave={save} /> : null}
      {deleting ? (
        <Modal open onClose={() => setDeleting(null)} title={t("modal.delete")} width={360}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 12 }}>{t("confirm.delete", { title: deleting.title })}</div>
            <div className="soft" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{deleting.url}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button onClick={() => setDeleting(null)}>{t("action.cancel")}</Button>
              <Button variant="primary" onClick={() => void remove(deleting)}><Icon name="trash" size={12} /> {t("action.delete")}</Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function EditModal({ link, groups, onClose, onSave }: { link: Partial<Link>; groups: string[]; onClose: () => void; onSave: (l: Partial<Link>) => Promise<void> }) {
  const t = useT();
  const [l, setL] = useState<Partial<Link>>(link);
  const [customGroup, setCustomGroup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const icons = iconNames();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(l);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={link.id ? t("modal.edit") : t("modal.new")}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label={t("field.url")} hint={t("field.urlHint")}><Input type="url" value={l.url ?? ""} onChange={(e) => setL({ ...l, url: e.target.value })} required autoFocus placeholder="https://…" inputMode="url" maxLength={URL_MAX} pattern="https?://.*" /></Field>
        <Field label={t("field.title")} hint={t("field.titleHint")}><Input value={l.title ?? ""} onChange={(e) => setL({ ...l, title: e.target.value })} maxLength={TITLE_MAX} /></Field>
        <Field label={t("field.group")}>
          {customGroup || groups.length === 0 ? (
            <Input value={l.group ?? ""} onChange={(e) => setL({ ...l, group: e.target.value })} placeholder={t("field.groupPlaceholder")} maxLength={GROUP_MAX} />
          ) : (
            <Select value={l.group ?? ""} onChange={(e) => (e.target.value === "__new" ? setCustomGroup(true) : setL({ ...l, group: e.target.value }))}>
              {groups.map((g) => <option key={g} value={g}>{g || t("group.none")}</option>)}
              <option value="__new">{t("group.new")}</option>
            </Select>
          )}
        </Field>
        <Field label={t("field.icon")} hint={t("field.iconHint")}>
          <div className="scroll-y" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 28px)", gap: 3, maxHeight: 110 }}>
            {icons.slice(0, 160).map((n) => (
              <button key={n} type="button" title={n} className="btn btn-icon btn-sm" style={{ boxShadow: "none", borderColor: l.icon === n ? "var(--accent)" : undefined }} onClick={() => setL({ ...l, icon: n })}><Icon name={n} size={13} /></button>
            ))}
          </div>
        </Field>
        {error ? <div role="alert" style={{ fontSize: 11, color: "var(--danger, #c33)" }}>{t("error.save", { message: error })}</div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("action.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{t("action.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}

export default defineClient({ widgets: { links: LinksWidget }, pages: { bookmarks: BookmarksPage } });
