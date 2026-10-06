import { defineModule, invalid, nonEmptyString, notFound, parseBody, z, type EinkRequest, type EinkTree } from "@orbis/sdk/server";
import { AISLE_TEMPLATES, detectAisle, resolveAisle, type AisleId } from "./aisles";

export type ShopItem = { id: string; list: string; name: string; qty: string | null; aisle: string | null; done: number; sort: number; created_at: string; done_at: string | null; times: number };
export type AisleInfo = { id: AisleId; icon: string; name: string };
export type AislesResponse = { templates: AisleInfo[]; used: string[] };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();
const DEFAULT_LIST = "groceries";
/** bought items older than this are what "clear old" removes */
export const CLEAR_AFTER_DAYS = 90;

const MAX_NAME = 200;
/** list names are user-typed tabs ("groceries", "hardware store"); kept lowercase like the page does */
const listName = z.string().trim().min(1, "must not be empty").max(100).transform((s) => s.toLowerCase());
const qtyInput = z.string().trim().max(50).transform((s) => s || null);
const aisleInput = z.string().trim().max(100).transform((s) => s || null);

/** store-walk order: template aisles first (fruit → … → other), then free-form aisles alphabetically, no aisle last */
const AISLE_RANK_SQL = `CASE aisle ${AISLE_TEMPLATES.map((a, i) => `WHEN '${a.id}' THEN ${i}`).join(" ")} ELSE ${AISLE_TEMPLATES.length} END`;
const ORDER_SQL = `ORDER BY done, aisle IS NULL, ${AISLE_RANK_SQL}, aisle, sort, created_at`;

