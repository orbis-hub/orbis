import { defineModule, invalid, notFound, parseBody, z } from "@orbis/sdk/server";

export type Link = { id: string; title: string; url: string; group: string; icon: string | null; favicon: string | null; sort: number };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const URL_MAX = 2048;
export const TITLE_MAX = 200;
export const GROUP_MAX = 100;

/**
 * Accept only http(s) links. A bare "example.com" gets https:// in front; anything with another scheme
 * (javascript:, ftp:, file:, data:) is refused, as is a url without a host.
 */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.length > URL_MAX) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
  return u.toString();
}

const urlSchema = z.string().trim().min(1, "url required").max(URL_MAX, `url: at most ${URL_MAX} characters`);
const titleSchema = z.string().trim().max(TITLE_MAX, `title: at most ${TITLE_MAX} characters`);
/** whitespace-only group → "" (= the default group) */
const groupSchema = z.string().trim().max(GROUP_MAX, `group: at most ${GROUP_MAX} characters`);
const iconSchema = z.string().trim().max(64, "icon: at most 64 characters").nullable();
const sortSchema = z.number().int().min(0).max(1_000_000);
const badUrl = (c: Parameters<typeof invalid>[0]) => invalid(c, [{ path: "url", message: "url must start with http:// or https://" }]);

export default defineModule({
  setup(ctx) {
    const { storage: db, http, events, logger } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:links}} (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, "group" TEXT NOT NULL DEFAULT '', icon TEXT, favicon TEXT, sort INTEGER NOT NULL DEFAULT 0)`);
    const all = () => db.sql<Link>(`SELECT * FROM {{t:links}} ORDER BY "group", sort, title`);
    const exists = (id: string) => db.sql<{ id: string }>(`SELECT id FROM {{t:links}} WHERE id = ?`, [id]).length > 0;
    const changed = () => events.publish("changed");

    /** fetch /favicon.ico (or the <link rel=icon>) through the hub and store it as a data url, so no browser talks to the site before you click */
    async function fetchFavicon(url: string): Promise<string | null> {
      try {
        const u = new URL(url);
        const candidates = [`${u.origin}/favicon.ico`];
        try {
          const html = await (await ctx.fetch(u.origin, { signal: AbortSignal.timeout(6000), headers: { accept: "text/html" }, maxBytes: 512 * 1024 })).text();
          const m = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i);
          const href = m?.[0].match(/href=["']([^"']+)["']/i)?.[1];
          if (href) candidates.unshift(new URL(href, u.origin).toString());
        } catch {
          /* no html, fine */
        }
        for (const c of candidates) {
          const res = await ctx.fetch(c, { signal: AbortSignal.timeout(6000), maxBytes: 200 * 1024 });
          if (!res.ok) continue;
          const type = res.headers.get("content-type") ?? "image/x-icon";
          if (!type.startsWith("image/")) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.byteLength > 200 * 1024 || buf.byteLength < 16) continue;
          return `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
        }
      } catch (err) {
        logger.debug(`favicon ${url}: ${(err as Error).message}`);
      }
      return null;
    }

    http.get("/links", (c) => {
      const g = c.req.query("group");
      return c.json(g ? all().filter((l) => l.group === g) : all());
    });
    http.get("/groups", (c) => c.json([...new Set(all().map((l) => l.group))]));
    http.post("/links", async (c) => {
      const b = await parseBody(c, z.object({ url: urlSchema, title: titleSchema.optional(), group: groupSchema.optional(), icon: iconSchema.optional() }));
      if (!b.ok) return b.res;
      const url = normalizeUrl(b.data.url);
      if (!url) return badUrl(c);
      const id = uid();
      const title = b.data.title || new URL(url).hostname.replace(/^www\./, "");
      db.run(`INSERT INTO {{t:links}} (id, title, url, "group", icon, favicon, sort) VALUES (?, ?, ?, ?, ?, NULL, ?)`, [id, title, url, b.data.group ?? "", b.data.icon || null, all().length]);
      changed();
      void fetchFavicon(url).then((fav) => {
        if (fav) {
          db.run(`UPDATE {{t:links}} SET favicon = ? WHERE id = ?`, [fav, id]);
          changed();
        }
      });
      return c.json(all().find((l) => l.id === id), 201);
    });
    http.patch("/links/:id", async (c) => {
      const id = c.req.param("id");
      if (!exists(id)) return notFound(c, "link not found");
      const b = await parseBody(c, z.object({ url: urlSchema.optional(), title: titleSchema.min(1, "title must not be empty").optional(), group: groupSchema.optional(), icon: iconSchema.optional(), sort: sortSchema.optional() }));
      if (!b.ok) return b.res;
      let url: string | undefined;
      if (b.data.url !== undefined) {
        url = normalizeUrl(b.data.url) ?? undefined;
        if (!url) return badUrl(c);
      }
      if (b.data.title !== undefined) db.run(`UPDATE {{t:links}} SET title = ? WHERE id = ?`, [b.data.title, id]);
      if (url !== undefined) db.run(`UPDATE {{t:links}} SET url = ? WHERE id = ?`, [url, id]);
      if (b.data.group !== undefined) db.run(`UPDATE {{t:links}} SET "group" = ? WHERE id = ?`, [b.data.group, id]);
      if (b.data.icon !== undefined) db.run(`UPDATE {{t:links}} SET icon = ? WHERE id = ?`, [b.data.icon || null, id]);
      if (b.data.sort !== undefined) db.run(`UPDATE {{t:links}} SET sort = ? WHERE id = ?`, [b.data.sort, id]);
      if (url) void fetchFavicon(url).then((fav) => { db.run(`UPDATE {{t:links}} SET favicon = ? WHERE id = ?`, [fav, id]); changed(); });
      changed();
      return c.json(all().find((l) => l.id === id));
    });
    http.delete("/links/:id", (c) => {
      const id = c.req.param("id");
      if (!exists(id)) return notFound(c, "link not found");
      db.run(`DELETE FROM {{t:links}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });
    http.post("/reorder", async (c) => {
      const b = await parseBody(c, z.object({ ids: z.array(z.string().max(64)).max(10_000) }));
      if (!b.ok) return b.res;
      const known = new Set(all().map((l) => l.id));
      const unknown = b.data.ids.filter((id) => !known.has(id));
      if (unknown.length) return invalid(c, [{ path: "ids", message: `unknown ids: ${unknown.slice(0, 5).join(", ")}` }]);
      if (new Set(b.data.ids).size !== b.data.ids.length) return invalid(c, [{ path: "ids", message: "duplicate ids" }]);
      b.data.ids.forEach((id, i) => db.run(`UPDATE {{t:links}} SET sort = ? WHERE id = ?`, [i, id]));
      changed();
      return c.json({ ok: true });
    });
    logger.info("bookmarks ready");
  },
});
