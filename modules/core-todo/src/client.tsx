import { useEffect, useMemo, useState, type FormEvent } from "react";
import { defineClient, useModule, useModuleApi, useModuleEvents, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import type { Translator } from "@orbis/sdk/client";
import { Button, Checkbox, Chip, Empty, Icon, Input, Menu, Modal, Field, Select, Window, cx } from "@orbis/ui";

type List = { id: string; name: string; color: string | null; sort: number; open: number };
type Task = { id: string; list_id: string; title: string; notes: string | null; done: number; due: string | null; sort: number; created_at: string; done_at: string | null };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* `due` is a calendar day (YYYY-MM-DD) with no time; "today" is the hub's timezone, not the browser's */
const DAY_FMT = new Map<string, Intl.DateTimeFormat>();
function todayKey(timezone: string): string {
  let f = DAY_FMT.get(timezone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
    }
    DAY_FMT.set(timezone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
/** day key → Date at utc midnight: safe for day arithmetic and for formatting with timeZone "UTC" */
const utcOf = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
};
const addDays = (key: string, n: number) => utcOf(key).getTime() + n * 86400_000;
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function dueLabel(due: string | null, t: Translator, locale: string, timezone: string) {
  if (!due) return null;
  const dayDiff = Math.round((utcOf(due).getTime() - utcOf(todayKey(timezone)).getTime()) / 86400_000);
  if (Number.isNaN(dayDiff)) return { text: due, tone: undefined };
  if (dayDiff < 0) return { text: dayDiff === -1 ? t("due.yesterday") : t("due.overdue", { count: -dayDiff }), tone: "bad" as const };
  if (dayDiff === 0) return { text: t("due.today"), tone: "accent" as const };
  if (dayDiff === 1) return { text: t("due.tomorrow"), tone: undefined };
  if (dayDiff < 7) return { text: utcOf(due).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" }), tone: undefined };
  return { text: utcOf(due).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" }), tone: undefined };
}

function useTasks(query: string) {
  const q = useModuleQuery<Task[]>(`/tasks${query}`, { refetchOn: ["changed"] });
  return q;
}

function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? <span role="alert" style={{ color: "var(--dnd)", fontSize: "var(--fs-meta)" }}>{msg}</span> : null;
}

function TaskRow({ t: task, onChange, dense, showList, lists }: { t: Task; onChange: () => void; dense?: boolean; showList?: boolean; lists?: List[] }) {
  const api = useModuleApi();
  const t = useT();
  const { locale, timezone } = useModule();
  const [err, setErr] = useState<string | null>(null);
  const due = dueLabel(task.due, t, locale, timezone);
  const list = lists?.find((l) => l.id === task.list_id);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: dense ? "3px 0" : "5px 0", borderBottom: "1px dashed var(--line)", opacity: task.done ? 0.55 : 1 }}>
      <Checkbox
        checked={!!task.done}
        onChange={async (e) => {
          setErr(null);
          try {
            await api(`/tasks/${task.id}`, { method: "PATCH", json: { done: e.target.checked } });
            onChange();
          } catch (ex) {
            setErr(`${t("task.toggle_failed")}: ${errMsg(ex)}`);
          }
        }}
        aria-label={t("task.done", { title: task.title })}
        style={{ marginTop: 3 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ textDecoration: task.done ? "line-through" : undefined, fontSize: dense ? 12 : 13, overflowWrap: "anywhere" }}>{task.title}</div>
        {(due || (showList && list && list.id !== "inbox") || task.notes || err) && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
            {due ? (
              <Chip tone={due.tone} style={{ fontSize: "var(--fs-meta)" }}>
                <Icon name="calendar" size={10} /> {due.text}
              </Chip>
            ) : null}
            {showList && list && list.id !== "inbox" ? <Chip style={{ fontSize: "var(--fs-meta)", borderColor: list.color ?? undefined }}>{list.name}</Chip> : null}
            {task.notes ? <span className="soft" style={{ fontSize: "var(--fs-meta)" }}>{task.notes}</span> : null}
            <ErrorLine msg={err} />
          </div>
        )}
      </div>
    </div>
  );
}

