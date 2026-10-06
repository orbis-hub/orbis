import { dateKey, defineModule, hexColor, idParam, intRange, invalid, nonEmptyString, notFound, parseBody, parseQuery, z, type EinkRequest, type EinkTree, type HttpContext } from "@orbis/sdk/server";

export type HabitKind = "check" | "count";
export type Habit = { id: string; name: string; color: string; kind: HabitKind; target_per_day: number; target_per_week: number; sort: number; created_at: string };
export type HabitWithStats = Habit & {
  /** today's count (1 for a ticked check habit) */
  todayCount: number;
  /** count >= target today */
  doneToday: boolean;
  /** consecutive done days ending today (or yesterday when today is still open), from the full history */
  streak: number;
  /** done days in the last 30 days */
  last30: number;
  /** done days this week (monday to today), compare with `target_per_week` */
  weekDone: number;
  /** done days inside the requested `?days` window, oldest first */
  days: string[];
  /** raw counts per day inside the window (only days that have a row) */
  counts: Record<string, number>;
};

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayKey(d);
};
const PALETTE = ["#e2789b", "#8b7fd6", "#4fc47f", "#f0b232", "#4f93d6", "#f23f43", "#2f9fbf", "#d9702e"];
const MAX_COUNT = 10_000;

const habitFields = {
  color: hexColor.optional(),
  kind: z.enum(["check", "count"]).optional(),
  targetPerDay: intRange(1, 1000).optional(),
  targetPerWeek: intRange(1, 7).optional(),
};
const checkInput = z.object({ habitId: idParam, day: dateKey.optional() });

