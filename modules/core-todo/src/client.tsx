import { useEffect, useMemo, useState, type FormEvent } from "react";
import { defineClient, useModuleApi, useModuleEvents, useModuleQuery, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Checkbox, Chip, Empty, Icon, Input, Menu, Modal, Field, Select, Window, cx } from "@orbis/ui";

type List = { id: string; name: string; color: string | null; sort: number; open: number };
type Task = { id: string; list_id: string; title: string; notes: string | null; done: number; due: string | null; sort: number; created_at: string; done_at: string | null };

const todayKey = () => new Date().toISOString().slice(0, 10);
function dueLabel(due: string | null) {
  if (!due) return null;
  const d = new Date(due);
  const t = new Date();
  const dayDiff = Math.round((new Date(d.toDateString()).getTime() - new Date(t.toDateString()).getTime()) / 86400_000);
  if (dayDiff < 0) return { text: dayDiff === -1 ? "yesterday" : `${-dayDiff}d overdue`, tone: "bad" as const };
  if (dayDiff === 0) return { text: "today", tone: "accent" as const };
  if (dayDiff === 1) return { text: "tomorrow", tone: undefined };
  if (dayDiff < 7) return { text: d.toLocaleDateString(undefined, { weekday: "short" }), tone: undefined };
  return { text: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), tone: undefined };
}

function useTasks(query: string) {
  const q = useModuleQuery<Task[]>(`/tasks${query}`, { refetchOn: ["changed"] });
  return q;
}

function TaskRow({ t, onChange, dense, showList, lists }: { t: Task; onChange: () => void; dense?: boolean; showList?: boolean; lists?: List[] }) {
  const api = useModuleApi();
  const due = dueLabel(t.due);
  const list = lists?.find((l) => l.id === t.list_id);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: dense ? "3px 0" : "5px 0", borderBottom: "1px dashed var(--line)", opacity: t.done ? 0.55 : 1 }}>
      <Checkbox
        checked={!!t.done}
        onChange={async (e) => {
          await api(`/tasks/${t.id}`, { method: "PATCH", json: { done: e.target.checked } });
          onChange();
        }}
        aria-label={`done: ${t.title}`}
        style={{ marginTop: 3 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ textDecoration: t.done ? "line-through" : undefined, fontSize: dense ? 12 : 13, overflowWrap: "anywhere" }}>{t.title}</div>
        {(due || (showList && list && list.id !== "inbox") || t.notes) && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
            {due ? (
              <Chip tone={due.tone} style={{ fontSize: 10 }}>
                <Icon name="calendar" size={10} /> {due.text}
              </Chip>
            ) : null}
            {showList && list && list.id !== "inbox" ? <Chip style={{ fontSize: 10, borderColor: list.color ?? undefined }}>{list.name}</Chip> : null}
            {t.notes ? <span className="soft" style={{ fontSize: 10 }}>{t.notes}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function QuickAdd({ listId, onAdded, placeholder = "add a task…" }: { listId: string; onAdded: () => void; placeholder?: string }) {
  const api = useModuleApi();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      // "buy milk !tomorrow" / "!today" shortcuts
      let t = title.trim();
      let due: string | null = null;
      const m = t.match(/\s!(today|tomorrow|\d{4}-\d{2}-\d{2})$/i);
      if (m) {
        t = t.slice(0, m.index).trim();
        const d = new Date();
        if (m[1]!.toLowerCase() === "tomorrow") d.setDate(d.getDate() + 1);
        due = m[1]!.match(/^\d{4}/) ? new Date(m[1]!).toISOString() : new Date(d.toDateString()).toISOString();
      }
      await api("/tasks", { method: "POST", json: { title: t, listId, due } });
      setTitle("");
      onAdded();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 6 }}>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={placeholder} style={{ padding: "4px 8px" }} />
      <Button type="submit" size="sm" loading={busy} disabled={!title.trim()} aria-label="add">
        <Icon name="plus" size={12} />
      </Button>
    </form>
  );
}

/* ---------- widgets ---------- */

function ListWidget({ config }: WidgetProps<{ listId?: string; showDone?: boolean; quickAdd?: boolean }>) {
  const listId = config.listId || "inbox";
  const q = useTasks(`?list=${encodeURIComponent(listId)}${config.showDone ? "&done=1" : ""}`);
  const open = (q.data ?? []).filter((t) => !t.done).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 6 }}>
      <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {q.loading && !q.data ? (
          <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>
        ) : q.error ? (
          <span style={{ color: "var(--dnd)", fontSize: 12 }}>{q.error.message}</span>
        ) : (q.data ?? []).length === 0 ? (
          <div className="empty" style={{ padding: 12 }}>
            <span className="pixel">all clear ✓</span>
          </div>
        ) : (
          (q.data ?? []).map((t) => <TaskRow key={t.id} t={t} onChange={q.refetch} dense />)
        )}
      </div>
      {config.quickAdd !== false ? <QuickAdd listId={listId} onAdded={q.refetch} /> : null}
      <div className="soft" style={{ fontSize: 10, textAlign: "right" }}>{open} open</div>
    </div>
  );
}

function TodayWidget() {
  const q = useTasks("?scope=today");
  const lists = useModuleQuery<List[]>("/lists", { refetchOn: ["changed"] });
  return (
    <div className="scroll-y" style={{ height: "100%" }}>
      {q.loading && !q.data ? (
        <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>
      ) : (q.data ?? []).length === 0 ? (
        <div className="empty" style={{ padding: 12 }}>
          <span className="pixel">nothing due today</span>
          enjoy ☕
        </div>
      ) : (
        (q.data ?? []).map((t) => <TaskRow key={t.id} t={t} onChange={q.refetch} dense showList lists={lists.data} />)
      )}
    </div>
  );
}

