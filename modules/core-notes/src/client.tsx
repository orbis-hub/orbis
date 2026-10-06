import { useEffect, useRef, useState, type ReactNode } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Empty, Icon, Input, Modal, Window, cx } from "@orbis/ui";
import type { Note } from "./server";

const MAX_TITLE = 200;
const MAX_BODY = 10_000;

/* ---------- tiny markdown: headings, bold, italic, code, links, lists, checkboxes, rules ---------- */

/** only http(s) and mailto become links; `javascript:` & co render as plain text */
export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) && !/[\s<>"']/.test(h) ? h : null;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2]) out.push(<b key={k++}>{m[2]}</b>);
    else if (m[4]) out.push(<i key={k++}>{m[4]}</i>);
    else if (m[6]) out.push(<code key={k++} style={{ background: "var(--paper-2)", padding: "0 3px" }}>{m[6]}</code>);
    else if (m[8]) {
      const href = safeHref(m[9]!);
      out.push(href ? <a key={k++} href={href} target="_blank" rel="noreferrer noopener">{m[8]}</a> : <span key={k++}>{m[8]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, onToggle }: { text: string; onToggle?: (lineIndex: number, checked: boolean) => void }) {
  const lines = text.split("\n");
  return (
    <div style={{ fontSize: 13, lineHeight: 1.55 }}>
      {lines.map((line, i) => {
        const h = line.match(/^(#{1,3})\s+(.*)$/);
        if (h) return <div key={i} className="pixel" style={{ fontSize: h[1]!.length === 1 ? 17 : h[1]!.length === 2 ? 15 : 13, marginTop: i ? 6 : 0 }}>{inline(h[2]!)}</div>;
        if (/^---+$/.test(line.trim())) return <hr key={i} className="dotted-hr" />;
        const cb = line.match(/^\s*[-*]\s+\[([ xX])\]\s*(.*)$/);
        if (cb) {
          const checked = cb[1]!.trim() !== "";
          return (
            <label key={i} className="check" style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "1px 0", opacity: checked ? 0.6 : 1 }}>
              <input type="checkbox" checked={checked} onChange={(e) => onToggle?.(i, e.target.checked)} disabled={!onToggle} />
              <i aria-hidden style={{ marginTop: 3 }} />
              <span style={{ textDecoration: checked ? "line-through" : undefined }}>{inline(cb[2]!)}</span>
            </label>
          );
        }
        const li = line.match(/^\s*[-*]\s+(.*)$/);
        if (li) return <div key={i} style={{ display: "flex", gap: 6 }}><span className="soft">•</span><span>{inline(li[1]!)}</span></div>;
        const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (ol) return <div key={i} style={{ display: "flex", gap: 6 }}><span className="soft" style={{ fontVariantNumeric: "tabular-nums" }}>{ol[1]}.</span><span>{inline(ol[2]!)}</span></div>;
        if (!line.trim()) return <div key={i} style={{ height: 6 }} />;
        return <div key={i}>{inline(line)}</div>;
      })}
    </div>
  );
}

function toggleLine(body: string, lineIndex: number, checked: boolean) {
  const lines = body.split("\n");
  lines[lineIndex] = (lines[lineIndex] ?? "").replace(/\[([ xX])\]/, checked ? "[x]" : "[ ]");
  return lines.join("\n");
}

/* ---------- autosave editor ---------- */

function useAutosave(note: Note | null | undefined, refetch: () => void) {
  const api = useModuleApi();
  const [body, setBody] = useState(note?.body ?? "");
  const [title, setTitle] = useState(note?.title ?? "");
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) {
      setBody(note?.body ?? "");
      setTitle(note?.title ?? "");
    }
  }, [note?.id, note?.body, note?.title]);
  const save = (patch: { body?: string; title?: string }) => {
    if (!note) return;
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api(`/notes/${note.id}`, { method: "PATCH", json: patch });
        dirty.current = false;
        refetch();
      } finally {
        setSaving(false);
      }
    }, 500);
  };
  return { body, title, saving, setBody: (v: string) => { setBody(v); save({ body: v }); }, setTitle: (v: string) => { setTitle(v); save({ title: v }); } };
}

/* ---------- widgets ---------- */

function NoteWidget({ config }: WidgetProps<{ noteId?: string; showTitle?: boolean }>) {
  const api = useModuleApi();
  const t = useT();
  const q = useModuleQuery<Note | null>(config.noteId ? `/notes/${config.noteId}` : "/notes/pinned", { refetchOn: ["changed"] });
  const n = q.data;
  if (q.loading && !n) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  if (!n) return <Empty icon="note" title={t("widget.note.empty")}>{t("widget.note.emptyHint")}</Empty>;
  return (
    <div className="scroll-y" style={{ height: "100%" }}>
      {config.showTitle !== false ? <div className="pixel" style={{ fontSize: 14, marginBottom: 4 }}>{n.title}</div> : null}
      <Markdown text={n.body} onToggle={(i, c) => void api(`/notes/${n.id}`, { method: "PATCH", json: { body: toggleLine(n.body, i, c) } }).then(() => q.refetch())} />
    </div>
  );
}

const SCRATCH_TITLE = "scratchpad";

