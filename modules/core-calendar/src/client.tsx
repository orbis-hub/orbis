import { useEffect, useMemo, useState, type FormEvent } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, useT, type PageProps, type SettingsProps, type Translator, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Modal, Select, Switch, Window, cx } from "@orbis/ui";
import type { Account, CalEvent, Calendar } from "./server";

type EventsResponse = { events: CalEvent[]; fetchedAt: string; errors: Record<string, string>; partial?: boolean; covered?: { from: string; to: string } };
type AccountView = Omit<Account, "password"> & { password?: string; hasPassword: boolean };

/* ---------- helpers ---------- */

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtTime = (iso: string, locale: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
/** all-day events are stored as utc midnight of the calendar day; read that day back as a *local* date so it never shifts */
const evStart = (e: CalEvent) => (e.allDay ? localDay(e.start) : new Date(e.start));
const evEnd = (e: CalEvent) => (e.allDay ? localDay(e.end) : new Date(e.end));
function localDay(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}
function dayLabel(d: Date, t: Translator, locale: string) {
  const today = startOfDay(new Date());
  const diff = Math.round((startOfDay(d).getTime() - today.getTime()) / 86400_000);
  if (diff === 0) return t("day.today");
  if (diff === 1) return t("day.tomorrow");
  if (diff > 1 && diff < 7) return d.toLocaleDateString(locale, { weekday: "long" });
  return d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
}
const WEEKDAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;

/** translator + formatting locale of the hub */
function useCal() {
  const t = useT();
  const { locale } = useModule();
  return { t, locale };
}

function useEvents(from: Date, to: Date, calendars?: string[]) {
  const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (calendars?.length) q.set("calendars", calendars.join(","));
  return useModuleQuery<EventsResponse>(`/events?${q}`, { refetchOn: ["updated"], intervalMs: 60_000 });
}

function groupByDay(events: CalEvent[], from: Date, to: Date) {
  const groups = new Map<string, { date: Date; events: CalEvent[] }>();
  for (const e of events) {
    // multi-day events appear on every day they cover
    const st = evStart(e);
    const s = startOfDay(st < from ? from : st);
    const endExclusive = new Date(evEnd(e).getTime() - 1); // end is exclusive
    for (let d = new Date(s); d <= endExclusive && d <= to; d.setDate(d.getDate() + 1)) {
      const k = dayKey(d);
      if (!groups.has(k)) groups.set(k, { date: new Date(d), events: [] });
      groups.get(k)!.events.push(e);
    }
  }
  return [...groups.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function EventRow({ e, dense }: { e: CalEvent; dense?: boolean }) {
  const { t, locale } = useCal();
  const now = Date.now();
  const live = !e.allDay && new Date(e.start).getTime() <= now && new Date(e.end).getTime() >= now;
  const past = new Date(e.end).getTime() < now;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: dense ? "2px 0" : "4px 0", opacity: past ? 0.5 : 1 }} title={e.description}>
      <i style={{ width: 3, alignSelf: "stretch", background: e.color, flex: "none", marginTop: 3, marginBottom: 3 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: dense ? 12 : 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {e.title}
          {live ? <span className="chip chip-accent" style={{ fontSize: 9, marginLeft: 6 }}>{t("event.now")}</span> : null}
        </div>
        <div className="soft" style={{ fontSize: 10, display: "flex", gap: 6 }}>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{e.allDay ? t("event.allDay") : `${fmtTime(e.start, locale)} – ${fmtTime(e.end, locale)}`}</span>
          {e.location ? <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {e.location}</span> : null}
          {!dense ? <span>· {e.calendarName}</span> : null}
        </div>
      </div>
    </div>
  );
}

/* ---------- widgets ---------- */

function AgendaWidget({ config }: WidgetProps<{ days?: number; calendars?: string[]; showAllDay?: boolean }>) {
  const { t, locale } = useCal();
  const from = startOfDay(new Date());
  const to = new Date(from.getTime() + (config.days ?? 7) * 86400_000);
  const q = useEvents(from, to, config.calendars);
  const list = (q.data?.events ?? []).filter((e) => config.showAllDay !== false || !e.allDay);
  const groups = useMemo(() => groupByDay(list, from, to), [list, from.getTime(), to.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("loading")}</span>;
  if (q.error) return <span style={{ color: "var(--dnd)", fontSize: 12 }}>{q.error.message}</span>;
  if (groups.length === 0) return <Empty icon="calendar" title={t("widget.agenda.empty")}>{Object.keys(q.data?.errors ?? {}).length ? t("widget.agenda.errors") : t("widget.agenda.free", { count: config.days ?? 7 })}</Empty>;
  return (
    <div className="scroll-y" style={{ height: "100%" }}>
      {groups.map((g) => (
        <div key={dayKey(g.date)} style={{ marginBottom: 6 }}>
          <div className="pixel" style={{ fontSize: 11, color: dayKey(g.date) === dayKey(new Date()) ? "var(--accent)" : "var(--ink-soft)", borderBottom: "1px dashed var(--line)", marginBottom: 2 }}>
            {dayLabel(g.date, t, locale)}
          </div>
          {g.events.map((e) => (
            <EventRow key={e.id + g.date.getTime()} e={e} dense />
          ))}
        </div>
      ))}
    </div>
  );
}

function NextWidget({ config, size }: WidgetProps<{ calendars?: string[] }>) {
  const { t, locale } = useCal();
  // round `from` to the minute so the query path (and with it the refetch) only changes once a minute
  const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const from = useMemo(() => new Date(nowMinute), [nowMinute]);
  const to = useMemo(() => new Date(nowMinute + 30 * 86400_000), [nowMinute]);
  const q = useEvents(from, to, config.calendars);
  const next = (q.data?.events ?? []).filter((e) => !e.allDay && new Date(e.end).getTime() > Date.now())[0] ?? (q.data?.events ?? [])[0];
  if (!next) return <Empty icon="calendar">{q.loading ? t("loading") : t("widget.next.empty")}</Empty>;
  const start = evStart(next);
  const mins = Math.round((start.getTime() - Date.now()) / 60_000);
  const rel = mins <= 0 ? t("rel.now") : mins < 60 ? t("rel.minutes", { count: mins }) : mins < 1440 ? t("rel.hours", { count: Math.round(mins / 60) }) : t("rel.days", { count: Math.round(mins / 1440) });
  const big = Math.max(14, Math.min(size.height * 0.28, size.width / 12));
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, borderLeft: `4px solid ${next.color}`, paddingLeft: 10 }}>
      <div className="soft" style={{ fontSize: 11 }}>{dayLabel(start, t, locale)} · {next.allDay ? t("event.allDay") : fmtTime(next.start, locale)} · {rel}</div>
      <div className="pixel" style={{ fontSize: big, lineHeight: 1.15, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{next.title}</div>
      {next.location ? <div className="soft" style={{ fontSize: 11 }}><Icon name="map-pin" size={10} /> {next.location}</div> : null}
    </div>
  );
}

function MonthGrid({ month, events, weekStartsMonday, selected, onSelect, compact }: { month: Date; events: CalEvent[]; weekStartsMonday: boolean; selected?: string; onSelect?: (d: Date) => void; compact?: boolean }) {
  const t = useT();
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() - (weekStartsMonday ? 1 : 0) + 7) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(1 - offset);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const g of groupByDay(events, cells[0]!, cells[41]!)) m.set(dayKey(g.date), g.events);
    return m;
  }, [events, cells[0]?.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = weekStartsMonday ? WEEKDAYS : [WEEKDAYS[6], ...WEEKDAYS.slice(0, 6)];
  const todayK = dayKey(new Date());
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, height: "100%", gridTemplateRows: "auto repeat(6, 1fr)" }}>
      {names.map((n) => (
        <div key={n} className="pixel soft" style={{ fontSize: 10, textAlign: "center" }}>{t(`weekday.${n}`)}</div>
      ))}
      {cells.map((d) => {
        const k = dayKey(d);
        const evs = byDay.get(k) ?? [];
        const out = d.getMonth() !== month.getMonth();
        return (
          <button
            key={k}
            type="button"
            onClick={() => onSelect?.(d)}
            className={cx(k === selected && "win-flat")}
            style={{
              border: `1px ${k === todayK ? "solid var(--accent)" : "dashed var(--line)"}`,
              background: k === selected ? "var(--accent-soft)" : "transparent",
              opacity: out ? 0.4 : 1,
              padding: 2,
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              minHeight: 0,
              overflow: "hidden",
              textAlign: "left",
              fontSize: 11,
            }}
          >
            <span style={{ fontVariantNumeric: "tabular-nums", color: k === todayK ? "var(--accent)" : undefined }}>{d.getDate()}</span>
            {compact ? (
              <span style={{ display: "flex", gap: 2, flexWrap: "wrap", marginTop: "auto" }}>
                {evs.slice(0, 4).map((e) => (
                  <i key={e.id} style={{ width: 5, height: 5, background: e.color, display: "inline-block" }} />
                ))}
              </span>
            ) : (
              <span style={{ display: "flex", flexDirection: "column", gap: 1, overflow: "hidden" }}>
                {evs.slice(0, 3).map((e) => (
                  <span key={e.id} style={{ fontSize: 9, borderLeft: `2px solid ${e.color}`, paddingLeft: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</span>
                ))}
                {evs.length > 3 ? <span className="soft" style={{ fontSize: 9 }}>+{evs.length - 3}</span> : null}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function MonthWidget({ config, size }: WidgetProps<{ calendars?: string[]; weekStartsMonday?: boolean }>) {
  const { t, locale } = useCal();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const from = new Date(month.getFullYear(), month.getMonth(), -7);
  const to = new Date(month.getFullYear(), month.getMonth() + 1, 14);
  const q = useEvents(from, to, config.calendars);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Button icon size="sm" variant="ghost" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label={t("action.prevMonth")}><Icon name="chevron-left" size={12} /></Button>
        <span className="pixel" style={{ fontSize: 12 }}>{month.toLocaleDateString(locale, { month: "long", year: "numeric" })}</span>
        <Button icon size="sm" variant="ghost" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label={t("action.nextMonth")}><Icon name="chevron-right" size={12} /></Button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MonthGrid month={month} events={q.data?.events ?? []} weekStartsMonday={config.weekStartsMonday !== false} compact={size.height < 320} />
      </div>
      {q.error ? <div style={{ color: "var(--dnd)", fontSize: 10 }}>{q.error.message}</div> : q.data?.partial ? <div style={{ color: "var(--dnd)", fontSize: 10 }}>⚠ {t("page.partial")} <button type="button" style={{ textDecoration: "underline dotted" }} onClick={() => void q.refetch()}>{t("action.refresh")}</button></div> : null}
    </div>
  );
}

/* ---------- page ---------- */

function CalendarPage(_p: PageProps) {
  const { t, locale } = useCal();
  const api = useModuleApi();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selected, setSelected] = useState<Date>(() => startOfDay(new Date()));
  const [hidden, setHidden] = useState<string[]>([]);
  const cals = useModuleQuery<{ calendars: Calendar[]; errors: Record<string, string>; fetchedAt: string }>("/calendars", { refetchOn: ["updated"] });
  const from = new Date(month.getFullYear(), month.getMonth(), -7);
  const to = new Date(month.getFullYear(), month.getMonth() + 1, 14);
  const visible = (cals.data?.calendars ?? []).filter((c) => !hidden.includes(c.id)).map((c) => c.id);
  const q = useEvents(from, to, hidden.length ? visible : undefined);
  const dayEvents = useMemo(() => groupByDay(q.data?.events ?? [], selected, new Date(selected.getTime() + 86400_000 - 1)).find((g) => dayKey(g.date) === dayKey(selected))?.events ?? [], [q.data, selected]);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const errors = cals.data?.errors ?? {};

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(240px, 1fr)", gap: 14, alignItems: "start" }} className="cal-page">
      <style>{`@media (max-width: 860px) { .cal-page { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
      <Window
        title={
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <Button icon size="sm" variant="ghost" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label={t("action.prevMonth")}><Icon name="chevron-left" size={12} /></Button>
            {month.toLocaleDateString(locale, { month: "long", year: "numeric" })}
            <Button icon size="sm" variant="ghost" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label={t("action.nextMonth")}><Icon name="chevron-right" size={12} /></Button>
            <Button size="sm" variant="ghost" onClick={() => { const n = new Date(); setMonth(new Date(n.getFullYear(), n.getMonth(), 1)); setSelected(startOfDay(n)); }}>{t("action.today")}</Button>
          </span>
        }
        right={
          <>
            <Button size="sm" variant="ghost" onClick={() => api("/refresh", { method: "POST" })} aria-label={t("action.refresh")}><Icon name="reload" size={12} /></Button>
            <Button size="sm" onClick={() => setAccountsOpen(true)}><Icon name="link" size={12} /> {t("action.accounts")}</Button>
          </>
        }
      >
        <div style={{ height: 520 }}>
          <MonthGrid month={month} events={q.data?.events ?? []} weekStartsMonday selected={dayKey(selected)} onSelect={setSelected} />
        </div>
        {q.error ? <div style={{ color: "var(--dnd)", fontSize: 11, marginTop: 6 }}>{q.error.message}</div> : q.data?.partial ? <div style={{ color: "var(--dnd)", fontSize: 11, marginTop: 6 }}>⚠ {t("page.partial")} {Object.values(q.data.errors ?? {}).join(" · ")} <button type="button" style={{ textDecoration: "underline dotted" }} onClick={() => void q.refetch()}>{t("action.refresh")}</button></div> : null}
      </Window>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Window title={dayLabel(selected, t, locale)}>
          {dayEvents.length === 0 ? <div className="soft" style={{ fontSize: 12 }}>{t("page.nothingOnDay")}</div> : dayEvents.map((e) => <EventRow key={e.id} e={e} />)}
        </Window>
        <Window title={t("page.calendars")} tight>
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            {(cals.data?.calendars ?? []).length === 0 ? (
              <div className="soft" style={{ fontSize: 12, padding: 4 }}>
                {t("page.noCalendars")} <button type="button" style={{ textDecoration: "underline dotted", color: "var(--accent-2)" }} onClick={() => setAccountsOpen(true)}>{t("page.connectAccount")}</button>
              </div>
            ) : null}
            {(cals.data?.calendars ?? []).map((c) => (
              <label key={c.id} className="check" style={{ fontSize: 12 }}>
                <input type="checkbox" checked={!hidden.includes(c.id)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((x) => x !== c.id) : [...hidden, c.id])} />
                <i aria-hidden style={{ background: hidden.includes(c.id) ? undefined : c.color, borderColor: c.color }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span className="soft" style={{ fontSize: 9, marginLeft: "auto" }}>{c.id.split(":")[0] === c.accountId && !c.writable ? "ics" : "caldav"}</span>
              </label>
            ))}
            {Object.keys(errors).length ? (
              <div style={{ color: "var(--dnd)", fontSize: 11, marginTop: 4 }}>
                {Object.values(errors).map((e, i) => <div key={i}>⚠ {e}</div>)}
              </div>
            ) : null}
            {cals.data?.fetchedAt ? <div className="soft" style={{ fontSize: 10, marginTop: 4 }}>{t("page.updated", { time: new Date(cals.data.fetchedAt).toLocaleTimeString(locale) })}</div> : null}
          </div>
        </Window>
      </div>
      <AccountsModal open={accountsOpen} onClose={() => setAccountsOpen(false)} />
    </div>
  );
}

/* ---------- accounts ---------- */

const PRESETS: Array<{ id: string; type: "ics" | "caldav"; url: string }> = [
  { id: "google", type: "ics", url: "https://calendar.google.com/calendar/ical/" },
  { id: "icloud", type: "caldav", url: "https://caldav.icloud.com" },
  { id: "nextcloud", type: "caldav", url: "https://cloud.example.com" },
  { id: "fastmail", type: "caldav", url: "https://caldav.fastmail.com" },
  { id: "caldav", type: "caldav", url: "https://" },
  { id: "ics", type: "ics", url: "https://" },
];

function AccountsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const api = useModuleApi();
  const accounts = useModuleQuery<AccountView[]>("/accounts", { refetchOn: ["updated"], enabled: open });
  const [preset, setPreset] = useState(PRESETS[0]!);
  const presetLabel = (p: { id: string }) => t(`preset.${p.id}.label`);
  const [form, setForm] = useState({ name: "", url: PRESETS[0]!.url, username: "", password: "" });
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm((f) => ({ ...f, url: preset.url, name: f.name || (preset.id !== "caldav" && preset.id !== "ics" ? presetLabel(preset) : "") }));
    setTest(null);
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps
  const payload = () => ({ type: preset.type, name: form.name || presetLabel(preset), url: form.url, username: form.username || undefined, password: form.password || undefined });

  async function runTest() {
    setBusy(true);
    setTest(null);
    try {
      const r = await api<{ ok: boolean; calendars?: string[]; events?: number; error?: string }>("/accounts/test", { method: "POST", json: payload() });
      setTest({ ok: true, text: `${t("test.found", { count: r.calendars?.length ?? 0, names: (r.calendars ?? []).join(", ") })} · ${t("test.events", { count: r.events ?? 0 })}` });
    } catch (err) {
      setTest({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/accounts", { method: "POST", json: payload() });
      setForm({ name: "", url: preset.url, username: "", password: "" });
      setTest(null);
      accounts.refetch();
    } catch (err) {
      setTest({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("modal.accounts")} width={620}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {(accounts.data ?? []).length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(accounts.data ?? []).map((a) => (
              <div key={a.id} className="win win-flat" style={{ padding: "6px 10px", display: "flex", alignItems: "center", gap: 8, flexDirection: "row" }}>
                <i style={{ width: 10, height: 10, background: a.color, flex: "none" }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
                  <div>{a.name} <Chip style={{ fontSize: 9 }}>{a.type}</Chip></div>
                  <div className="soft" style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.username ? `${a.username} @ ` : ""}{a.url}</div>
                </div>
                <Switch checked={a.enabled} onChange={(e) => api(`/accounts/${a.id}`, { method: "PATCH", json: { enabled: e.target.checked } }).then(() => accounts.refetch())} aria-label={t("account.enabled")} />
                <Button icon size="sm" variant="ghost" aria-label={t("action.remove")} onClick={() => { if (confirm(t("confirm.remove", { name: a.name }))) api(`/accounts/${a.id}`, { method: "DELETE" }).then(() => accounts.refetch()); }}><Icon name="trash" size={12} /></Button>
              </div>
            ))}
          </div>
        ) : null}
        <form onSubmit={add} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="pixel" style={{ fontSize: 12 }}>{t("form.addAccount")}</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {PRESETS.map((p) => (
              <Button key={p.id} size="sm" aria-pressed={p.id === preset.id} onClick={() => setPreset(p)}>{presetLabel(p)}</Button>
            ))}
          </div>
          <div className="soft" style={{ fontSize: 11 }}>{t(`preset.${preset.id}.hint`)}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
            <Field label={t("field.name")}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={presetLabel(preset)} /></Field>
            <Field label={preset.type === "ics" ? t("field.feedUrl") : t("field.serverUrl")}><Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required inputMode="url" /></Field>
          </div>
          {preset.type === "caldav" || form.url.includes("@") ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field label={t("field.username")}><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" required={preset.type === "caldav"} /></Field>
              <Field label={t("field.appPassword")}><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" required={preset.type === "caldav"} /></Field>
            </div>
          ) : null}
          {test ? <div style={{ fontSize: 12, color: test.ok ? "var(--ok)" : "var(--dnd)" }}>{test.text}</div> : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={runTest} loading={busy}>{t("action.test")}</Button>
            <Button type="submit" variant="primary" loading={busy}>{t("action.add")}</Button>
          </div>
        </form>
        <div className="soft" style={{ fontSize: 10 }}>{t("form.passwordNote")}</div>
      </div>
    </Modal>
  );
}

function CalendarSettings({ value, onChange }: SettingsProps) {
  const t = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Field label={t("settings.refresh")}>
        <Input type="number" min={2} max={240} value={Number(value.refreshMinutes ?? 10)} onChange={(e) => onChange({ ...value, refreshMinutes: Number(e.target.value) })} />
      </Field>
      <div className="soft" style={{ fontSize: 12 }}>{t("settings.accountsHint")}</div>
      <Select style={{ display: "none" }} />
    </div>
  );
}

export default defineClient({
  widgets: { agenda: AgendaWidget, month: MonthWidget, next: NextWidget },
  pages: { calendar: CalendarPage },
  settings: CalendarSettings,
});