export default defineModule({
  setup(ctx) {
    const { storage: db, http, events } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:habits}} (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, target_per_week INTEGER NOT NULL DEFAULT 7, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:checks}} (habit_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (habit_id, day))`);
    // v2: counter habits. existing rows become plain check habits with one tick per day.
    const cols = (table: string) => db.sql<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    const habitCols = cols("{{t:habits}}");
    if (!habitCols.includes("kind")) db.run(`ALTER TABLE {{t:habits}} ADD COLUMN kind TEXT NOT NULL DEFAULT 'check'`);
    if (!habitCols.includes("target_per_day")) db.run(`ALTER TABLE {{t:habits}} ADD COLUMN target_per_day INTEGER NOT NULL DEFAULT 1`);
    if (!cols("{{t:checks}}").includes("count")) db.run(`ALTER TABLE {{t:checks}} ADD COLUMN count INTEGER NOT NULL DEFAULT 1`);

    const habits = () => db.sql<Habit>(`SELECT * FROM {{t:habits}} ORDER BY sort, created_at`);
    const habit = (id: string) => db.sql<Habit>(`SELECT * FROM {{t:habits}} WHERE id = ?`, [id])[0] ?? null;
    const changed = () => events.publish("changed");
    const targetOf = (h: Habit) => (h.kind === "count" ? h.target_per_day : 1);

    /** streak / week / last30 always use the full history; `daysBack` only trims `days` and `counts` in the response */
    function stats(h: Habit, daysBack = 400): HabitWithStats {
      const target = targetOf(h);
      const rows = db.sql<{ day: string; count: number }>(`SELECT day, count FROM {{t:checks}} WHERE habit_id = ? ORDER BY day`, [h.id]);
      const counts: Record<string, number> = {};
      const done = new Set<string>();
      for (const r of rows) {
        counts[r.day] = r.count;
        if (r.count >= target) done.add(r.day);
      }
      const today = dayKey();
      let streak = 0;
      const cur = new Date();
      if (!done.has(today)) cur.setDate(cur.getDate() - 1);
      while (done.has(dayKey(cur))) {
        streak++;
        cur.setDate(cur.getDate() - 1);
      }
      const monday = new Date();
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const weekStart = dayKey(monday);
      const since = daysAgo(daysBack);
      const d30 = daysAgo(30);
      return {
        ...h,
        todayCount: counts[today] ?? 0,
        doneToday: done.has(today),
        streak,
        last30: [...done].filter((d) => d >= d30).length,
        weekDone: [...done].filter((d) => d >= weekStart && d <= today).length,
        days: [...done].filter((d) => d >= since),
        counts: Object.fromEntries(Object.entries(counts).filter(([d]) => d >= since)),
      };
    }

    const setCount = (habitId: string, day: string, count: number) => {
      if (count <= 0) db.run(`DELETE FROM {{t:checks}} WHERE habit_id = ? AND day = ?`, [habitId, day]);
      else db.run(`INSERT INTO {{t:checks}} (habit_id, day, count) VALUES (?, ?, ?) ON CONFLICT(habit_id, day) DO UPDATE SET count = excluded.count`, [habitId, day, count]);
    };
    const countOf = (habitId: string, day: string) => db.sql<{ count: number }>(`SELECT count FROM {{t:checks}} WHERE habit_id = ? AND day = ?`, [habitId, day])[0]?.count ?? 0;

    http.get("/habits", (c) => {
      const q = parseQuery(c, z.object({ days: z.coerce.number().int().min(1).max(400).default(400) }));
      if (!q.ok) return q.res;
      return c.json(habits().map((h) => stats(h, q.data.days)));
    });
    http.post("/habits", async (c) => {
      const b = await parseBody(c, z.object({ name: nonEmptyString(200), ...habitFields }));
      if (!b.ok) return b.res;
      const id = uid();
      const n = habits().length;
      db.run(`INSERT INTO {{t:habits}} (id, name, color, kind, target_per_day, target_per_week, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        b.data.name,
        b.data.color ?? PALETTE[n % PALETTE.length],
        b.data.kind ?? "check",
        b.data.targetPerDay ?? 1,
        b.data.targetPerWeek ?? 7,
        n,
        new Date().toISOString(),
      ]);
      changed();
      return c.json(stats(habit(id)!), 201);
    });
    http.patch("/habits/:id", async (c) => {
      const id = c.req.param("id");
      if (!habit(id)) return notFound(c);
      const b = await parseBody(c, z.object({ name: nonEmptyString(200), ...habitFields }));
      if (!b.ok) return b.res;
      const d = b.data;
      db.run(`UPDATE {{t:habits}} SET name = ?, color = COALESCE(?, color), kind = COALESCE(?, kind), target_per_day = COALESCE(?, target_per_day), target_per_week = COALESCE(?, target_per_week) WHERE id = ?`, [
        d.name,
        d.color ?? null,
        d.kind ?? null,
        d.targetPerDay ?? null,
        d.targetPerWeek ?? null,
        id,
      ]);
      changed();
      return c.json(stats(habit(id)!));
    });
    http.delete("/habits/:id", (c) => {
      const id = c.req.param("id");
      if (!habit(id)) return notFound(c);
      db.run(`DELETE FROM {{t:checks}} WHERE habit_id = ?`, [id]);
      db.run(`DELETE FROM {{t:habits}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });

    /** shared preamble of /toggle, /increment, /decrement: valid body, existing habit, day not in the future */
    async function checkRequest(c: HttpContext) {
      const b = await parseBody(c, checkInput);
      if (!b.ok) return { res: b.res };
      const h = habit(b.data.habitId);
      if (!h) return { res: notFound(c, "habit not found") };
      const day = b.data.day ?? dayKey();
      if (day > dayKey()) return { res: invalid(c, [{ path: "day", message: "day must not be in the future" }]) };
      return { h, day };
    }
    const respond = (c: HttpContext, h: Habit) => {
      changed();
      return c.json(stats(h));
    };
    /** check habit: tick/untick. count habit: jump to the target or back to zero. */
    http.post("/toggle", async (c) => {
      const r = await checkRequest(c);
      if ("res" in r) return r.res;
      const { h, day } = r;
      setCount(h.id, day, countOf(h.id, day) >= targetOf(h) ? 0 : targetOf(h));
      return respond(c, h);
    });
    http.post("/increment", async (c) => {
      const r = await checkRequest(c);
      if ("res" in r) return r.res;
      const { h, day } = r;
      setCount(h.id, day, Math.min(h.kind === "count" ? MAX_COUNT : 1, countOf(h.id, day) + 1));
      return respond(c, h);
    });
    http.post("/decrement", async (c) => {
      const r = await checkRequest(c);
      if ("res" in r) return r.res;
      const { h, day } = r;
      setCount(h.id, day, countOf(h.id, day) - 1);
      return respond(c, h);
    });

    // evening nudge for whatever is still open
    ctx.scheduler.every("nudge", 30 * 60_000, () => {
      const now = new Date();
      if (now.getHours() !== 20 || now.getMinutes() >= 30) return;
      const open = habits().map((h) => stats(h, 1)).filter((h) => !h.doneToday);
      if (open.length) ctx.notify({ key: `open:${dayKey()}`, title: ctx.i18n.t("notify.open", { count: open.length }), body: open.map((h) => h.name).join(", "), icon: "check-double", url: "/m/?id=habits&page=habits" });
      else ctx.dismissNotification(`open:${dayKey()}`);
    });

    einkRender = () => {
      const list = habits().map((h) => stats(h, 1));
      if (!list.length) return { type: "text", text: ctx.i18n.t("eink.empty"), size: 12, gray: 0.5 };
      return {
        type: "col",
        grow: 1,
        gap: EINK_GAP,
        children: list.map((h) => ({
          type: "row" as const,
          gap: 8,
          align: "center" as const,
          height: EINK_ROW,
          children: [
            { type: "dots" as const, count: 1, filled: h.doneToday ? 1 : 0, size: 12 },
            { type: "text" as const, text: h.name, size: 13, pixel: false, grow: 1, wrap: false },
            h.kind === "count"
              ? { type: "text" as const, text: `${h.todayCount}/${h.target_per_day}`, size: 11, pixel: false, gray: h.doneToday ? 0.5 : 1, bold: !h.doneToday }
              : { type: "text" as const, text: ctx.i18n.t("common.streakShort", { count: h.streak }), size: 11, pixel: false, gray: 0.5 },
          ],
        })),
      };
    };
    einkTapHandler = (req) => {
      const list = habits();
      const h = list[Math.floor(Math.max(0, req.y) / (EINK_ROW + EINK_GAP))];
      if (!h) return { refresh: false };
      const day = dayKey();
      const cur = countOf(h.id, day);
      if (h.kind === "count") setCount(h.id, day, Math.min(MAX_COUNT, cur + 1));
      else setCount(h.id, day, cur >= 1 ? 0 : 1);
      changed();
      const s = stats(h, 1);
      return { refresh: true, toast: h.kind === "count" ? `${h.name} ${s.todayCount}/${h.target_per_day}` : ctx.i18n.t(s.doneToday ? "eink.done" : "eink.undone", { name: h.name }) };
    };
    ctx.logger.info("habits ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
  /** tap a row: count habits +1, check habits toggle today (rows are EINK_ROW px with EINK_GAP between, same as the render) */
  einkTap(_ctx, req) {
    if (!einkTapHandler) throw new Error("not ready");
    return einkTapHandler(req);
  },
});

const EINK_ROW = 20;
const EINK_GAP = 4;
let einkRender: ((req: EinkRequest) => EinkTree) | null = null;
let einkTapHandler: ((req: EinkRequest & { x: number; y: number }) => { refresh: boolean; toast?: string }) | null = null;
