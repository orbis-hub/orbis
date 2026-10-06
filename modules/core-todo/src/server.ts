import { dateKey, defineModule, hexColor, idParam, isoDate, nonEmptyString, notFound, parseBody, z, type EinkRequest, type EinkTree } from "@orbis/sdk/server";

type List = { id: string; name: string; color: string | null; sort: number };
/** `due` is a calendar day (YYYY-MM-DD); clients compare it with their local date */
type Task = { id: string; list_id: string; title: string; notes: string | null; done: number; due: string | null; sort: number; created_at: string; done_at: string | null };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** YYYY-MM-DD → local midnight (new Date("2026-10-06") would be utc midnight and shift a day in the americas) */
const fromDayKey = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};
/** accepted on the wire: a day key or a full ISO timestamp (converted to the hub's local day); stored as a day key */
const dueInput = z.union([dateKey, isoDate.transform((iso) => dayKey(new Date(iso)))]);
const notesInput = z.string().trim().max(10_000).transform((s) => s || null);

export default defineModule({
  setup(ctx) {
    const { storage: db, http, events } = ctx;

    db.run(`CREATE TABLE IF NOT EXISTS {{t:lists}} (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, sort INTEGER NOT NULL DEFAULT 0)`);
    db.run(
      `CREATE TABLE IF NOT EXISTS {{t:tasks}} (id TEXT PRIMARY KEY, list_id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT, done INTEGER NOT NULL DEFAULT 0, due TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT)`,
    );
    db.run(`CREATE INDEX IF NOT EXISTS {{t:tasks_list}} ON {{t:tasks}}(list_id)`);
    if (db.sql<List>(`SELECT id FROM {{t:lists}} WHERE id = 'inbox'`).length === 0) {
      db.run(`INSERT INTO {{t:lists}} (id, name, color, sort) VALUES ('inbox', 'Inbox', NULL, 0)`);
    }
    // v2: `due` used to be an ISO timestamp (local midnight as utc); it is a plain day now
    for (const t of db.sql<{ id: string; due: string }>(`SELECT id, due FROM {{t:tasks}} WHERE due LIKE '%T%'`)) {
      const d = new Date(t.due);
      db.run(`UPDATE {{t:tasks}} SET due = ? WHERE id = ?`, [Number.isNaN(d.getTime()) ? null : dayKey(d), t.id]);
    }

    const lists = () => db.sql<List>(`SELECT * FROM {{t:lists}} ORDER BY sort, name`);
    const list = (id: string) => db.sql<List>(`SELECT * FROM {{t:lists}} WHERE id = ?`, [id])[0] ?? null;
    const tasks = (where = "", params: unknown[] = []) =>
      db.sql<Task>(`SELECT * FROM {{t:tasks}} ${where} ORDER BY done, CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, sort, created_at`, params);
    const task = (id: string) => tasks(`WHERE id = ?`, [id])[0] ?? null;
    // broadcast a change and drop reminders of tasks that got done meanwhile
    const changed = () => {
      events.publish("changed");
      for (const t of tasks(`WHERE done = 1`)) ctx.dismissNotification(`due:${t.id}`);
    };

    http.get("/lists", (c) => {
      const counts = Object.fromEntries(db.sql<{ list_id: string; n: number }>(`SELECT list_id, COUNT(*) AS n FROM {{t:tasks}} WHERE done = 0 GROUP BY list_id`).map((r) => [r.list_id, r.n]));
      return c.json(lists().map((l) => ({ ...l, open: counts[l.id] ?? 0 })));
    });
    http.post("/lists", async (c) => {
      const b = await parseBody(c, z.object({ name: nonEmptyString(200), color: hexColor.nullable().optional() }));
      if (!b.ok) return b.res;
      const id = uid();
      db.run(`INSERT INTO {{t:lists}} (id, name, color, sort) VALUES (?, ?, ?, ?)`, [id, b.data.name, b.data.color ?? null, lists().length]);
      changed();
      return c.json(list(id), 201);
    });
    http.patch("/lists/:id", async (c) => {
      const id = c.req.param("id");
      if (!list(id)) return notFound(c);
      const b = await parseBody(c, z.object({ name: nonEmptyString(200).optional(), color: hexColor.nullable().optional() }));
      if (!b.ok) return b.res;
      if (b.data.name !== undefined) db.run(`UPDATE {{t:lists}} SET name = ? WHERE id = ?`, [b.data.name, id]);
      if (b.data.color !== undefined) db.run(`UPDATE {{t:lists}} SET color = ? WHERE id = ?`, [b.data.color, id]);
      changed();
      return c.json(list(id));
    });
    http.delete("/lists/:id", (c) => {
      const id = c.req.param("id");
      if (id === "inbox") return c.json({ error: "inbox cannot be deleted" }, 400);
      if (!list(id)) return notFound(c);
      db.run(`DELETE FROM {{t:tasks}} WHERE list_id = ?`, [id]);
      db.run(`DELETE FROM {{t:lists}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });

    http.get("/tasks", (c) => {
      const listId = c.req.query("list");
      const scope = c.req.query("scope"); // today | all
      const includeDone = c.req.query("done") === "1";
      const where: string[] = [];
      const params: unknown[] = [];
      if (listId) {
        where.push("list_id = ?");
        params.push(listId);
      }
      if (!includeDone) where.push("done = 0");
      if (scope === "today") {
        where.push("due IS NOT NULL AND due <= ?");
        params.push(dayKey());
      }
      return c.json(tasks(where.length ? `WHERE ${where.join(" AND ")}` : "", params));
    });
    http.post("/tasks", async (c) => {
      const b = await parseBody(c, z.object({ title: nonEmptyString(200), listId: idParam.optional(), due: dueInput.nullable().optional(), notes: notesInput.nullable().optional() }));
      if (!b.ok) return b.res;
      const listId = b.data.listId ?? "inbox";
      if (!list(listId)) return notFound(c, "list not found");
      const id = uid();
      const sort = db.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM {{t:tasks}} WHERE list_id = ?`, [listId])[0]?.n ?? 0;
      db.run(`INSERT INTO {{t:tasks}} (id, list_id, title, notes, done, due, sort, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`, [id, listId, b.data.title, b.data.notes ?? null, b.data.due ?? null, sort, now()]);
      changed();
      return c.json(task(id), 201);
    });
    http.patch("/tasks/:id", async (c) => {
      const id = c.req.param("id");
      if (!task(id)) return notFound(c);
      const b = await parseBody(c, z.object({ title: nonEmptyString(200).optional(), notes: notesInput.nullable().optional(), done: z.boolean().optional(), due: dueInput.nullable().optional(), listId: idParam.optional() }));
      if (!b.ok) return b.res;
      const d = b.data;
      if (d.listId !== undefined && !list(d.listId)) return notFound(c, "list not found");
      if (d.title !== undefined) db.run(`UPDATE {{t:tasks}} SET title = ? WHERE id = ?`, [d.title, id]);
      if (d.notes !== undefined) db.run(`UPDATE {{t:tasks}} SET notes = ? WHERE id = ?`, [d.notes, id]);
      if (d.due !== undefined) db.run(`UPDATE {{t:tasks}} SET due = ? WHERE id = ?`, [d.due, id]);
      if (d.listId !== undefined) db.run(`UPDATE {{t:tasks}} SET list_id = ? WHERE id = ?`, [d.listId, id]);
      if (d.done !== undefined) db.run(`UPDATE {{t:tasks}} SET done = ?, done_at = ? WHERE id = ?`, [d.done ? 1 : 0, d.done ? now() : null, id]);
      changed();
      return c.json(task(id));
    });
    http.delete("/tasks/:id", (c) => {
      const id = c.req.param("id");
      if (!task(id)) return notFound(c);
      db.run(`DELETE FROM {{t:tasks}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });
    http.post("/tasks/clear-done", async (c) => {
      const b = await parseBody(c, z.object({ listId: idParam.optional() }));
      if (!b.ok) return b.res;
      if (b.data.listId) {
        if (!list(b.data.listId)) return notFound(c, "list not found");
        db.run(`DELETE FROM {{t:tasks}} WHERE done = 1 AND list_id = ?`, [b.data.listId]);
      } else db.run(`DELETE FROM {{t:tasks}} WHERE done = 1`);
      changed();
      return c.json({ ok: true });
    });

    // reminders: tasks due today (at 08:00 hub time) and overdue ones, replaced per task so they never pile up
    const remind = () => {
      const today = dayKey();
      for (const t of tasks(`WHERE done = 0 AND due IS NOT NULL AND due <= ?`, [today])) {
        const overdue = t.due! < today;
        ctx.notify({ key: `due:${t.id}`, title: ctx.i18n.t(overdue ? "notify.overdue" : "notify.due_today", { title: t.title }), level: overdue ? "warning" : "info", icon: "checkbox", url: "/m/?id=todo&page=tasks" });
      }
    };
    ctx.scheduler.every("remind", 60 * 60_000, () => {
      const h = new Date().getHours();
      if (h >= 8 && h <= 9) remind();
    });
    ctx.logger.info("todo ready");

    einkRender = (req) => {
      const cfg = req.config as { listId?: string; showDone?: boolean };
      const rowH = 22;
      const max = Math.max(1, Math.floor((req.height - 4) / rowH));
      const today = dayKey(req.now);
      let rows: Task[];
      if (req.widget === "today") rows = tasks(`WHERE done = 0 AND due IS NOT NULL AND due <= ?`, [today]);
      else rows = tasks(`WHERE list_id = ?${cfg.showDone ? "" : " AND done = 0"}`, [cfg.listId || "inbox"]);
      const tr = ctx.i18n.t;
      if (rows.length === 0) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: tr(req.widget === "today" ? "eink.today_empty" : "eink.list_empty"), size: 16, gray: 0.5 }] };
      const lines = rows.slice(0, max).map((t) => {
        const overdue = !!t.due && t.due < today;
        return {
          type: "row" as const,
          gap: 8,
          align: "center" as const,
          children: [
            { type: "dots" as const, count: 1, filled: t.done ? 1 : 0, size: 12 },
            { type: "text" as const, text: t.title, size: 14, pixel: false, grow: 1, wrap: false, gray: t.done ? 0.5 : 1 },
            ...(t.due ? [{ type: "text" as const, text: overdue ? tr("eink.overdue") : fromDayKey(t.due).toLocaleDateString(req.locale, { day: "numeric", month: "short" }), size: 11, pixel: false, gray: 0.5, bold: overdue }] : []),
          ],
        };
      });
      if (rows.length > max) lines.push({ type: "row", gap: 0, align: "center", children: [{ type: "text", text: tr("eink.more", { count: rows.length - max }), size: 11, pixel: false, gray: 0.5, grow: 1, wrap: false }] });
      return { type: "col", grow: 1, gap: 4, children: lines };
    };
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: EinkRequest) => EinkTree) | null = null;
