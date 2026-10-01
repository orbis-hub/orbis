import { useState } from "react";
import { defineClient, useModuleApi, useModuleQuery, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Modal, Window } from "@orbis/ui";
import type { PersonView } from "./server";

const when = (d: number) => (d === 0 ? "today 🎂" : d === 1 ? "tomorrow" : d < 7 ? `in ${d} days` : d < 60 ? `in ${Math.round(d / 7)} weeks` : `in ${Math.round(d / 30)} months`);
const fmt = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long" });

function UpcomingWidget({ config }: WidgetProps<{ count?: number; showAge?: boolean }>) {
  const q = useModuleQuery<PersonView[]>("/people", { refetchOn: ["changed"], intervalMs: 60 * 60_000 });
  const list = (q.data ?? []).slice(0, config.count ?? 5);
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  if (!list.length) return <Empty icon="cake" title="nobody yet">add people on the birthdays page.</Empty>;
  return (
    <div className="scroll-y" style={{ height: "100%" }}>
      {list.map((p) => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px dashed var(--line)", color: p.daysUntil === 0 ? "var(--accent)" : undefined }}>
          <Icon name={p.daysUntil === 0 ? "cake" : "gift"} size={14} style={{ flex: "none", color: p.daysUntil <= 7 ? "var(--accent)" : "var(--ink-soft)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}{config.showAge !== false && p.turns ? <span className="soft"> · turns {p.turns}</span> : null}</div>
            <div className="soft" style={{ fontSize: 10 }}>{fmt(p.next)} · {when(p.daysUntil)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PeoplePage(_p: PageProps) {
  const api = useModuleApi();
  const q = useModuleQuery<PersonView[]>("/people", { refetchOn: ["changed"] });
  const [editing, setEditing] = useState<Partial<PersonView> | null>(null);
  const save = async (p: Partial<PersonView>) => {
    if (p.id) await api(`/people/${p.id}`, { method: "PATCH", json: { name: p.name, date: p.date, note: p.note ?? null } });
    else await api("/people", { method: "POST", json: { name: p.name, date: p.date, note: p.note } });
    setEditing(null);
    q.refetch();
  };
  const list = q.data ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button onClick={() => setEditing({})}><Icon name="user-plus" size={12} /> person</Button>
        <span className="soft" style={{ fontSize: 11 }}>you get a nudge a week before and on the day (bell / your channels).</span>
      </div>
      {list.length === 0 ? <Empty icon="cake" title="nobody yet" /> : null}
      <Window tight>
        {list.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px dashed var(--line)", fontSize: 12 }}>
            <Icon name={p.daysUntil === 0 ? "cake" : "gift"} size={16} style={{ color: p.daysUntil <= 7 ? "var(--accent)" : "var(--ink-soft)", flex: "none" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 13 }}>{p.name}</span>
                {p.turns ? <Chip style={{ fontSize: 10 }}>turns {p.turns}</Chip> : null}
                {p.daysUntil === 0 ? <Chip tone="accent" style={{ fontSize: 10 }}>today</Chip> : null}
              </div>
              <div className="soft" style={{ fontSize: 11 }}>{fmt(p.next)} · {when(p.daysUntil)}{p.note ? ` · ${p.note}` : ""}</div>
            </div>
            <Button icon size="sm" variant="ghost" onClick={() => setEditing(p)} aria-label="edit"><Icon name="edit" size={12} /></Button>
            <Button icon size="sm" variant="ghost" onClick={() => confirm(`remove ${p.name}?`) && api(`/people/${p.id}`, { method: "DELETE" }).then(() => q.refetch())} aria-label="remove"><Icon name="trash" size={12} /></Button>
          </div>
        ))}
      </Window>
      {editing ? <EditModal p={editing} onClose={() => setEditing(null)} onSave={save} /> : null}
    </div>
  );
}

function EditModal({ p, onClose, onSave }: { p: Partial<PersonView>; onClose: () => void; onSave: (p: Partial<PersonView>) => Promise<void> }) {
  const [v, setV] = useState<Partial<PersonView>>({ name: "", date: "", note: "", ...p });
  const [knowYear, setKnowYear] = useState(!p.date || /^\d{4}/.test(p.date));
  return (
    <Modal open onClose={onClose} title={p.id ? "edit" : "new person"}>
      <form onSubmit={(e) => { e.preventDefault(); void onSave(v); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="name"><Input value={v.name ?? ""} onChange={(e) => setV({ ...v, name: e.target.value })} required autoFocus /></Field>
        <label className="check" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={knowYear} onChange={(e) => { setKnowYear(e.target.checked); setV({ ...v, date: "" }); }} />
          <i aria-hidden />
          <span>i know the birth year</span>
        </label>
        <Field label={knowYear ? "birthday" : "day and month"} hint={knowYear ? undefined : "MM-DD, e.g. 03-14"}>
          {knowYear ? <Input type="date" value={v.date ?? ""} onChange={(e) => setV({ ...v, date: e.target.value })} required /> : <Input value={v.date ?? ""} onChange={(e) => setV({ ...v, date: e.target.value })} placeholder="03-14" pattern="\d{2}-\d{2}" required />}
        </Field>
        <Field label="note" hint="gift ideas, allergies, the tea they like"><Input value={v.note ?? ""} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>cancel</Button>
          <Button type="submit" variant="primary">save</Button>
        </div>
      </form>
    </Modal>
  );
}

export default defineClient({ widgets: { upcoming: UpcomingWidget }, pages: { people: PeoplePage } });
