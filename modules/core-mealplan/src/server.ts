import { defineModule } from "@orbis/sdk/server";

export type Recipe = { id: string; title: string; url: string | null; image: string | null; servings: string | null; ingredients: string[]; steps: string[]; tags: string[]; created_at: string };
export type PlanEntry = { day: string; slot: string; recipe_id: string | null; note: string | null; recipe?: Pick<Recipe, "id" | "title" | "image" | "url"> | null };
type RecipeRow = Omit<Recipe, "ingredients" | "steps" | "tags"> & { ingredients: string; steps: string; tags: string };
type Settings = { slots?: string; shoppingList?: string };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const parseSlots = (s?: string) => (s ?? "lunch, dinner").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 5);

const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const asArray = <T,>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** schema.org Recipe out of whatever a food blog put in its json-ld */
export function extractRecipe(html: string, url: string): Omit<Recipe, "id" | "created_at"> | null {
  const scripts = [...html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!);
  const nodes: Array<Record<string, unknown>> = [];
  for (const raw of scripts) {
    try {
      const json = JSON.parse(raw.trim()) as unknown;
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === "object") {
          const o = n as Record<string, unknown>;
          nodes.push(o);
          if (o["@graph"]) walk(o["@graph"]);
        }
      };
      walk(json);
    } catch {
      /* broken json-ld happens a lot, skip it */
    }
  }
  const isRecipe = (o: Record<string, unknown>) => asArray(o["@type"] as string | string[]).some((t) => String(t).toLowerCase() === "recipe");
  const r = nodes.find(isRecipe);
  if (!r) {
    // last resort: og:title only
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? html.match(/<title>([^<]+)<\/title>/i)?.[1];
    return og ? { title: strip(og), url, image: null, servings: null, ingredients: [], steps: [], tags: [] } : null;
  }
  const image = (() => {
    const im = r.image as unknown;
    const first = asArray(im)[0] as unknown;
    if (!first) return null;
    if (typeof first === "string") return first;
    if (typeof first === "object") return ((first as { url?: string; contentUrl?: string }).url ?? (first as { contentUrl?: string }).contentUrl) ?? null;
    return null;
  })();
  const steps: string[] = [];
  const pushStep = (s: unknown) => {
    if (!s) return;
    if (typeof s === "string") return void steps.push(strip(s));
    if (Array.isArray(s)) return s.forEach(pushStep);
    const o = s as { "@type"?: string; text?: string; name?: string; itemListElement?: unknown };
    if (o.itemListElement) return pushStep(o.itemListElement);
    if (o.text) steps.push(strip(o.text));
    else if (o.name) steps.push(strip(o.name));
  };
  pushStep(r.recipeInstructions);
  const yieldv = asArray(r.recipeYield as string | number | Array<string | number>)[0];
  return {
    title: strip(String(r.name ?? r.headline ?? "untitled")),
    url,
    image,
    servings: yieldv == null ? null : String(yieldv),
    ingredients: asArray(r.recipeIngredient as string | string[]).map((x) => strip(String(x))).filter(Boolean),
    steps: steps.filter(Boolean),
    tags: [...asArray(r.recipeCategory as string | string[]), ...asArray(r.recipeCuisine as string | string[]), ...asArray(r.keywords as string | string[]).flatMap((k) => String(k).split(","))].map((t) => strip(String(t)).toLowerCase()).filter((t, i, a) => t && a.indexOf(t) === i).slice(0, 8),
  };
}

