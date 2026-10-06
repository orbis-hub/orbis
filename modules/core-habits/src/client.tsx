import { useEffect, useState, type FormEvent } from "react";
import { defineClient, useModuleApi, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Checkbox, Chip, Empty, Field, Icon, Input, Modal, Select, Window, cx } from "@orbis/ui";
import type { HabitKind, HabitWithStats } from "./server";

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const PALETTE = ["#e2789b", "#8b7fd6", "#4fc47f", "#f0b232", "#f23f43", "#4f93d6", "#2f9fbf", "#d9702e"];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "#4fc47f" + 0.4 → rgba(...) so partial days of a count habit show as a lighter cell */
function withAlpha(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
const targetOf = (h: HabitWithStats) => (h.kind === "count" ? h.target_per_day : 1);
/** gap between grid cells for a cell size (8px → 2, 14px → 3) */
const gapFor = (cell: number) => Math.max(1, Math.round(cell / 5));
const MIN_CELL = 8;
const MAX_CELL = 14;

function useHabits(days = 400) {
  return useModuleQuery<HabitWithStats[]>(`/habits?days=${days}`, { refetchOn: ["changed"] });
}

/** contribution-style grid: columns = weeks (monday first), rows = weekdays; cell intensity = count / target */
function HabitGrid({ h, weeks, cell = 10, onToggle }: { h: HabitWithStats; weeks: number; cell?: number; onToggle?: (day: string) => void }) {
  const done = new Set(h.days);
  const target = targetOf(h);
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
  const gap = gapFor(cell);
  return (
    <div style={{ display: "flex", gap, overflow: "hidden", flex: "none" }}>
      {cols.map((col, wi) => (
        <div key={wi} style={{ display: "flex", flexDirection: "column", gap }}>
          {col.map((d) => {
            const k = dayKey(d);
            const future = d > today;
            const count = h.counts[k] ?? 0;
            const on = done.has(k);
            const ratio = on ? 1 : Math.min(1, count / target);
            const bg = future ? "transparent" : ratio > 0 ? (ratio >= 1 ? h.color : withAlpha(h.color, 0.25 + ratio * 0.6)) : "var(--paper-2)";
            return (
              <button
                key={k}
                type="button"
                title={h.kind === "count" ? `${k} ${count}/${target}` : `${k}${on ? " ✓" : ""}`}
                disabled={future || !onToggle}
                onClick={() => onToggle?.(k)}
                style={{ width: cell, height: cell, padding: 0, border: `1px solid ${future ? "transparent" : "var(--line)"}`, background: bg, opacity: future ? 0.3 : 1, cursor: onToggle && !future ? "pointer" : "default", outline: k === dayKey(today) ? "1px solid var(--ink)" : undefined }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** `3 / 8` + bar + "+" for count habits; a checkbox for check habits */
function TodayControl({ h, dense, onDone }: { h: HabitWithStats; dense?: boolean; onDone: () => void }) {
  const api = useModuleApi();
  const t = useT();
  const call = (path: string) => void api(path, { method: "POST", json: { habitId: h.id } }).then(onDone).catch(() => undefined);
  if (h.kind !== "count") {
    // the label truncates instead of wrapping under the box (.habit-check rules in TodayWidget)
    return <Checkbox className="habit-check" checked={h.doneToday} onChange={() => call("/toggle")} label={<span title={h.name} style={{ display: "block", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: h.doneToday ? "line-through" : undefined, opacity: h.doneToday ? 0.6 : 1 }}>{h.name}</span>} />;
  }
  const ratio = Math.min(1, h.todayCount / h.target_per_day);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
      <Icon name={h.doneToday ? "check" : "plus"} size={12} className={h.doneToday ? undefined : "soft"} style={{ color: h.doneToday ? h.color : undefined, flex: "none" }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span title={h.name} style={{ fontSize: 13, opacity: h.doneToday ? 0.6 : 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</span>
        {!dense ? <div className="progress" style={{ height: 4 }}><i style={{ width: `${ratio * 100}%`, background: h.color }} /></div> : null}
      </div>
      <span className="soft" style={{ fontSize: "var(--fs-meta)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{t("widget.today.count", { count: h.todayCount, target: h.target_per_day })}</span>
      <Button icon size="sm" variant={h.doneToday ? "ghost" : "default"} aria-label={t("common.plusOne")} title={t("common.plusOne")} onClick={() => call("/increment")}><Icon name="plus" size={12} /></Button>
    </div>
  );
}

function TodayWidget({ config, size }: WidgetProps<{ showStreak?: boolean }>) {
  const t = useT();
  const q = useHabits(1);
  const list = q.data ?? [];
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  if (!list.length) return <Empty icon="check-double" title={t("widget.today.empty")}>{t("widget.today.emptyHint")}</Empty>;
  const done = list.filter((h) => h.doneToday).length;
  const dense = size.height < 140;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      {/* the checkbox takes the free width and its label truncates; the streak chip keeps its size */}
      <style>{`.habit-check{flex:1;min-width:0}.habit-check>span{flex:1;min-width:0}`}</style>
      <div className="scroll-y" style={{ flex: 1, minHeight: 0, overflowX: "hidden" }}>
        {list.map((h) => (
          <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: dense ? "1px 0" : "3px 0", borderBottom: "1px dashed var(--line)", minWidth: 0 }}>
            <TodayControl h={h} dense={dense} onDone={() => void q.refetch()} />
            {config.showStreak !== false && h.streak > 0 ? <Chip style={{ fontSize: "var(--fs-meta)", borderColor: h.color, flex: "none" }}>{t("common.streakShort", { count: h.streak })}</Chip> : null}
          </div>
        ))}
      </div>
      <div className="progress"><i style={{ width: `${(done / list.length) * 100}%` }} /></div>
      <div className="soft" style={{ fontSize: "var(--fs-meta)", textAlign: "right" }}>{t("widget.today.progress", { done, total: list.length })}</div>
    </div>
  );
}

function GridWidget({ config, size }: WidgetProps<{ habitId?: string; weeks?: number }>) {
  const api = useModuleApi();
  const t = useT();
  const q = useHabits();
  const h = (config.habitId ? q.data?.find((x) => x.id === config.habitId) : q.data?.[0]) ?? null;
  if (!h) return <Empty icon="check-double" title={q.loading ? t("common.loading") : t("widget.grid.none")} />;
  const maxWeeks = config.weeks ?? 12;
  // size is 0×0 before the frame has measured itself; assume the 4×2 default (≈328×70) until then
  const w = size.width > 0 ? size.width : 328;
  const hgt = size.height > 0 ? size.height : 70;
  // header above the grid when 7 rows of 8px cells still fit under it, beside it when the widget is wide but short
  // (the 4×2 default), and only as a tooltip when it is both short and narrow
  const minGrid = 7 * MIN_CELL + 6 * gapFor(MIN_CELL);
  const header: "top" | "side" | "none" = hgt - GRID_HEADER >= minGrid ? "top" : w >= 2 * GRID_SIDE ? "side" : "none";
  const { cell, weeks } = gridFit(header === "side" ? w - GRID_SIDE - 10 : w, header === "top" ? hgt - GRID_HEADER : hgt, maxWeeks);
  const stats = t("widget.grid.stats", { streak: h.streak, last30: h.last30 });
  const grid = <HabitGrid h={h} weeks={weeks} cell={cell} onToggle={(day) => void api("/toggle", { method: "POST", json: { habitId: h.id, day } }).then(() => q.refetch())} />;
  const swatch = <i style={{ width: 10, height: 10, background: h.color, display: "inline-block", flex: "none" }} />;
  if (header === "side") {
    return (
      <div style={{ height: "100%", display: "flex", gap: 10, alignItems: "center", minWidth: 0 }} title={`${h.name} · ${stats}`}>
        <div style={{ flex: `0 1 ${GRID_SIDE}px`, minWidth: 0, display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
          <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>{swatch}<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</span></span>
          <span className="soft" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stats}</span>
        </div>
        {grid}
      </div>
    );
  }
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4, justifyContent: "center", minWidth: 0 }} title={header === "none" ? `${h.name} · ${stats}` : undefined}>
      {header === "top" ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, minWidth: 0 }}>
          <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>{swatch}<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</span></span>
          <span className="soft" style={{ flex: "none", whiteSpace: "nowrap" }}>{stats}</span>
        </div>
      ) : null}
      {grid}
    </div>
  );
}

/** name/stats line of the grid widget: ~12px text plus its gap to the grid */
const GRID_HEADER = 22;
/** width reserved for the name/stats column when it sits beside the grid */
const GRID_SIDE = 120;

/**
 * cell size from the height: the largest cell (≤14px) whose 7 weekday rows fit, never below 8px;
 * then as many weeks as the width takes (capped by the config), so narrow widgets show fewer weeks instead of smaller cells
 */
function gridFit(availW: number, availH: number, maxWeeks: number) {
  let cell = MIN_CELL;
  for (let c = MAX_CELL; c >= MIN_CELL; c--) {
    if (7 * c + 6 * gapFor(c) <= availH) {
      cell = c;
      break;
    }
  }
  const gap = gapFor(cell);
  const weeks = Math.max(1, Math.min(maxWeeks, Math.floor((availW + gap) / (cell + gap))));
  return { cell, weeks };
}

/* ---------- page ---------- */

type HabitDraft = { name: string; color: string; kind: HabitKind; targetPerDay: number; targetPerWeek: number };
const emptyDraft = (): HabitDraft => ({ name: "", color: PALETTE[0]!, kind: "check", targetPerDay: 8, targetPerWeek: 7 });

/** create + edit share one modal; `habit` null = new */
function HabitModal({ habit, open, onClose, onSaved }: { habit: HabitWithStats | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const api = useModuleApi();
  const t = useT();
  const [d, setD] = useState<HabitDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setD(habit ? { name: habit.name, color: habit.color, kind: habit.kind, targetPerDay: habit.target_per_day, targetPerWeek: habit.target_per_week } : emptyDraft());
  }, [open, habit]);
  const patch = (p: Partial<HabitDraft>) => setD((x) => ({ ...x, ...p }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const json = { name: d.name, color: d.color, kind: d.kind, targetPerDay: d.kind === "count" ? d.targetPerDay : undefined, targetPerWeek: d.targetPerWeek };
      await api(habit ? `/habits/${habit.id}` : "/habits", { method: habit ? "PATCH" : "POST", json });
      onSaved();
      onClose();
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={habit ? t("page.habits.editTitle") : t("page.habits.newTitle")}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label={t("page.habits.fieldName")}><Input value={d.name} onChange={(e) => patch({ name: e.target.value })} required autoFocus maxLength={200} placeholder={t("page.habits.namePlaceholder")} /></Field>
        <Field label={t("page.habits.fieldColor")}>
          <div style={{ display: "flex", gap: 6 }}>
            {PALETTE.map((c) => (
              <button key={c} type="button" onClick={() => patch({ color: c })} aria-label={c} aria-pressed={c === d.color} className={cx("btn btn-icon")} style={{ background: c, borderColor: c === d.color ? "var(--ink)" : c, boxShadow: "none" }} />
            ))}
          </div>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label={t("page.habits.fieldKind")}>
            <Select value={d.kind} onChange={(e) => patch({ kind: e.target.value as HabitKind })}>
              <option value="check">{t("page.habits.kindCheck")}</option>
              <option value="count">{t("page.habits.kindCount")}</option>
            </Select>
          </Field>
          {d.kind === "count" ? (
            <Field label={t("page.habits.fieldTargetPerDay")} hint={t("page.habits.targetPerDayHint")}>
              <Input type="number" min={1} max={1000} step={1} value={d.targetPerDay} onChange={(e) => patch({ targetPerDay: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
            </Field>
          ) : (
            <Field label={t("page.habits.fieldTarget")} hint={t("page.habits.targetHint")}>
              <Input type="number" min={1} max={7} step={1} value={d.targetPerWeek} onChange={(e) => patch({ targetPerWeek: Math.min(7, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
            </Field>
          )}
        </div>
        {err ? <span role="alert" style={{ color: "var(--dnd)", fontSize: "var(--fs-meta)" }}>{err}</span> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!d.name.trim()}>{habit ? t("common.save") : t("common.add")}</Button>
        </div>
      </form>
    </Modal>
  );
}

function HabitsPage(_p: PageProps) {
  const api = useModuleApi();
  const t = useT();
  const q = useHabits();
  const [modal, setModal] = useState<{ open: boolean; habit: HabitWithStats | null }>({ open: false, habit: null });
  const [deleting, setDeleting] = useState<HabitWithStats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = q.data ?? [];
  const call = (path: string, init: Parameters<typeof api>[1]) => {
    setErr(null);
    void api(path, init).then(() => q.refetch()).catch((ex) => setErr(errMsg(ex)));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button onClick={() => setModal({ open: true, habit: null })}><Icon name="plus" size={12} /> {t("page.habits.add")}</Button>
        <span className="soft" style={{ fontSize: "var(--fs-meta)" }}>{t("page.habits.hint")}</span>
      </div>
      {err ? <span role="alert" style={{ color: "var(--dnd)", fontSize: "var(--fs-meta)" }}>{err}</span> : null}
      {list.length === 0 ? <Empty icon="check-double" title={t("page.habits.empty")}>{t("page.habits.emptyHint")}</Empty> : null}
      {list.map((h) => (
        <Window
          key={h.id}
          title={<span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><i style={{ width: 10, height: 10, background: h.color, display: "inline-block" }} /> {h.name}</span>}
          right={
            <>
              <Chip style={{ fontSize: "var(--fs-meta)" }}>{t("page.habits.streak", { count: h.streak })}</Chip>
              <Chip style={{ fontSize: "var(--fs-meta)" }}>{t("page.habits.last30", { count: h.last30 })}</Chip>
              {h.kind === "count" ? (
                <Chip style={{ fontSize: "var(--fs-meta)" }}>{t("page.habits.perDay", { count: h.target_per_day })}</Chip>
              ) : (
                <Chip tone={h.weekDone >= h.target_per_week ? "ok" : undefined} style={{ fontSize: "var(--fs-meta)" }} title={t("page.habits.target", { count: h.target_per_week })}>
                  {t("page.habits.week", { done: h.weekDone, target: h.target_per_week })}
                </Chip>
              )}
              <Button icon size="sm" variant="ghost" aria-label={t("common.edit")} title={t("common.edit")} onClick={() => setModal({ open: true, habit: h })}><Icon name="sliders" size={12} /></Button>
              <Button icon size="sm" variant="ghost" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => setDeleting(h)}><Icon name="trash" size={12} /></Button>
            </>
          }
        >
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            {h.kind === "count" ? (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Button icon size="sm" aria-label={t("common.minusOne")} title={t("common.minusOne")} disabled={h.todayCount === 0} onClick={() => call("/decrement", { method: "POST", json: { habitId: h.id } })}><Icon name="minus" size={12} /></Button>
                <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13, minWidth: 90, textAlign: "center", color: h.doneToday ? h.color : undefined }}>{t("page.habits.todayCount", { count: h.todayCount, target: h.target_per_day })}</span>
                <Button icon size="sm" variant={h.doneToday ? "default" : "primary"} aria-label={t("common.plusOne")} title={t("common.plusOne")} onClick={() => call("/increment", { method: "POST", json: { habitId: h.id } })}><Icon name="plus" size={12} /></Button>
              </div>
            ) : (
              <Button variant={h.doneToday ? "default" : "primary"} onClick={() => call("/toggle", { method: "POST", json: { habitId: h.id } })}>
                <Icon name={h.doneToday ? "check" : "square"} size={14} /> {h.doneToday ? t("page.habits.doneToday") : t("page.habits.markToday")}
              </Button>
            )}
            <div className="scroll-x" style={{ flex: 1, minWidth: 0 }}>
              <HabitGrid h={h} weeks={26} cell={11} onToggle={(day) => call("/toggle", { method: "POST", json: { habitId: h.id, day } })} />
            </div>
          </div>
        </Window>
      ))}
      <HabitModal habit={modal.habit} open={modal.open} onClose={() => setModal((m) => ({ ...m, open: false }))} onSaved={() => void q.refetch()} />
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={t("page.habits.deleteTitle")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 13 }}>{t("page.habits.confirmDelete", { name: deleting?.name ?? "" })}</span>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setDeleting(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => { const id = deleting?.id; setDeleting(null); if (id) call(`/habits/${id}`, { method: "DELETE" }); }}><Icon name="trash" size={12} /> {t("common.delete")}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default defineClient({
  widgets: { today: TodayWidget, grid: GridWidget },
  pages: { habits: HabitsPage },
});
