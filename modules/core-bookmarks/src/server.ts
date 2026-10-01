import { defineModule } from "@orbis/sdk/server";

export type Link = { id: string; title: string; url: string; group: string; icon: string | null; favicon: string | null; sort: number };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export default defineModule({
  setup(ctx) {
    const { storage: db, http, events, logger } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:links}} (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, "group" TEXT NOT NULL DEFAULT '', icon TEXT, favicon TEXT, sort INTEGER NOT NULL DEFAULT 0)`);
    const all = () => db.sql<Link>(`SELECT * FROM {{t:links}} ORDER BY "group", sort, title`);
    const changed = () => events.publish("changed");

    /** fetch /favicon.ico (or the <link rel=icon>) through the hub and store it as a data url, so no browser talks to the site before you click */
    async function fetchFavicon(url: string): Promise<string | null> {
      try {
        const u = new URL(url);
        const candidates = [`${u.origin}/favicon.ico`];
        try {
          const html = await (await ctx.fetch(u.origin, { signal: AbortSignal.timeout(6000), headers: { accept: "text/html" } })).text();
          const m = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i);
          const href = m?.[0].match(/href=["']([^"']+)["']/i)?.[1];
          if (href) candidates.unshift(new URL(href, u.origin).toString());
        } catch {
          /* no html, fine */
        }
        for (const c of candidates) {
          const res = await ctx.fetch(c, { signal: AbortSignal.timeout(6000) });
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
      const b = (await c.req.json().catch(() => ({}))) as { title?: string; url?: string; group?: string; icon?: string };
      if (!b.url) return c.json({ error: "url required" }, 400);
      let url = b.url.trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      const id = uid();
      const title = b.title?.trim() || new URL(url).hostname.replace(/^www\./, "");
      db.run(`INSERT INTO {{t:links}} (id, title, url, "group", icon, favicon, sort) VALUES (?, ?, ?, ?, ?, NULL, ?)`, [id, title, url, b.group?.trim() ?? "", b.icon || null, all().length]);
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
      const b = (await c.req.json().catch(() => ({}))) as Partial<{ title: string; url: string; group: string; icon: string | null; sort: number }>;
      for (const [k, col] of [["title", "title"], ["url", "url"], ["group", '"group"'], ["icon", "icon"], ["sort", "sort"]] as const) {
        if (b[k] !== undefined) db.run(`UPDATE {{t:links}} SET ${col} = ? WHERE id = ?`, [b[k] as string, id]);
      }
      if (b.url) void fetchFavicon(b.url).then((fav) => { db.run(`UPDATE {{t:links}} SET favicon = ? WHERE id = ?`, [fav, id]); changed(); });
      changed();
      return c.json(all().find((l) => l.id === id) ?? { ok: true });
    });
    http.delete("/links/:id", (c) => {
      db.run(`DELETE FROM {{t:links}} WHERE id = ?`, [c.req.param("id")]);
      changed();
      return c.json({ ok: true });
    });
    http.post("/reorder", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
      (b.ids ?? []).forEach((id, i) => db.run(`UPDATE {{t:links}} SET sort = ? WHERE id = ?`, [i, id]));
      changed();
      return c.json({ ok: true });
    });
    logger.info("bookmarks ready");
  },
});