function QuickAdd({ listId, onAdded, placeholder }: { listId: string; onAdded: () => void; placeholder?: string }) {
  const api = useModuleApi();
  const t = useT();
  const { timezone } = useModule();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      // "buy milk !tomorrow" / "!today" / "!2026-12-24" shortcuts
      let text = title.trim();
      let due: string | null = null;
      const m = text.match(/\s!(today|tomorrow|\d{4}-\d{2}-\d{2})$/i);
      if (m) {
        text = text.slice(0, m.index).trim();
        const word = m[1]!.toLowerCase();
        due = word === "today" ? todayKey(timezone) : word === "tomorrow" ? keyOf(addDays(todayKey(timezone), 1)) : word;
      }
      await api("/tasks", { method: "POST", json: { title: text, listId, due } });
      setTitle("");
      onAdded();
    } catch (ex) {
      // keep the input so nothing typed gets lost
      setErr(t("quickadd.failed", { error: errMsg(ex) }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <Input value={title} onChange={(e) => { setTitle(e.target.value); if (err) setErr(null); }} placeholder={placeholder ?? t("quickadd.placeholder")} aria-invalid={err ? true : undefined} style={{ padding: "4px 8px" }} />
        <Button type="submit" size="sm" loading={busy} disabled={!title.trim()} aria-label={t("common.add")}>
          <Icon name="plus" size={12} />
        </Button>
      </div>
      <ErrorLine msg={err} />
    </form>
  );
}

/* ---------- widgets ---------- */

function ListWidget({ config }: WidgetProps<{ listId?: string; showDone?: boolean; quickAdd?: boolean }>) {
  const t = useT();
  const listId = config.listId || "inbox";
  const q = useTasks(`?list=${encodeURIComponent(listId)}${config.showDone ? "&done=1" : ""}`);
  const open = (q.data ?? []).filter((x) => !x.done).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 6 }}>
      <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {q.loading && !q.data ? (
          <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>
        ) : q.error ? (
          <span style={{ color: "var(--dnd)", fontSize: 12 }}>{q.error.message}</span>
        ) : (q.data ?? []).length === 0 ? (
          <div className="empty" style={{ padding: 12 }}>
            <span className="pixel">{t("widget.list.empty")}</span>
          </div>
        ) : (
          (q.data ?? []).map((x) => <TaskRow key={x.id} t={x} onChange={q.refetch} dense />)
        )}
      </div>
      {config.quickAdd !== false ? <QuickAdd listId={listId} onAdded={q.refetch} /> : null}
      <div className="soft" style={{ fontSize: "var(--fs-meta)", textAlign: "right" }}>{t("widget.list.open", { count: open })}</div>
    </div>
  );
}

function TodayWidget() {
  const t = useT();
  const q = useTasks("?scope=today");
  const lists = useModuleQuery<List[]>("/lists", { refetchOn: ["changed"] });
  return (
    <div className="scroll-y" style={{ height: "100%" }}>
      {q.loading && !q.data ? (
        <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>
      ) : (q.data ?? []).length === 0 ? (
        <div className="empty" style={{ padding: 12 }}>
          <span className="pixel">{t("widget.today.empty")}</span>
          {t("widget.today.enjoy")}
        </div>
      ) : (
        (q.data ?? []).map((x) => <TaskRow key={x.id} t={x} onChange={q.refetch} dense showList lists={lists.data} />)
      )}
    </div>
  );
}

/* ---------- page ---------- */

