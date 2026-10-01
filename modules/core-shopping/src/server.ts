import { defineModule } from "@orbis/sdk/server";

export type ShopItem = { id: string; list: string; name: string; qty: string | null; aisle: string | null; done: number; sort: number; created_at: string; done_at: string | null; times: number };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();

/** "2x milk", "milk 2", "3 bananas @fruit" → name, qty, aisle */
export function parseQuick(input: string): { name: string; qty: string | null; aisle: string | null } {
  let s = input.trim();
  let aisle: string | null = null;
  const at = s.match(/\s@(\S+)\s*$/);
  if (at) {
    aisle = at[1]!;
    s = s.slice(0, at.index).trim();
  }
  let qty: string | null = null;
  let m = s.match(/^(\d+(?:[.,]\d+)?\s*(?:x|kg|g|l|ml|pcs|pack|packs|stk)?)\s+(.+)$/i);
  if (m) {
    qty = m[1]!.replace(/\s+/g, "").replace(/x$/i, "");
    s = m[2]!;
  } else if ((m = s.match(/^(.+?)\s+(\d+(?:[.,]\d+)?\s*(?:x|kg|g|l|ml|pcs|pack|packs|stk)?)$/i))) {
    s = m[1]!;
    qty = m[2]!.replace(/\s+/g, "").replace(/x$/i, "");
  }
  return { name: s.trim(), qty, aisle };
}

export default defineModule({
  setup(ctx) {
    const { storage: db, http, events } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:items}} (id TEXT PRIMARY KEY, list TEXT NOT NULL DEFAULT 'groceries', name TEXT NOT NULL, qty TEXT, aisle TEXT, done INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT, times INTEGER NOT NULL DEFAULT 1)`);
    const changed = () => events.publish("changed");
    const items = (list: string, includeDone: boolean) => db.sql<ShopItem>(`SELECT * FROM {{t:items}} WHERE list = ?${includeDone ? "" : " AND done = 0"} ORDER BY done, aisle IS NULL, aisle, sort, created_at`, [list]);

    http.get("/lists", (c) => c.json(db.sql<{ list: string; open: number }>(`SELECT list, SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS open FROM {{t:items}} GROUP BY list ORDER BY list`)));
    http.get("/items", (c) => c.json(items(c.req.query("list") || "groceries", c.req.query("done") === "1")));
    /** suggestions: things you bought before, most often first */
    http.get("/suggest", (c) => {
      const q = (c.req.query("q") ?? "").toLowerCase();
      const list = c.req.query("list") || "groceries";
      const rows = db.sql<{ name: string; aisle: string | null; times: number }>(`SELECT name, aisle, MAX(times) AS times FROM {{t:items}} WHERE list = ? AND lower(name) LIKE ? GROUP BY lower(name) ORDER BY times DESC, name LIMIT 8`, [list, `${q}%`]);
      return c.json(rows);
    });
    http.post("/items", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { text?: string; name?: string; qty?: string; aisle?: string; list?: string };
      const list = b.list || "groceries";
      const parsed = b.text ? parseQuick(b.text) : { name: b.name?.trim() ?? "", qty: b.qty ?? null, aisle: b.aisle ?? null };
      if (!parsed.name) return c.json({ error: "name required" }, 400);
      // re-adding something bought before: bring it back instead of duplicating, remember the aisle
      const prev = db.sql<ShopItem>(`SELECT * FROM {{t:items}} WHERE list = ? AND lower(name) = lower(?) ORDER BY done ASC LIMIT 1`, [list, parsed.name])[0];
      if (prev) {
        db.run(`UPDATE {{t:items}} SET done = 0, done_at = NULL, qty = COALESCE(?, qty), aisle = COALESCE(?, aisle), times = times + 1, created_at = ? WHERE id = ?`, [parsed.qty, parsed.aisle, now(), prev.id]);
        changed();
        return c.json(db.sql<ShopItem>(`SELECT * FROM {{t:items}} WHERE id = ?`, [prev.id])[0]);
      }
      const id = uid();
      const sort = db.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM {{t:items}} WHERE list = ?`, [list])[0]?.n ?? 0;
      db.run(`INSERT INTO {{t:items}} (id, list, name, qty, aisle, done, sort, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`, [id, list, parsed.name, parsed.qty, parsed.aisle, sort, now()]);
      changed();
      return c.json(db.sql<ShopItem>(`SELECT * FROM {{t:items}} WHERE id = ?`, [id])[0], 201);
    });
    http.patch("/items/:id", async (c) => {
      const id = c.req.param("id");
      const b = (await c.req.json().catch(() => ({}))) as Partial<{ name: string; qty: string | null; aisle: string | null; done: boolean }>;
      if (b.name !== undefined) db.run(`UPDATE {{t:items}} SET name = ? WHERE id = ?`, [b.name, id]);
      if (b.qty !== undefined) db.run(`UPDATE {{t:items}} SET qty = ? WHERE id = ?`, [b.qty, id]);
      if (b.aisle !== undefined) db.run(`UPDATE {{t:items}} SET aisle = ? WHERE id = ?`, [b.aisle, id]);
      if (b.done !== undefined) db.run(`UPDATE {{t:items}} SET done = ?, done_at = ? WHERE id = ?`, [b.done ? 1 : 0, b.done ? now() : null, id]);
      changed();
      return c.json(db.sql<ShopItem>(`SELECT * FROM {{t:items}} WHERE id = ?`, [id])[0] ?? { ok: true });
    });
    http.delete("/items/:id", (c) => {
      db.run(`DELETE FROM {{t:items}} WHERE id = ?`, [c.req.param("id")]);
      changed();
      return c.json({ ok: true });
    });
    http.post("/clear-done", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { list?: string };
      // keep history (for suggestions) but hide: done items stay, only very old ones go
      db.run(`DELETE FROM {{t:items}} WHERE list = ? AND done = 1 AND done_at < ?`, [b.list || "groceries", new Date(Date.now() - 90 * 86400_000).toISOString()]);
      changed();
      return c.json({ ok: true });
    });

    einkRender = (req) => {
      const cfg = req.config as { list?: string };
      const list = items(cfg.list || "groceries", false);
      if (!list.length) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: "list is empty", size: 14, gray: 0.5 }] };
      const max = Math.max(1, Math.floor((req.height - 4) / 20));
      const rows: import("@orbis/sdk/server").EinkTree[] = list.slice(0, max).map((i) => ({ type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "dots" as const, count: 1, filled: 0, size: 12 }, { type: "text" as const, text: `${i.qty ? `${i.qty} ` : ""}${i.name}`, size: 14, pixel: false, grow: 1, wrap: false }, ...(i.aisle ? [{ type: "text" as const, text: i.aisle, size: 11, pixel: false, gray: 0.5 }] : [])] }));
      if (list.length > max) rows.push({ type: "row", gap: 0, align: "center", children: [{ type: "dots", count: 0, filled: 0, size: 0 }, { type: "text", text: `+${list.length - max} more`, size: 11, pixel: false, gray: 0.5, grow: 1, wrap: false }] });
      return { type: "col", grow: 1, gap: 4, children: rows };
    };
    ctx.logger.info("shopping ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