/** `%` and `_` are wildcards in LIKE; make user input literal (used with ESCAPE '\') */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** "2x milk", "milk 2", "3 bananas @fruit", "@fruit 3 bananas" → name, qty, aisle (aisle is the raw `@…` text, see resolveAisle) */
export function parseQuick(input: string): { name: string; qty: string | null; aisle: string | null } {
  let s = input.trim();
  let aisle: string | null = null;
  const atEnd = s.match(/(?:^|\s)@(\S+)\s*$/);
  const atStart = s.match(/^@(\S+)(?:\s+|$)/);
  if (atEnd) {
    aisle = atEnd[1]!;
    s = s.slice(0, atEnd.index).trim();
  } else if (atStart) {
    aisle = atStart[1]!;
    s = s.slice(atStart[0].length).trim();
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
    const { storage: db, http, events, i18n } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:items}} (id TEXT PRIMARY KEY, list TEXT NOT NULL DEFAULT 'groceries', name TEXT NOT NULL, qty TEXT, aisle TEXT, done INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT, times INTEGER NOT NULL DEFAULT 1)`);
    const changed = () => events.publish("changed");
    const items = (list: string, includeDone: boolean) => db.sql<ShopItem>(`SELECT * FROM {{t:items}} WHERE list = ?${includeDone ? "" : " AND done = 0"} ${ORDER_SQL}`, [list]);
    const item = (id: string) => db.sql<ShopItem>(`SELECT * FROM {{t:items}} WHERE id = ?`, [id])[0] ?? null;
    /** translated template names of the hub's current language → id, so `@obst` also works when it is not a built-in alias */
    const localNames = () => Object.fromEntries(AISLE_TEMPLATES.map((a) => [i18n.t(`aisle.${a.id}`), a.id])) as Record<string, AisleId>;
    const canonAisle = (raw: string | null | undefined) => resolveAisle(raw, localNames());
    /** aisle for a new item: explicit → what this name had last time (any list) → keyword dictionary */
    const guessAisle = (name: string): string | null => {
      const learned = db.sql<{ aisle: string }>(`SELECT aisle FROM {{t:items}} WHERE lower(name) = lower(?) AND aisle IS NOT NULL AND aisle != '' ORDER BY times DESC, COALESCE(done_at, created_at) DESC LIMIT 1`, [name])[0];
      if (learned) return canonAisle(learned.aisle);
      return detectAisle(name);
    };
    const usedAisles = (list: string) => db.sql<{ aisle: string }>(`SELECT DISTINCT aisle FROM {{t:items}} WHERE list = ? AND aisle IS NOT NULL AND aisle != '' ORDER BY aisle`, [list]).map((r) => r.aisle);
    const listOf = (raw: string | undefined) => (raw ?? "").trim().toLowerCase() || DEFAULT_LIST;

    http.get("/lists", (c) => c.json(db.sql<{ list: string; open: number }>(`SELECT list, SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS open FROM {{t:items}} GROUP BY list ORDER BY list`)));
    http.get("/items", (c) => c.json(items(listOf(c.req.query("list")), c.req.query("done") === "1")));
    /** aisle templates (store order, translated) + free-form aisles already used in the list */
    http.get("/aisles", (c) => {
      const list = listOf(c.req.query("list"));
      const templates: AisleInfo[] = AISLE_TEMPLATES.map((a) => ({ id: a.id, icon: a.icon, name: i18n.t(`aisle.${a.id}`) }));
      const ids = new Set<string>(templates.map((t) => t.id));
      const used = usedAisles(list).filter((a) => !ids.has(a));
      return c.json({ templates, used } satisfies AislesResponse);
    });
    /** suggestions: things you bought before, most often first */
    http.get("/suggest", (c) => {
      const q = (c.req.query("q") ?? "").trim().slice(0, MAX_NAME).toLowerCase();
      const list = listOf(c.req.query("list"));
      const rows = db.sql<{ name: string; aisle: string | null; times: number }>(
        `SELECT name, aisle, MAX(times) AS times FROM {{t:items}} WHERE list = ? AND lower(name) LIKE ? ESCAPE '\\' GROUP BY lower(name) ORDER BY times DESC, name LIMIT 8`,
        [list, `${escapeLike(q)}%`],
      );
      return c.json(rows);
    });
    http.post("/items", async (c) => {
      const b = await parseBody(
        c,
        z.object({
          /** quick-add line, parsed ("2x milk @fridge"); or the explicit fields below */
          text: z.string().trim().max(MAX_NAME + 60).optional(),
          name: z.string().trim().max(MAX_NAME).optional(),
          qty: qtyInput.nullable().optional(),
          aisle: aisleInput.nullable().optional(),
          list: listName.optional(),
        }),
      );
      if (!b.ok) return b.res;
      const list = b.data.list ?? DEFAULT_LIST;
      const parsed = b.data.text ? parseQuick(b.data.text) : { name: b.data.name ?? "", qty: b.data.qty ?? null, aisle: b.data.aisle ?? null };
      if (!parsed.name) return invalid(c, [{ path: b.data.text !== undefined ? "text" : "name", message: i18n.t("error.nameRequired") }]);
      if (parsed.name.length > MAX_NAME) return invalid(c, [{ path: "name", message: `at most ${MAX_NAME} characters` }]);
      const explicit = canonAisle(parsed.aisle);
      // re-adding something bought before: bring it back instead of duplicating, remember the aisle
      const prev = db.sql<ShopItem>(`SELECT * FROM {{t:items}} WHERE list = ? AND lower(name) = lower(?) ORDER BY done ASC LIMIT 1`, [list, parsed.name])[0];
      if (prev) {
        const aisle = explicit ?? prev.aisle ?? guessAisle(parsed.name);
        db.run(`UPDATE {{t:items}} SET done = 0, done_at = NULL, qty = COALESCE(?, qty), aisle = ?, times = times + ?, created_at = ? WHERE id = ?`, [parsed.qty, aisle, prev.done ? 1 : 0, now(), prev.id]);
        changed();
        return c.json(item(prev.id));
      }
      const id = uid();
      const sort = db.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM {{t:items}} WHERE list = ?`, [list])[0]?.n ?? 0;
      const aisle = explicit ?? guessAisle(parsed.name);
      db.run(`INSERT INTO {{t:items}} (id, list, name, qty, aisle, done, sort, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`, [id, list, parsed.name, parsed.qty, aisle, sort, now()]);
      changed();
      return c.json(item(id), 201);
    });
    http.patch("/items/:id", async (c) => {
      const id = c.req.param("id");
      const cur = item(id);
      if (!cur) return notFound(c);
      const b = await parseBody(c, z.object({ name: nonEmptyString(MAX_NAME).optional(), qty: qtyInput.nullable().optional(), aisle: aisleInput.nullable().optional(), done: z.boolean().optional() }));
      if (!b.ok) return b.res;
      const d = b.data;
      if (d.name !== undefined) db.run(`UPDATE {{t:items}} SET name = ? WHERE id = ?`, [d.name, id]);
      if (d.qty !== undefined) db.run(`UPDATE {{t:items}} SET qty = ? WHERE id = ?`, [d.qty, id]);
      if (d.aisle !== undefined) db.run(`UPDATE {{t:items}} SET aisle = ? WHERE id = ?`, [canonAisle(d.aisle), id]);
      if (d.done === true && !cur.done) db.run(`UPDATE {{t:items}} SET done = 1, done_at = ? WHERE id = ?`, [now(), id]);
      // "bought recently" → back on the list: counts as buying it again, and it moves to the end like a fresh add
      if (d.done === false && cur.done) db.run(`UPDATE {{t:items}} SET done = 0, done_at = NULL, times = times + 1, created_at = ? WHERE id = ?`, [now(), id]);
      changed();
      return c.json(item(id));
    });
    http.delete("/items/:id", (c) => {
      const id = c.req.param("id");
      if (!item(id)) return notFound(c);
      db.run(`DELETE FROM {{t:items}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });
    /** bought items stay (they feed the suggestions and "bought recently"); this drops the ones older than CLEAR_AFTER_DAYS */
    http.post("/clear-done", async (c) => {
      const b = await parseBody(c, z.object({ list: listName.optional() }));
      if (!b.ok) return b.res;
      const r = db.run(`DELETE FROM {{t:items}} WHERE list = ? AND done = 1 AND done_at < ?`, [b.data.list ?? DEFAULT_LIST, new Date(Date.now() - CLEAR_AFTER_DAYS * 86400_000).toISOString()]);
      changed();
      return c.json({ ok: true, removed: Number(r.changes) });
    });

    const aisleLabel = (aisle: string) => (AISLE_TEMPLATES.some((a) => a.id === aisle) ? i18n.t(`aisle.${aisle}`) : aisle);
    einkRender = (req) => {
      const cfg = req.config as { list?: string };
      const list = items(listOf(cfg.list), false);
      if (!list.length) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: i18n.t("list.empty"), size: 14, gray: 0.5 }] };
      const max = Math.max(1, Math.floor((req.height - 4) / 20));
      const rows: EinkTree[] = list.slice(0, max).map((i) => ({ type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "dots" as const, count: 1, filled: 0, size: 12 }, { type: "text" as const, text: `${i.qty ? `${i.qty} ` : ""}${i.name}`, size: 14, pixel: false, grow: 1, wrap: false }, ...(i.aisle ? [{ type: "text" as const, text: aisleLabel(i.aisle), size: 11, pixel: false, gray: 0.5 }] : [])] }));
      if (list.length > max) rows.push({ type: "row", gap: 0, align: "center", children: [{ type: "dots", count: 0, filled: 0, size: 0 }, { type: "text", text: i18n.t("list.more", { count: list.length - max }), size: 11, pixel: false, gray: 0.5, grow: 1, wrap: false }] });
      return { type: "col", grow: 1, gap: 4, children: rows };
    };
    ctx.logger.info("shopping ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
  /** tap a row on the e-ink list → item is bought (rows are 20px, same as the render) */
  einkTap(ctx, req) {
    const cfg = req.config as { list?: string };
    const list = ctx.storage.sql<ShopItem>(`SELECT * FROM {{t:items}} WHERE list = ? AND done = 0 ${ORDER_SQL}`, [(cfg.list ?? "").trim().toLowerCase() || DEFAULT_LIST]);
    const idx = Math.floor(Math.max(0, req.y) / 20);
    const item = list[idx];
    if (!item) return { refresh: false };
    ctx.storage.run(`UPDATE {{t:items}} SET done = 1, done_at = ? WHERE id = ?`, [new Date().toISOString(), item.id]);
    ctx.events.publish("changed");
    return { refresh: true, toast: ctx.i18n.t("eink.bought", { name: item.name }) };
  },
});

let einkRender: ((req: EinkRequest) => EinkTree) | null = null;
