import { defineModule } from "@orbis/sdk/server";

export type Habit = { id: string; name: string; color: string; target_per_week: number; sort: number; created_at: string };
export type HabitWithStats = Habit & { doneToday: boolean; streak: number; last30: number; days: string[] };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const PALETTE = ["#e2789b", "#8b7fd6", "#4fc47f", "#f0b232", "#4f93d6", "#f23f43", "#2f9fbf", "#d9702e"];

export default defineModule({
  setup(ctx) {
    const { storage: db, http, events } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:habits}} (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, target_per_week INTEGER NOT NULL DEFAULT 7, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:checks}} (habit_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (habit_id, day))`);
    const habits = () => db.sql<Habit>(`SELECT * FROM {{t:habits}} ORDER BY sort, created_at`);
    const changed = () => events.publish("changed");

    function stats(h: Habit, daysBack = 400): HabitWithStats {
      const since = new Date();
      since.setDate(since.getDate() - daysBack);
      const days = db.sql<{ day: string }>(`SELECT day FROM {{t:checks}} WHERE habit_id = ? AND day >= ? ORDER BY day`, [h.id, dayKey(since)]).map((r) => r.day);
      const set = new Set(days);
      const today = dayKey();
      // streak: count back from today (or yesterday if today is not done yet)
      let streak = 0;
      const cur = new Date();
      if (!set.has(today)) cur.setDate(cur.getDate() - 1);
      while (set.has(dayKey(cur))) {
        streak++;
        cur.setDate(cur.getDate() - 1);
      }
      const d30 = new Date();
      d30.setDate(d30.getDate() - 30);
      return { ...h, doneToday: set.has(today), streak, last30: days.filter((d) => d >= dayKey(d30)).length, days };
    }

    http.get("/habits", (c) => c.json(habits().map((h) => stats(h, Number(c.req.query("days") ?? 400)))));
    http.post("/habits", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { name?: string; color?: string; targetPerWeek?: number };
      if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
      const id = uid();
      db.run(`INSERT INTO {{t:habits}} (id, name, color, target_per_week, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, b.name.trim(), b.color ?? PALETTE[habits().length % PALETTE.length], b.targetPerWeek ?? 7, habits().length, new Date().toISOString()]);
      changed();
      return c.json(stats(habits().find((h) => h.id === id)!), 201);
    });
    http.patch("/habits/:id", async (c) => {
      const id = c.req.param("id");
      const b = (await c.req.json().catch(() => ({}))) as { name?: string; color?: string; targetPerWeek?: number };
      if (b.name !== undefined) db.run(`UPDATE {{t:habits}} SET name = ? WHERE id = ?`, [b.name, id]);
      if (b.color !== undefined) db.run(`UPDATE {{t:habits}} SET color = ? WHERE id = ?`, [b.color, id]);
      if (b.targetPerWeek !== undefined) db.run(`UPDATE {{t:habits}} SET target_per_week = ? WHERE id = ?`, [b.targetPerWeek, id]);
      changed();
      return c.json({ ok: true });
    });
    http.delete("/habits/:id", (c) => {
      db.run(`DELETE FROM {{t:checks}} WHERE habit_id = ?`, [c.req.param("id")]);
      db.run(`DELETE FROM {{t:habits}} WHERE id = ?`, [c.req.param("id")]);
      changed();
      return c.json({ ok: true });
    });
    http.post("/toggle", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { habitId?: string; day?: string };
      if (!b.habitId) return c.json({ error: "habitId required" }, 400);
      const day = b.day ?? dayKey();
      const has = db.sql(`SELECT 1 FROM {{t:checks}} WHERE habit_id = ? AND day = ?`, [b.habitId, day]).length > 0;
      if (has) db.run(`DELETE FROM {{t:checks}} WHERE habit_id = ? AND day = ?`, [b.habitId, day]);
      else db.run(`INSERT INTO {{t:checks}} (habit_id, day) VALUES (?, ?)`, [b.habitId, day]);
      changed();
      const h = habits().find((x) => x.id === b.habitId);
      return c.json(h ? stats(h) : { ok: true });
    });

    // evening nudge for whatever is still open
    ctx.scheduler.every("nudge", 30 * 60_000, () => {
      const now = new Date();
      if (now.getHours() !== 20 || now.getMinutes() >= 30) return;
      const open = habits().map((h) => stats(h, 1)).filter((h) => !h.doneToday);
      if (open.length) ctx.notify({ key: `open:${dayKey()}`, title: ctx.i18n.t("notify.open", { count: open.length }), body: open.map((h) => h.name).join(", "), icon: "check-double", url: "/m/?id=habits&page=habits" });
      else ctx.dismissNotification(`open:${dayKey()}`);
    });

    einkRender = (req) => {
      const list = habits().map((h) => stats(h, 1));
      if (!list.length) return { type: "text", text: ctx.i18n.t("eink.empty"), size: 12, gray: 0.5 };
      return { type: "col", grow: 1, gap: 4, children: list.map((h) => ({ type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "dots" as const, count: 1, filled: h.doneToday ? 1 : 0, size: 12 }, { type: "text" as const, text: h.name, size: 13, pixel: false, grow: 1, wrap: false }, { type: "text" as const, text: ctx.i18n.t("common.streakShort", { count: h.streak }), size: 11, pixel: false, gray: 0.5 }] })) };
    };
    ctx.logger.info("habits ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
