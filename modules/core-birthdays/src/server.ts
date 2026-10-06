import { defineModule } from "@orbis/sdk/server";

export type Person = { id: string; name: string; date: string; note: string | null; created_at: string };
export type PersonView = Person & { next: string; daysUntil: number; turns: number | null };

const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** date is "YYYY-MM-DD" or "--MM-DD" (year unknown) */
export function nextOccurrence(date: string, from = new Date()): { next: Date; turns: number | null } {
  const m = date.match(/^(\d{4})?-?-?(\d{2})-(\d{2})$/);
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
  return { next, turns: year ? next.getFullYear() - year : null };
}

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

    http.get("/people", (c) => c.json(all()));
    http.post("/people", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { name?: string; date?: string; note?: string };
      if (!b.name?.trim() || !b.date) return c.json({ error: "name and date required" }, 400);
      if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(b.date) && !/^--\d{2}-\d{2}$/.test(b.date)) return c.json({ error: "date must be YYYY-MM-DD or MM-DD" }, 400);
      const id = uid();
      db.run(`INSERT INTO {{t:people}} (id, name, date, note, created_at) VALUES (?, ?, ?, ?, ?)`, [id, b.name.trim(), b.date.replace(/^--/, ""), b.note?.trim() || null, new Date().toISOString()]);
      changed();
      return c.json(all().find((p) => p.id === id), 201);
    });
    http.patch("/people/:id", async (c) => {
      const id = c.req.param("id");
      const b = (await c.req.json().catch(() => ({}))) as Partial<{ name: string; date: string; note: string | null }>;
      if (b.name !== undefined) db.run(`UPDATE {{t:people}} SET name = ? WHERE id = ?`, [b.name, id]);
      if (b.date !== undefined) db.run(`UPDATE {{t:people}} SET date = ? WHERE id = ?`, [b.date.replace(/^--/, ""), id]);
      if (b.note !== undefined) db.run(`UPDATE {{t:people}} SET note = ? WHERE id = ?`, [b.note, id]);
      changed();
      return c.json(all().find((p) => p.id === id) ?? { ok: true });
    });
    http.delete("/people/:id", (c) => {
      db.run(`DELETE FROM {{t:people}} WHERE id = ?`, [c.req.param("id")]);
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
