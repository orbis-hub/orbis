import { defineModule, invalid, notFound, parseBody, z } from "@orbis/sdk/server";

export type Person = { id: string; name: string; date: string; note: string | null; created_at: string };
export type PersonView = Person & { next: string; daysUntil: number; turns: number | null };

const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const NAME_MAX = 100;
export const NOTE_MAX = 500;
export const MIN_YEAR = 1900;

/** "YYYY-MM-DD", "MM-DD" or "--MM-DD" (year unknown) */
const DATE_RE = /^(?:(\d{4})-|--)?(\d{2})-(\d{2})$/;

/**
 * Validate a birthday and return it in canonical form ("YYYY-MM-DD" or "MM-DD"): a real calendar date (no 02-30,
 * no 13th month), year 1900..today, never in the future. Feb 29 is fine when the year is unknown.
 */
export function normalizeDate(input: string, today = new Date()): { ok: true; date: string } | { ok: false; error: string } {
  const m = input.trim().match(DATE_RE);
  if (!m) return { ok: false, error: "date must be YYYY-MM-DD or MM-DD" };
  const year = m[1] ? Number(m[1]) : null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return { ok: false, error: "month must be 01..12" };
  const daysInMonth = year === null ? (month === 2 ? 29 : new Date(2001, month, 0).getDate()) : new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) return { ok: false, error: "not a real calendar date" };
  if (year !== null) {
    if (year < MIN_YEAR) return { ok: false, error: `year must be ${MIN_YEAR} or later` };
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (new Date(year, month - 1, day) > t) return { ok: false, error: "birthday must not be in the future" };
  }
  return { ok: true, date: `${year === null ? "" : `${m[1]}-`}${m[2]}-${m[3]}` };
}

/** date is "YYYY-MM-DD" or "MM-DD" (year unknown) */
export function nextOccurrence(date: string, from = new Date()): { next: Date; turns: number | null } {
  const m = date.match(DATE_RE);
  if (!m) return { next: from, turns: null };
  const year = m[1] ? Number(m[1]) : null;
  const month = Number(m[2]) - 1, day = Number(m[3]);
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let next = new Date(today.getFullYear(), month, day);
  // feb 29 on non-leap years → feb 28
  if (next.getMonth() !== month) next = new Date(today.getFullYear(), month, day - 1);
  if (next < today) {
    next = new Date(today.getFullYear() + 1, month, day);
    if (next.getMonth() !== month) next = new Date(today.getFullYear() + 1, month, day - 1);
  }
  return { next, turns: year ? Math.max(0, next.getFullYear() - year) : null };
}

const nameSchema = z.string().trim().min(1, "name must not be empty").max(NAME_MAX, `name: at most ${NAME_MAX} characters`);
const dateSchema = z.string().trim().min(1, "date required").max(12, "date must be YYYY-MM-DD or MM-DD");
const noteSchema = z.string().trim().max(NOTE_MAX, `note: at most ${NOTE_MAX} characters`).nullable();

export default defineModule({
  setup(ctx) {
    const { storage: db, http, events } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:people}} (id TEXT PRIMARY KEY, name TEXT NOT NULL, date TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL)`);
    const changed = () => events.publish("changed");
    const view = (p: Person): PersonView => {
      const { next, turns } = nextOccurrence(p.date);
      const today = new Date();
      const daysUntil = Math.round((next.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400_000);
      return { ...p, next: localIso(next), daysUntil, turns };
    };
    const all = () => db.sql<Person>(`SELECT * FROM {{t:people}}`).map(view).sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name));
    const exists = (id: string) => db.sql<{ id: string }>(`SELECT id FROM {{t:people}} WHERE id = ?`, [id]).length > 0;

    http.get("/people", (c) => c.json(all()));
    http.post("/people", async (c) => {
      const b = await parseBody(c, z.object({ name: nameSchema, date: dateSchema, note: noteSchema.optional() }));
      if (!b.ok) return b.res;
      const d = normalizeDate(b.data.date);
      if (!d.ok) return invalid(c, [{ path: "date", message: d.error }]);
      const id = uid();
      db.run(`INSERT INTO {{t:people}} (id, name, date, note, created_at) VALUES (?, ?, ?, ?, ?)`, [id, b.data.name, d.date, b.data.note || null, new Date().toISOString()]);
      changed();
      return c.json(all().find((p) => p.id === id), 201);
    });
    http.patch("/people/:id", async (c) => {
      const id = c.req.param("id");
      if (!exists(id)) return notFound(c, "person not found");
      const b = await parseBody(c, z.object({ name: nameSchema.optional(), date: dateSchema.optional(), note: noteSchema.optional() }));
      if (!b.ok) return b.res;
      let date: string | undefined;
      if (b.data.date !== undefined) {
        const d = normalizeDate(b.data.date);
        if (!d.ok) return invalid(c, [{ path: "date", message: d.error }]);
        date = d.date;
      }
      if (b.data.name !== undefined) db.run(`UPDATE {{t:people}} SET name = ? WHERE id = ?`, [b.data.name, id]);
      if (date !== undefined) db.run(`UPDATE {{t:people}} SET date = ? WHERE id = ?`, [date, id]);
      if (b.data.note !== undefined) db.run(`UPDATE {{t:people}} SET note = ? WHERE id = ?`, [b.data.note || null, id]);
      changed();
      return c.json(all().find((p) => p.id === id));
    });
    http.delete("/people/:id", (c) => {
      const id = c.req.param("id");
      if (!exists(id)) return notFound(c, "person not found");
      db.run(`DELETE FROM {{t:people}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });

    // morning reminders: today and in 7 days
    ctx.scheduler.every("remind", 60 * 60_000, () => {
      const h = new Date().getHours();
      if (h < 8 || h > 9) return;
      const t = ctx.i18n.t;
      for (const p of all()) {
        if (p.daysUntil === 0) ctx.notify({ key: `bday:${p.id}:${p.next}`, title: p.turns ? t("notify.today.titleTurns", { name: p.name, age: p.turns }) : t("notify.today.title", { name: p.name }), body: p.note ?? undefined, level: "info", icon: "cake", url: "/m/?id=birthdays&page=people" });
        else if (p.daysUntil === 7) ctx.notify({ key: `bday7:${p.id}:${p.next}`, title: t("notify.week.title", { name: p.name }), body: p.note ? t("notify.week.note", { note: p.note }) : t("notify.week.body"), level: "info", icon: "gift", url: "/m/?id=birthdays&page=people" });
      }
    });

    einkRender = (req) => {
      const cfg = req.config as { count?: number; showAge?: boolean };
      const list = all().slice(0, cfg.count ?? 5);
      const t = ctx.i18n.t;
      if (!list.length) return { type: "text", text: t("eink.empty"), size: 12, gray: 0.5 };
      return { type: "col", grow: 1, gap: 4, children: list.map((p) => ({ type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "text" as const, text: p.daysUntil === 0 ? t("eink.today") : p.daysUntil === 1 ? t("eink.tomorrow") : t("eink.inDays", { count: p.daysUntil }), size: 12, pixel: false, gray: 0.5, wrap: false }, { type: "text" as const, text: p.name, size: 13, pixel: false, grow: 1, wrap: false, bold: p.daysUntil === 0 }, ...(cfg.showAge !== false && p.turns ? [{ type: "text" as const, text: `${p.turns}`, size: 12, pixel: false, gray: 0.5 }] : [])] })) };
    };
    ctx.logger.info("birthdays ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
