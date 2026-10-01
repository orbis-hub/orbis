import { defineModule } from "@orbis/sdk/server";

type List = { id: string; name: string; color: string | null; sort: number };
type Task = { id: string; list_id: string; title: string; notes: string | null; done: number; due: string | null; sort: number; created_at: string; done_at: string | null };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();

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

    const changed = () => events.publish("changed");
    const lists = () => db.sql<List>(`SELECT * FROM {{t:lists}} ORDER BY sort, name`);
    const tasks = (where = "", params: unknown[] = []) =>
      db.sql<Task>(`SELECT * FROM {{t:tasks}} ${where} ORDER BY done, CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, sort, created_at`, params);

    http.get("/lists", (c) => {
      const counts = Object.fromEntries(db.sql<{ list_id: string; n: number }>(`SELECT list_id, COUNT(*) AS n FROM {{t:tasks}} WHERE done = 0 GROUP BY list_id`).map((r) => [r.list_id, r.n]));
      return c.json(lists().map((l) => ({ ...l, open: counts[l.id] ?? 0 })));
    });
    http.post("/lists", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { name?: string; color?: string };
      if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
      const id = uid();
      db.run(`INSERT INTO {{t:lists}} (id, name, color, sort) VALUES (?, ?, ?, ?)`, [id, b.name.trim(), b.color ?? null, lists().length]);
      changed();
      return c.json({ id, name: b.name.trim(), color: b.color ?? null }, 201);
    });
    http.patch("/lists/:id", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { name?: string; color?: string | null };
      if (b.name !== undefined) db.run(`UPDATE {{t:lists}} SET name = ? WHERE id = ?`, [b.name, c.req.param("id")]);
      if (b.color !== undefined) db.run(`UPDATE {{t:lists}} SET color = ? WHERE id = ?`, [b.color, c.req.param("id")]);
      changed();
      return c.json({ ok: true });
    });
    http.delete("/lists/:id", (c) => {
      const id = c.req.param("id");
      if (id === "inbox") return c.json({ error: "inbox cannot be deleted" }, 400);
      db.run(`DELETE FROM {{t:tasks}} WHERE list_id = ?`, [id]);
      db.run(`DELETE FROM {{t:lists}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });

    http.get("/tasks", (c) => {
      const list = c.req.query("list");
      const scope = c.req.query("scope"); // today | all
      const includeDone = c.req.query("done") === "1";
      const where: string[] = [];
      const params: unknown[] = [];
      if (list) {
        where.push("list_id = ?");
        params.push(list);
      }
      if (!includeDone) where.push("done = 0");
      if (scope === "today") {
        const today = new Date();
        today.setHours(23, 59, 59, 999);
        where.push("due IS NOT NULL AND due <= ?");
        params.push(today.toISOString());
      }
      return c.json(tasks(where.length ? `WHERE ${where.join(" AND ")}` : "", params));
    });
    http.post("/tasks", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { title?: string; listId?: string; due?: string | null; notes?: string };
      if (!b.title?.trim()) return c.json({ error: "title required" }, 400);
      const id = uid();
      const listId = b.listId || "inbox";
      const sort = db.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM {{t:tasks}} WHERE list_id = ?`, [listId])[0]?.n ?? 0;
      db.run(`INSERT INTO {{t:tasks}} (id, list_id, title, notes, done, due, sort, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`, [id, listId, b.title.trim(), b.notes ?? null, b.due ?? null, sort, now()]);
      changed();
      return c.json(tasks(`WHERE id = ?`, [id])[0], 201);
    });
    http.patch("/tasks/:id", async (c) => {
      const id = c.req.param("id");
      const b = (await c.req.json().catch(() => ({}))) as Partial<{ title: string; notes: string | null; done: boolean; due: string | null; listId: string }>;
      if (b.title !== undefined) db.run(`UPDATE {{t:tasks}} SET title = ? WHERE id = ?`, [b.title, id]);
      if (b.notes !== undefined) db.run(`UPDATE {{t:tasks}} SET notes = ? WHERE id = ?`, [b.notes, id]);
      if (b.due !== undefined) db.run(`UPDATE {{t:tasks}} SET due = ? WHERE id = ?`, [b.due, id]);
      if (b.listId !== undefined) db.run(`UPDATE {{t:tasks}} SET list_id = ? WHERE id = ?`, [b.listId, id]);
      if (b.done !== undefined) db.run(`UPDATE {{t:tasks}} SET done = ?, done_at = ? WHERE id = ?`, [b.done ? 1 : 0, b.done ? now() : null, id]);
      changed();
      const t = tasks(`WHERE id = ?`, [id])[0];
      return t ? c.json(t) : c.json({ error: "not found" }, 404);
    });
    http.delete("/tasks/:id", (c) => {
      db.run(`DELETE FROM {{t:tasks}} WHERE id = ?`, [c.req.param("id")]);
      changed();
      return c.json({ ok: true });
    });
    http.post("/tasks/clear-done", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { listId?: string };
      if (b.listId) db.run(`DELETE FROM {{t:tasks}} WHERE done = 1 AND list_id = ?`, [b.listId]);
      else db.run(`DELETE FROM {{t:tasks}} WHERE done = 1`);
      changed();
      return c.json({ ok: true });
    });

    ctx.logger.info("todo ready");

    einkRender = (req) => {
      const cfg = req.config as { listId?: string; showDone?: boolean };
      const rowH = 22;
      const max = Math.max(1, Math.floor((req.height - 4) / rowH));
      let list: Task[];
      if (req.widget === "today") {
        const today = new Date(req.now);
        today.setHours(23, 59, 59, 999);
        list = tasks(`WHERE done = 0 AND due IS NOT NULL AND due <= ?`, [today.toISOString()]);
      } else {
        list = tasks(`WHERE list_id = ?${cfg.showDone ? "" : " AND done = 0"}`, [cfg.listId || "inbox"]);
      }
      if (list.length === 0) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: req.widget === "today" ? "nothing due today" : "all clear ✓", size: 16, gray: 0.5 }] };
      const rows = list.slice(0, max).map((t) => {
        const due = t.due ? new Date(t.due) : null;
        const overdue = due && due.getTime() < req.now.getTime() - 86400_000;
        return {
          type: "row" as const,
          gap: 8,
          align: "center" as const,
          children: [
            { type: "dots" as const, count: 1, filled: t.done ? 1 : 0, size: 12 },
            { type: "text" as const, text: t.title, size: 14, pixel: false, grow: 1, wrap: false, gray: t.done ? 0.5 : 1 },
            ...(due ? [{ type: "text" as const, text: overdue ? "overdue" : due.toLocaleDateString(req.locale, { day: "numeric", month: "short" }), size: 11, pixel: false, gray: 0.5, bold: !!overdue }] : []),
          ],
        };
      });
      if (list.length > max) rows.push({ type: "row", gap: 0, align: "center", children: [{ type: "text", text: `+${list.length - max} more`, size: 11, pixel: false, gray: 0.5, grow: 1, wrap: false }] });
      return { type: "col", grow: 1, gap: 4, children: rows };
    };
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