/* ---------- page ---------- */

function TasksPage(_props: PageProps) {
  const api = useModuleApi();
  const lists = useModuleQuery<List[]>("/lists", { refetchOn: ["changed"] });
  const [listId, setListId] = useState("inbox");
  const [showDone, setShowDone] = useState(false);
  const q = useTasks(`?list=${encodeURIComponent(listId)}${showDone ? "&done=1" : ""}`);
  const [editing, setEditing] = useState<Task | null>(null);
  const [newList, setNewList] = useState(false);
  const current = lists.data?.find((l) => l.id === listId);
  useEffect(() => {
    if (lists.data && !lists.data.some((l) => l.id === listId)) setListId("inbox");
  }, [lists.data, listId]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 220px) minmax(0, 1fr)", gap: 14, alignItems: "start" }} className="todo-page">
      <style>{`@media (max-width: 760px) { .todo-page { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
      <Window title="lists" right={<Button icon size="sm" variant="ghost" onClick={() => setNewList(true)} aria-label="new list"><Icon name="plus" size={12} /></Button>} tight>
        <div style={{ display: "flex", flexDirection: "column", padding: 6 }}>
          {(lists.data ?? []).map((l) => (
            <button key={l.id} type="button" className="nav-item" aria-current={l.id === listId ? "page" : undefined} onClick={() => setListId(l.id)} style={{ justifyContent: "space-between" }}>
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <i className="status-dot" style={{ background: l.color ?? "var(--line)", borderWidth: 0, width: 8, height: 8 }} />
                {l.name}
              </span>
              {l.open ? <Chip style={{ fontSize: 10 }}>{l.open}</Chip> : null}
            </button>
          ))}
        </div>
      </Window>
      <Window
        title={current?.name ?? "tasks"}
        right={
          <>
            <Checkbox checked={showDone} onChange={(e) => setShowDone(e.target.checked)} label={<span style={{ fontSize: 11 }}>show done</span>} />
            <Menu
              trigger={<Button icon size="sm" variant="ghost" aria-label="list menu"><Icon name="more-vertical" size={12} /></Button>}
              items={[
                { label: "clear completed", icon: "check-double", onSelect: async () => { await api("/tasks/clear-done", { method: "POST", json: { listId } }); q.refetch(); } },
                { label: "rename list", icon: "edit", disabled: listId === "inbox", onSelect: async () => { const name = prompt("list name", current?.name); if (name) await api(`/lists/${listId}`, { method: "PATCH", json: { name } }); } },
                { sep: true, label: "" },
                { label: "delete list", icon: "trash", danger: true, disabled: listId === "inbox", onSelect: async () => { if (confirm(`delete "${current?.name}" and all its tasks?`)) { await api(`/lists/${listId}`, { method: "DELETE" }); setListId("inbox"); } } },
              ]}
            />
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <QuickAdd listId={listId} onAdded={q.refetch} placeholder="add a task… (tip: end with !today or !tomorrow)" />
          {(q.data ?? []).length === 0 ? (
            <Empty icon="checkbox-on" title="nothing here">add a task above.</Empty>
          ) : (
            (q.data ?? []).map((t) => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TaskRow t={t} onChange={q.refetch} />
                </div>
                <Button icon size="sm" variant="ghost" onClick={() => setEditing(t)} aria-label="edit"><Icon name="edit" size={12} /></Button>
              </div>
            ))
          )}
        </div>
      </Window>
      <TaskModal task={editing} lists={lists.data ?? []} onClose={() => setEditing(null)} onSaved={q.refetch} />
      <NewListModal open={newList} onClose={() => setNewList(false)} onCreated={(id) => { setListId(id); lists.refetch(); }} />
    </div>
  );
}

function TaskModal({ task, lists, onClose, onSaved }: { task: Task | null; lists: List[]; onClose: () => void; onSaved: () => void }) {
  const api = useModuleApi();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [due, setDue] = useState("");
  const [listId, setListId] = useState("inbox");
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setNotes(task.notes ?? "");
      setDue(task.due ? task.due.slice(0, 10) : "");
      setListId(task.list_id);
    }
  }, [task]);
  if (!task) return null;
  return (
    <Modal open onClose={onClose} title="edit task">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await api(`/tasks/${task.id}`, { method: "PATCH", json: { title, notes: notes || null, due: due ? new Date(due).toISOString() : null, listId } });
          onSaved();
          onClose();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <Field label="title"><Input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus /></Field>
        <Field label="notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="due"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} min={todayKey()} /></Field>
          <Field label="list">
            <Select value={listId} onChange={(e) => setListId(e.target.value)}>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <Button variant="danger" onClick={async () => { await api(`/tasks/${task.id}`, { method: "DELETE" }); onSaved(); onClose(); }}><Icon name="trash" size={12} /> delete</Button>
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={onClose}>cancel</Button>
            <Button type="submit" variant="primary">save</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function NewListModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const api = useModuleApi();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#e2789b");
  return (
    <Modal open={open} onClose={onClose} title="new list">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const l = await api<{ id: string }>("/lists", { method: "POST", json: { name, color } });
          setName("");
          onCreated(l.id);
          onClose();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <Field label="name"><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></Field>
        <Field label="color">
          <div style={{ display: "flex", gap: 6 }}>
            {["#e2789b", "#8b7fd6", "#4fc47f", "#f0b232", "#f23f43", "#4f93d6", "#9a9a9a"].map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} className={cx("btn btn-icon")} style={{ background: c, borderColor: c === color ? "var(--ink)" : c, boxShadow: "none" }} />
            ))}
          </div>
        </Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>create</Button>
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