export default defineModule<Settings>({
  setup(ctx) {
    const { storage: db, http, events, settings, logger } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:recipes}} (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT, image TEXT, servings TEXT, ingredients TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:plan}} (day TEXT NOT NULL, slot TEXT NOT NULL, recipe_id TEXT, note TEXT, PRIMARY KEY (day, slot))`);
    const changed = () => events.publish("changed");
    const parse = (r: RecipeRow): Recipe => ({ ...r, ingredients: JSON.parse(r.ingredients), steps: JSON.parse(r.steps), tags: JSON.parse(r.tags) });
    const recipe = (id: string) => {
      const r = db.sql<RecipeRow>(`SELECT * FROM {{t:recipes}} WHERE id = ?`, [id])[0];
      return r ? parse(r) : null;
    };
    const plan = (from: string, to: string): PlanEntry[] =>
      db.sql<PlanEntry & { r_title: string | null; r_image: string | null; r_url: string | null }>(`SELECT p.day, p.slot, p.recipe_id, p.note, r.title AS r_title, r.image AS r_image, r.url AS r_url FROM {{t:plan}} p LEFT JOIN {{t:recipes}} r ON r.id = p.recipe_id WHERE p.day >= ? AND p.day <= ? ORDER BY p.day, p.slot`, [from, to]).map(({ r_title, r_image, r_url, ...p }) => ({ ...p, recipe: p.recipe_id && r_title ? { id: p.recipe_id, title: r_title, image: r_image, url: r_url } : null }));

    http.get("/recipes", (c) => {
      const q = (c.req.query("q") ?? "").toLowerCase();
      const rows = db.sql<RecipeRow>(`SELECT * FROM {{t:recipes}} ${q ? "WHERE lower(title) LIKE ? OR lower(tags) LIKE ?" : ""} ORDER BY title`, q ? [`%${q}%`, `%${q}%`] : []);
      return c.json(rows.map(parse));
    });
    http.get("/recipes/:id", (c) => {
      const r = recipe(c.req.param("id"));
      return r ? c.json(r) : c.json({ error: "not found" }, 404);
    });
    http.post("/recipes", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as Partial<Recipe>;
      if (!b.title?.trim()) return c.json({ error: "title required" }, 400);
      const id = uid();
      db.run(`INSERT INTO {{t:recipes}} (id, title, url, image, servings, ingredients, steps, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, b.title.trim(), b.url ?? null, b.image ?? null, b.servings ?? null, JSON.stringify(b.ingredients ?? []), JSON.stringify(b.steps ?? []), JSON.stringify(b.tags ?? []), now()]);
      changed();
      return c.json(recipe(id), 201);
    });
    http.patch("/recipes/:id", async (c) => {
      const id = c.req.param("id");
      const b = (await c.req.json().catch(() => ({}))) as Partial<Recipe>;
      const cur = recipe(id);
      if (!cur) return c.json({ error: "not found" }, 404);
      const n = { ...cur, ...b };
      db.run(`UPDATE {{t:recipes}} SET title = ?, url = ?, image = ?, servings = ?, ingredients = ?, steps = ?, tags = ? WHERE id = ?`, [n.title, n.url, n.image, n.servings, JSON.stringify(n.ingredients), JSON.stringify(n.steps), JSON.stringify(n.tags), id]);
      changed();
      return c.json(recipe(id));
    });
    http.delete("/recipes/:id", (c) => {
      const id = c.req.param("id");
      db.run(`UPDATE {{t:plan}} SET recipe_id = NULL WHERE recipe_id = ?`, [id]);
      db.run(`DELETE FROM {{t:recipes}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });
    /** import a recipe from a url (json-ld). preview=1 returns without saving. */
    http.post("/import", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { url?: string; preview?: boolean };
      let url = b.url?.trim() ?? "";
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (!url) return c.json({ error: "url required" }, 400);
      try {
        const res = await ctx.fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", accept: "text/html,application/xhtml+xml", "accept-language": "en,de;q=0.8" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
        if (!res.ok) return c.json({ error: `HTTP ${res.status}` }, 502);
        const html = (await res.text()).slice(0, 3_000_000);
        const r = extractRecipe(html, url);
        if (!r) return c.json({ error: ctx.i18n.t("error.noRecipe") }, 422);
        if (b.preview) return c.json(r);
        const id = uid();
        db.run(`INSERT INTO {{t:recipes}} (id, title, url, image, servings, ingredients, steps, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, r.title, r.url, r.image, r.servings, JSON.stringify(r.ingredients), JSON.stringify(r.steps), JSON.stringify(r.tags), now()]);
        changed();
        return c.json(recipe(id), 201);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    });

    http.get("/slots", (c) => c.json(parseSlots(settings.get().slots)));
    http.get("/plan", (c) => {
      const from = c.req.query("from") ?? "";
      const to = c.req.query("to") ?? "";
      if (!DAY.test(from) || !DAY.test(to)) return c.json({ error: "from/to as YYYY-MM-DD" }, 400);
      return c.json(plan(from, to));
    });
    http.put("/plan", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { day?: string; slot?: string; recipeId?: string | null; note?: string | null };
      if (!b.day || !DAY.test(b.day) || !b.slot) return c.json({ error: "day + slot required" }, 400);
      if (!b.recipeId && !b.note) db.run(`DELETE FROM {{t:plan}} WHERE day = ? AND slot = ?`, [b.day, b.slot]);
      else db.run(`INSERT INTO {{t:plan}} (day, slot, recipe_id, note) VALUES (?, ?, ?, ?) ON CONFLICT(day, slot) DO UPDATE SET recipe_id = excluded.recipe_id, note = excluded.note`, [b.day, b.slot.toLowerCase(), b.recipeId ?? null, b.note ?? null]);
      changed();
      return c.json(plan(b.day, b.day));
    });
    /** copy a week's ingredients to the shopping module (soft dep) */
    http.get("/shopping-available", (c) => c.json({ available: ctx.modules.has("shopping") }));
    http.post("/plan/to-shopping", async (c) => {
      if (!ctx.modules.has("shopping")) return c.json({ error: "shopping module is not installed" }, 409);
      const b = (await c.req.json().catch(() => ({}))) as { from?: string; to?: string; list?: string; recipeIds?: string[] };
      const ids = b.recipeIds?.length ? b.recipeIds : b.from && b.to && DAY.test(b.from) && DAY.test(b.to) ? plan(b.from, b.to).map((p) => p.recipe_id).filter((x): x is string => !!x) : [];
      if (!ids.length) return c.json({ added: 0 });
      const list = b.list || settings.get().shoppingList || "groceries";
      let added = 0;
      const seen = new Set<string>();
      for (const id of ids) {
        const r = recipe(id);
        for (const ing of r?.ingredients ?? []) {
          const key = ing.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            await ctx.modules.call("shopping", "/items", { method: "POST", json: { text: ing, list } });
            added++;
          } catch (err) {
            logger.warn(`shopping add failed: ${(err as Error).message}`);
          }
        }
      }
      return c.json({ added, list });
    });

    einkRender = (req) => {
      const cfg = req.config as { days?: number };
      const slots = parseSlots(settings.get().slots);
      const days = Math.min(cfg.days ?? 2, 7);
      const d0 = new Date(req.now);
      d0.setHours(0, 0, 0, 0);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const to = new Date(d0);
      to.setDate(to.getDate() + days - 1);
      const entries = plan(iso(d0), iso(to));
      const children: import("@orbis/sdk/server").EinkTree[] = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(d0);
        d.setDate(d.getDate() + i);
        const label = i === 0 ? ctx.i18n.t("common.today") : i === 1 ? ctx.i18n.t("common.tomorrow") : d.toLocaleDateString(req.locale, { weekday: "long" }).toLowerCase();
        children.push({ type: "text", text: label, size: 11, gray: 0.5 });
        for (const s of slots) {
          const e = entries.find((x) => x.day === iso(d) && x.slot === s);
          children.push({ type: "row", gap: 8, align: "center", children: [{ type: "text", text: s, size: 11, pixel: false, gray: 0.5, wrap: false }, { type: "text", text: e?.recipe?.title ?? e?.note ?? "–", size: 13, pixel: false, grow: 1, wrap: false }] });
        }
      }
      return { type: "col", grow: 1, gap: 3, children };
    };
    logger.info("mealplan ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
