import { useState } from "react";
import { defineClient, useModuleApi, useModuleQuery, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Checkbox, Chip, Empty, Field, Icon, Input, Modal, Window, cx } from "@orbis/ui";
import type { HabitWithStats } from "./server";

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function useHabits(days = 400) {
  return useModuleQuery<HabitWithStats[]>(`/habits?days=${days}`, { refetchOn: ["changed"] });
}

/** contribution-style grid: columns = weeks (monday first), rows = weekdays */
function HabitGrid({ h, weeks, cell = 10, onToggle }: { h: HabitWithStats; weeks: number; cell?: number; onToggle?: (day: string) => void }) {
  const set = new Set(h.days);
  const today = new Date();
  const end = new Date(today);
  const dow = (end.getDay() + 6) % 7; // monday = 0
  const start = new Date(end);
  start.setDate(end.getDate() - dow - (weeks - 1) * 7);
  const cols: Date[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: Date[] = [];
    for (let d = 0; d < 7; d++) {
      const x = new Date(start);
      x.setDate(start.getDate() + w * 7 + d);
      col.push(x);
    }
    cols.push(col);
  }
  const gap = Math.max(1, Math.round(cell / 5));
  return (
    <div style={{ display: "flex", gap, overflow: "hidden" }}>
      {cols.map((col, wi) => (
        <div key={wi} style={{ display: "flex", flexDirection: "column", gap }}>
          {col.map((d) => {
            const k = dayKey(d);
            const future = d > today;
            const on = set.has(k);
            return (
              <button
                key={k}
                type="button"
                title={`${k}${on ? " ✓" : ""}`}
                disabled={future || !onToggle}
                onClick={() => onToggle?.(k)}
                style={{ width: cell, height: cell, padding: 0, border: `1px solid ${future ? "transparent" : "var(--line)"}`, background: on ? h.color : future ? "transparent" : "var(--paper-2)", opacity: future ? 0.3 : 1, cursor: onToggle && !future ? "pointer" : "default", outline: k === dayKey(today) ? "1px solid var(--ink)" : undefined }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function TodayWidget({ config, size }: WidgetProps<{ showStreak?: boolean }>) {
  const api = useModuleApi();
  const q = useHabits(1);
  const list = q.data ?? [];
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  if (!list.length) return <Empty icon="check-double" title="no habits yet">add some on the habits page.</Empty>;
  const done = list.filter((h) => h.doneToday).length;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {list.map((h) => (
          <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: size.height < 140 ? "1px 0" : "3px 0", borderBottom: "1px dashed var(--line)" }}>
            <Checkbox checked={h.doneToday} onChange={() => void api("/toggle", { method: "POST", json: { habitId: h.id } }).then(() => q.refetch())} label={<span style={{ fontSize: 13, textDecoration: h.doneToday ? "line-through" : undefined, opacity: h.doneToday ? 0.6 : 1 }}>{h.name}</span>} />
            <span style={{ flex: 1 }} />
            {config.showStreak !== false && h.streak > 0 ? <Chip style={{ fontSize: 10, borderColor: h.color }}>{h.streak}d</Chip> : null}
          </div>
        ))}
      </div>
      <div className="progress"><i style={{ width: `${(done / list.length) * 100}%` }} /></div>
      <div className="soft" style={{ fontSize: 10, textAlign: "right" }}>{done}/{list.length} today</div>
    </div>
  );
}

function GridWidget({ config, size }: WidgetProps<{ habitId?: string; weeks?: number }>) {
  const api = useModuleApi();
  const q = useHabits();
  const h = (config.habitId ? q.data?.find((x) => x.id === config.habitId) : q.data?.[0]) ?? null;
  if (!h) return <Empty icon="check-double" title={q.loading ? "loading…" : "no habit"} />;
  const weeks = config.weeks ?? 12;
  const cell = Math.max(5, Math.min(14, Math.floor((size.width - 8) / weeks) - 2, Math.floor((size.height - 40) / 7) - 2));
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 6, justifyContent: "center" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><i style={{ width: 10, height: 10, background: h.color, display: "inline-block" }} /> {h.name}</span>
        <span className="soft">{h.streak}d streak · {h.last30}/30</span>
      </div>
      <HabitGrid h={h} weeks={weeks} cell={cell} onToggle={(day) => void api("/toggle", { method: "POST", json: { habitId: h.id, day } }).then(() => q.refetch())} />
    </div>
  );
}

function HabitsPage(_p: PageProps) {
  const api = useModuleApi();
  const q = useHabits();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#e2789b");
  const [target, setTarget] = useState(7);
  const list = q.data ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button onClick={() => setAdding(true)}><Icon name="plus" size={12} /> habit</Button>
        <span className="soft" style={{ fontSize: 11 }}>click a square to toggle a past day.</span>
      </div>
      {list.length === 0 ? <Empty icon="check-double" title="no habits yet">start small: one or two.</Empty> : null}
      {list.map((h) => (
        <Window
          key={h.id}
          title={<span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><i style={{ width: 10, height: 10, background: h.color, display: "inline-block" }} /> {h.name}</span>}
          right={
            <>
              <Chip style={{ fontSize: 10 }}>{h.streak}d streak</Chip>
              <Chip style={{ fontSize: 10 }}>{h.last30}/30 days</Chip>
              <Chip style={{ fontSize: 10 }}>target {h.target_per_week}/week</Chip>
              <Button icon size="sm" variant="ghost" aria-label="delete" onClick={() => { if (confirm(`delete "${h.name}" and its history?`)) api(`/habits/${h.id}`, { method: "DELETE" }).then(() => q.refetch()); }}><Icon name="trash" size={12} /></Button>
            </>
          }
        >
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <Button variant={h.doneToday ? "default" : "primary"} onClick={() => void api("/toggle", { method: "POST", json: { habitId: h.id } }).then(() => q.refetch())}>
              <Icon name={h.doneToday ? "check" : "square"} size={14} /> {h.doneToday ? "done today" : "mark today"}
            </Button>
            <div className="scroll-x" style={{ flex: 1, minWidth: 0 }}>
              <HabitGrid h={h} weeks={26} cell={11} onToggle={(day) => void api("/toggle", { method: "POST", json: { habitId: h.id, day } }).then(() => q.refetch())} />
            </div>
          </div>
        </Window>
      ))}
      <Modal open={adding} onClose={() => setAdding(false)} title="new habit">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await api("/habits", { method: "POST", json: { name, color, targetPerWeek: target } });
            setName("");
            setAdding(false);
            q.refetch();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <Field label="name"><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="drink water, read 10 pages, walk" /></Field>
          <Field label="color">
            <div style={{ display: "flex", gap: 6 }}>
              {["#e2789b", "#8b7fd6", "#4fc47f", "#f0b232", "#f23f43", "#4f93d6", "#2f9fbf", "#d9702e"].map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} className={cx("btn btn-icon")} style={{ background: c, borderColor: c === color ? "var(--ink)" : c, boxShadow: "none" }} />
              ))}
            </div>
          </Field>
          <Field label="target per week" hint="7 = every day">
            <Input type="number" min={1} max={7} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setAdding(false)}>cancel</Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>add</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default defineClient({
  widgets: { today: TodayWidget, grid: GridWidget },
  pages: { habits: HabitsPage },
});