function ScratchWidget({ config }: WidgetProps<{ noteId?: string }>) {
  const api = useModuleApi();
  const t = useT();
  const q = useModuleQuery<Note>(config.noteId ? `/notes/${config.noteId}` : `/notes/by-title/${SCRATCH_TITLE}`, { refetchOn: ["changed"] });
  const ed = useAutosave(q.data, q.refetch);
  // no scratchpad note yet (404) → create it once, explicitly; a configured noteId that is gone stays an error
  const creating = useRef(false);
  const missing = !config.noteId && !q.data && (q.error as { status?: number } | null)?.status === 404;
  useEffect(() => {
    if (!missing || creating.current) return;
    creating.current = true;
    api("/notes", { method: "POST", json: { title: SCRATCH_TITLE, body: "" } })
      .then(() => q.refetch())
      .catch(() => undefined)
      .finally(() => { creating.current = false; });
  }, [missing, api, q]);
  if (!q.data) return <span className={cx("soft pixel")} style={{ fontSize: 12, color: q.error && !missing ? "var(--dnd)" : undefined }}>{q.error && !missing ? q.error.message : t("common.loading")}</span>;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <textarea className="input" value={ed.body} onChange={(e) => ed.setBody(e.target.value)} maxLength={MAX_BODY} placeholder={t("widget.scratch.placeholder")} style={{ flex: 1, resize: "none", minHeight: 0, fontSize: 12, lineHeight: 1.5 }} />
      <div className="soft" style={{ fontSize: 10, textAlign: "right" }}>{ed.saving ? t("common.saving") : t("common.saved")}</div>
    </div>
  );
}

/* ---------- page ---------- */

function NotesPage(_p: PageProps) {
  const api = useModuleApi();
  const t = useT();
  const { locale } = useModule();
  const list = useModuleQuery<Array<Note & { length: number }>>("/notes", { refetchOn: ["changed"] });
  const [sel, setSel] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [deleting, setDeleting] = useState<Note | null>(null);
  const current = useModuleQuery<Note>(`/notes/${sel ?? ""}`, { enabled: !!sel, refetchOn: ["changed"] });
  const ed = useAutosave(current.data, current.refetch);
  useEffect(() => {
    if (!sel && list.data?.length) setSel(list.data[0]!.id);
  }, [list.data, sel]);
  const create = async () => {
    const n = await api<Note>("/notes", { method: "POST", json: { title: t("page.notes.newNote"), body: "" } });
    setSel(n.id);
    setPreview(false);
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 240px) minmax(0, 1fr)", gap: 14, alignItems: "start" }} className="notes-page">
      <style>{`@media (max-width: 760px) { .notes-page { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
      <Window title={t("page.notes.title")} right={<Button icon size="sm" variant="ghost" onClick={create} aria-label={t("page.notes.newNote")}><Icon name="plus" size={12} /></Button>} tight>
        <div style={{ display: "flex", flexDirection: "column", padding: 6 }}>
          {(list.data ?? []).length === 0 ? <div className="soft" style={{ fontSize: 12, padding: 6 }}>{t("page.notes.empty")}</div> : null}
          {(list.data ?? []).map((n) => (
            <button key={n.id} type="button" className="nav-item" aria-current={n.id === sel ? "page" : undefined} onClick={() => setSel(n.id)} style={{ flexDirection: "column", alignItems: "flex-start", gap: 0 }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center", width: "100%" }}>
                {n.pinned ? <Icon name="pin" size={11} style={{ color: "var(--accent)" }} /> : null}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{n.title}</span>
              </span>
              <span className="soft" style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>{new Date(n.updated_at).toLocaleDateString(locale)} · {t("page.notes.chars", { count: n.length })}</span>
            </button>
          ))}
        </div>
      </Window>
      {current.data ? (
        <Window
          title={<input className="input" value={ed.title} onChange={(e) => ed.setTitle(e.target.value)} maxLength={MAX_TITLE} style={{ padding: "0 4px", fontFamily: "var(--font-pixel)", fontSize: 13, background: "transparent", border: 0, width: "100%" }} aria-label={t("page.notes.titleField")} />}
          right={
            <>
              <span className="soft" style={{ fontSize: 10 }}>{ed.saving ? t("common.saving") : t("common.saved")}</span>
              <Button size="sm" variant="ghost" aria-pressed={preview} onClick={() => setPreview((v) => !v)} title={t("page.notes.preview")}><Icon name="eye" size={12} /></Button>
              <Button size="sm" variant="ghost" aria-pressed={!!current.data.pinned} onClick={() => api(`/notes/${current.data!.id}`, { method: "PATCH", json: { pinned: !current.data!.pinned } }).then(() => list.refetch())} title={t("page.notes.pin")}><Icon name="pin" size={12} /></Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(current.data!)} aria-label={t("common.delete")} title={t("common.delete")}><Icon name="trash" size={12} /></Button>
            </>
          }
        >
          {preview ? (
            <div style={{ minHeight: 300 }}>
              <Markdown text={ed.body} onToggle={(i, c) => ed.setBody(toggleLine(ed.body, i, c))} />
            </div>
          ) : (
            <textarea className={cx("input")} value={ed.body} onChange={(e) => ed.setBody(e.target.value)} maxLength={MAX_BODY} style={{ minHeight: 360, width: "100%", resize: "vertical", fontSize: 13, lineHeight: 1.55 }} placeholder={t("page.notes.bodyPlaceholder")} />
          )}
        </Window>
      ) : (
        <Empty icon="note" title={t("page.notes.pick")} />
      )}
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={t("page.notes.deleteTitle")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 13 }}>{t("page.notes.confirmDelete", { title: deleting?.title ?? "" })}</span>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => { const id = deleting?.id; setDeleting(null); if (id) void api(`/notes/${id}`, { method: "DELETE" }).then(() => { setSel(null); list.refetch(); }); }}><Icon name="trash" size={12} /> {t("common.delete")}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default defineClient({
  widgets: { note: NoteWidget, scratch: ScratchWidget },
  pages: { notes: NotesPage },
});