function TasksPage(_props: PageProps) {
  const api = useModuleApi();
  const t = useT();
  const lists = useModuleQuery<List[]>("/lists", { refetchOn: ["changed"] });
  const [listId, setListId] = useState("inbox");
  const [showDone, setShowDone] = useState(false);
  const q = useTasks(`?list=${encodeURIComponent(listId)}${showDone ? "&done=1" : ""}`);
  const [editing, setEditing] = useState<Task | null>(null);
  const [newList, setNewList] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deletingList, setDeletingList] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const current = lists.data?.find((l) => l.id === listId);
  useEffect(() => {
    if (lists.data && !lists.data.some((l) => l.id === listId)) setListId("inbox");
  }, [lists.data, listId]);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (ex) {
      setErr(errMsg(ex));
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 220px) minmax(0, 1fr)", gap: 14, alignItems: "start" }} className="todo-page">
      <style>{`@media (max-width: 760px) { .todo-page { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
      <Window title={t("page.lists")} right={<Button icon size="sm" variant="ghost" onClick={() => setNewList(true)} aria-label={t("page.new_list")}><Icon name="plus" size={12} /></Button>} tight>
        <div style={{ display: "flex", flexDirection: "column", padding: 6 }}>
          {(lists.data ?? []).map((l) => (
            <button key={l.id} type="button" className="nav-item" aria-current={l.id === listId ? "page" : undefined} onClick={() => setListId(l.id)} style={{ justifyContent: "space-between" }}>
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <i className="status-dot" style={{ background: l.color ?? "var(--line)", borderWidth: 0, width: 8, height: 8 }} />
                {l.name}
              </span>
              {l.open ? <Chip style={{ fontSize: "var(--fs-meta)" }}>{l.open}</Chip> : null}
            </button>
          ))}
        </div>
      </Window>
      <Window
        title={current?.name ?? t("page.tasks")}
        right={
          <>
            <Checkbox checked={showDone} onChange={(e) => setShowDone(e.target.checked)} label={<span style={{ fontSize: "var(--fs-meta)" }}>{t("page.show_done")}</span>} />
            <Menu
              trigger={<Button icon size="sm" variant="ghost" aria-label={t("page.list_menu")}><Icon name="more-vertical" size={12} /></Button>}
              items={[
                { label: t("menu.clear_completed"), icon: "check-double", onSelect: () => run(async () => { await api("/tasks/clear-done", { method: "POST", json: { listId } }); q.refetch(); }) },
                { label: t("menu.rename"), icon: "sliders", disabled: listId === "inbox", onSelect: () => setRenaming(true) },
                { sep: true, label: "" },
                { label: t("menu.delete"), icon: "trash", danger: true, disabled: listId === "inbox", onSelect: () => setDeletingList(true) },
              ]}
            />
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <QuickAdd listId={listId} onAdded={q.refetch} placeholder={t("quickadd.placeholder_tip")} />
          <ErrorLine msg={err} />
          {(q.data ?? []).length === 0 ? (
            <Empty icon="checkbox-on" title={t("page.empty.title")}>{t("page.empty.body")}</Empty>
          ) : (
            (q.data ?? []).map((x) => (
              <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TaskRow t={x} onChange={q.refetch} />
                </div>
                <Button icon size="sm" variant="ghost" onClick={() => setEditing(x)} aria-label={t("common.edit")}><Icon name="sliders" size={12} /></Button>
              </div>
            ))
          )}
        </div>
      </Window>
      <TaskModal task={editing} lists={lists.data ?? []} onClose={() => setEditing(null)} onSaved={q.refetch} />
      <NewListModal open={newList} onClose={() => setNewList(false)} onCreated={(id) => { setListId(id); lists.refetch(); }} />
      <RenameListModal open={renaming} list={current ?? null} onClose={() => setRenaming(false)} onSaved={() => lists.refetch()} />
      <Modal open={deletingList} onClose={() => setDeletingList(false)} title={t("menu.delete")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 13 }}>{t("menu.delete_confirm", { name: current?.name ?? "" })}</span>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setDeletingList(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => { setDeletingList(false); run(async () => { await api(`/lists/${listId}`, { method: "DELETE" }); setListId("inbox"); }); }}><Icon name="trash" size={12} /> {t("common.delete")}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function RenameListModal({ open, list, onClose, onSaved }: { open: boolean; list: List | null; onClose: () => void; onSaved: () => void }) {
  const api = useModuleApi();
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(list?.name ?? "");
      setErr(null);
    }
  }, [open, list]);
  if (!list) return null;
  return (
    <Modal open={open} onClose={onClose} title={t("menu.rename")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          api(`/lists/${list.id}`, { method: "PATCH", json: { name } })
            .then(() => {
              onSaved();
              onClose();
            })
            .catch((ex) => setErr(t("modal.save_failed", { error: errMsg(ex) })))
            .finally(() => setBusy(false));
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <Field label={t("menu.rename_prompt")}><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={200} /></Field>
        <ErrorLine msg={err} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>{t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}

function TaskModal({ task, lists, onClose, onSaved }: { task: Task | null; lists: List[]; onClose: () => void; onSaved: () => void }) {
  const api = useModuleApi();
  const t = useT();
  const { timezone } = useModule();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [due, setDue] = useState("");
  const [listId, setListId] = useState("inbox");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setNotes(task.notes ?? "");
      setDue(task.due ? task.due.slice(0, 10) : "");
      setListId(task.list_id);
      setErr(null);
    }
  }, [task]);
  if (!task) return null;
  const attempt = (key: "modal.save_failed" | "modal.delete_failed", fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    fn()
      .then(() => {
        onSaved();
        onClose();
      })
      .catch((ex) => setErr(t(key, { error: errMsg(ex) })))
      .finally(() => setBusy(false));
  };
  return (
    <Modal open onClose={onClose} title={t("modal.edit_task")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          attempt("modal.save_failed", () => api(`/tasks/${task.id}`, { method: "PATCH", json: { title, notes: notes || null, due: due || null, listId } }));
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <Field label={t("field.title")}><Input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus maxLength={200} /></Field>
        <Field label={t("field.notes")}><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={10000} /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label={t("field.due")}><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} min={todayKey(timezone)} /></Field>
          <Field label={t("field.list")}>
            <Select value={listId} onChange={(e) => setListId(e.target.value)}>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
        </div>
        <ErrorLine msg={err} />
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <Button variant="danger" disabled={busy} onClick={() => attempt("modal.delete_failed", () => api(`/tasks/${task.id}`, { method: "DELETE" }))}><Icon name="trash" size={12} /> {t("common.delete")}</Button>
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" loading={busy}>{t("common.save")}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function NewListModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const api = useModuleApi();
  const t = useT();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#e2789b");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title={t("modal.new_list")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          api<{ id: string }>("/lists", { method: "POST", json: { name, color } })
            .then((l) => {
              setName("");
              onCreated(l.id);
              onClose();
            })
            .catch((ex) => setErr(t("modal.create_failed", { error: errMsg(ex) })))
            .finally(() => setBusy(false));
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <Field label={t("field.name")}><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={200} /></Field>
        <Field label={t("field.color")}>
          <div style={{ display: "flex", gap: 6 }}>
            {["#e2789b", "#8b7fd6", "#4fc47f", "#f0b232", "#f23f43", "#4f93d6", "#9a9a9a"].map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} className={cx("btn btn-icon")} style={{ background: c, borderColor: c === color ? "var(--ink)" : c, boxShadow: "none" }} />
            ))}
          </div>
        </Field>
        <ErrorLine msg={err} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>{t("common.create")}</Button>
        </div>
      </form>
    </Modal>
  );
}

// keep the module's event hook referenced so bundlers don't tree-shake the import path (and as a usage example)
function useChanged(cb: () => void) {
  useModuleEvents("changed", cb);
}
void useChanged;
void useMemo;

export default defineClient({
  widgets: { list: ListWidget, today: TodayWidget },
  pages: { tasks: TasksPage },
});
