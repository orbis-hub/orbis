import { createHash } from "node:crypto";
import { defineModule } from "@orbis/sdk/server";
import { XMLParser } from "fast-xml-parser";

export type Feed = { id: string; url: string; title: string; site: string | null; favicon: string | null; last_fetched: string | null; error: string | null; sort: number };
export type Item = { id: string; feed_id: string; title: string; url: string; summary: string | null; published: string; read: number; feed_title?: string; favicon?: string | null };

type Settings = { refreshMinutes?: number; keepDays?: number };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", cdataPropName: "#cdata" });
const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o["#cdata"] ?? o["#text"] ?? o["@_href"] ?? "");
  }
  return "";
};
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

export default defineModule<Settings>({
  setup(ctx) {
    const { storage: db, http, events, logger, settings } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:feeds}} (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, site TEXT, favicon TEXT, last_fetched TEXT, error TEXT, sort INTEGER NOT NULL DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:items}} (id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, summary TEXT, published TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0)`);
    db.run(`CREATE INDEX IF NOT EXISTS {{t:items_pub}} ON {{t:items}}(published)`);
    const feeds = () => db.sql<Feed>(`SELECT * FROM {{t:feeds}} ORDER BY sort, title`);
    const changed = () => events.publish("changed");

    async function fetchFeed(f: Feed) {
      try {
        const res = await ctx.fetch(f.url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", "user-agent": "orbis-rss/0.1" }, signal: AbortSignal.timeout(20_000), redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        const doc = parser.parse(xml) as Record<string, unknown>;
        const rss = doc.rss as { channel?: Record<string, unknown> } | undefined;
        const atom = doc.feed as Record<string, unknown> | undefined;
        const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
        let title = f.title, site: string | null = f.site, entries: Record<string, unknown>[] = [];
        if (rss?.channel) {
          title = strip(text(rss.channel.title)) || title;
          site = text(rss.channel.link) || site;
          const it = rss.channel.item;
          entries = Array.isArray(it) ? it : it ? [it as Record<string, unknown>] : [];
        } else if (atom) {
          title = strip(text(atom.title)) || title;
          const links = Array.isArray(atom.link) ? atom.link : atom.link ? [atom.link] : [];
          site = text((links as Record<string, unknown>[]).find((l) => l["@_rel"] === "alternate" || !l["@_rel"]) ?? "") || site;
          const en = atom.entry;
          entries = Array.isArray(en) ? en : en ? [en as Record<string, unknown>] : [];
        } else if (rdf) {
          const ch = rdf.channel as Record<string, unknown> | undefined;
          title = strip(text(ch?.title)) || title;
          site = text(ch?.link) || site;
          const it = rdf.item;
          entries = Array.isArray(it) ? it : it ? [it as Record<string, unknown>] : [];
        } else throw new Error("not an rss/atom feed");
        let added = 0;
        for (const e of entries.slice(0, 100)) {
          const links = Array.isArray(e.link) ? e.link : [e.link];
          const url = text((links as unknown[]).find((l) => typeof l === "string" || (l as Record<string, unknown>)?.["@_rel"] !== "enclosure") ?? links[0]) || text(e.guid);
          const t = strip(text(e.title)) || "(untitled)";
          if (!url) continue;
          const pub = new Date(text(e.pubDate) || text(e.published) || text(e.updated) || text(e["dc:date"]) || Date.now());
          const id = createHash("sha1").update(`${f.id}|${text(e.guid) || url}`).digest("hex").slice(0, 16);
          const summary = strip(text(e.description) || text(e.summary) || text(e["content:encoded"]) || text(e.content)).slice(0, 400) || null;
          const r = db.run(`INSERT OR IGNORE INTO {{t:items}} (id, feed_id, title, url, summary, published, read) VALUES (?, ?, ?, ?, ?, ?, 0)`, [id, f.id, t, url, summary, isNaN(pub.getTime()) ? new Date().toISOString() : pub.toISOString()]);
          added += r.changes;
        }
        let favicon = f.favicon;
        if (!favicon && site) {
          try {
            const r2 = await ctx.fetch(new URL("/favicon.ico", site).toString(), { signal: AbortSignal.timeout(6000) });
            if (r2.ok && (r2.headers.get("content-type") ?? "").startsWith("image/")) {
              const buf = Buffer.from(await r2.arrayBuffer());
              if (buf.byteLength < 100 * 1024) favicon = `data:${(r2.headers.get("content-type") ?? "image/x-icon").split(";")[0]};base64,${buf.toString("base64")}`;
            }
          } catch {
            /* fine */
          }
        }
        db.run(`UPDATE {{t:feeds}} SET title = ?, site = ?, favicon = ?, last_fetched = ?, error = NULL WHERE id = ?`, [title, site, favicon, new Date().toISOString(), f.id]);
        if (added) logger.debug(`${f.title}: ${added} new`);
        return added;
      } catch (err) {
        db.run(`UPDATE {{t:feeds}} SET error = ?, last_fetched = ? WHERE id = ?`, [(err as Error).message, new Date().toISOString(), f.id]);
        logger.warn(`${f.url}: ${(err as Error).message}`);
        return 0;
      }
    }

    async function refreshAll() {
      let total = 0;
      for (const f of feeds()) total += await fetchFeed(f);
      const cutoff = new Date(Date.now() - (settings.get().keepDays ?? 14) * 86400_000).toISOString();
      db.run(`DELETE FROM {{t:items}} WHERE published < ? AND read = 1`, [cutoff]);
      if (total || true) changed();
      reportStatus();
    }
    const reportStatus = () => {
      const t = ctx.i18n.t;
      const fs = feeds();
      if (!fs.length) ctx.status.set({ state: "needs-setup", message: t("status.needs_feeds"), action: { label: t("status.action"), page: "feeds" } });
      else if (fs.some((f) => f.error)) ctx.status.set({ state: "warning", message: t("status.failing", { count: fs.filter((f) => f.error).length }), action: { label: t("status.action"), page: "feeds" } });
      else ctx.status.set({ state: "ok" });
    };
    const schedule = () => ctx.scheduler.every("refresh", (settings.get().refreshMinutes ?? 30) * 60_000, refreshAll, { immediate: true });
    schedule();
    settings.onChange(schedule);
    ctx.i18n.onChange(reportStatus);

    http.get("/feeds", (c) => {
      const counts = Object.fromEntries(db.sql<{ feed_id: string; n: number }>(`SELECT feed_id, COUNT(*) AS n FROM {{t:items}} WHERE read = 0 GROUP BY feed_id`).map((r) => [r.feed_id, r.n]));
      return c.json(feeds().map((f) => ({ ...f, unread: counts[f.id] ?? 0 })));
    });
    http.post("/feeds", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { url?: string };
      if (!b.url) return c.json({ error: ctx.i18n.t("error.url_required") }, 400);
      let url = b.url.trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      const id = uid();
      try {
        db.run(`INSERT INTO {{t:feeds}} (id, url, title, sort) VALUES (?, ?, ?, ?)`, [id, url, new URL(url).hostname, feeds().length]);
      } catch {
        return c.json({ error: ctx.i18n.t("error.already_added") }, 409);
      }
      const f = feeds().find((x) => x.id === id)!;
      await fetchFeed(f);
      changed();
      reportStatus();
      const fresh = feeds().find((x) => x.id === id)!;
      if (fresh.error) {
        // maybe it was a site url: try to discover the feed link
        try {
          const html = await (await ctx.fetch(url, { signal: AbortSignal.timeout(10_000) })).text();
          const m = html.match(/<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/i)?.[0].match(/href=["']([^"']+)["']/i)?.[1];
          if (m) {
            db.run(`UPDATE {{t:feeds}} SET url = ?, error = NULL WHERE id = ?`, [new URL(m, url).toString(), id]);
            await fetchFeed(feeds().find((x) => x.id === id)!);
            changed();
            reportStatus();
          }
        } catch {
          /* leave the error */
        }
      }
      return c.json(feeds().find((x) => x.id === id), 201);
    });
    http.delete("/feeds/:id", (c) => {
      db.run(`DELETE FROM {{t:items}} WHERE feed_id = ?`, [c.req.param("id")]);
      db.run(`DELETE FROM {{t:feeds}} WHERE id = ?`, [c.req.param("id")]);
      changed();
      reportStatus();
      return c.json({ ok: true });
    });
    http.post("/refresh", async (c) => {
      await refreshAll();
      return c.json({ ok: true });
    });
    http.get("/items", (c) => {
      const feed = c.req.query("feed");
      const unread = c.req.query("unread") === "1";
      const limit = Math.min(200, Number(c.req.query("limit") ?? 50));
      const where = [feed ? "i.feed_id = ?" : null, unread ? "i.read = 0" : null].filter(Boolean).join(" AND ");
      const items = db.sql<Item>(`SELECT i.*, f.title AS feed_title, f.favicon FROM {{t:items}} i JOIN {{t:feeds}} f ON f.id = i.feed_id ${where ? `WHERE ${where}` : ""} ORDER BY i.published DESC LIMIT ?`, [...(feed ? [feed] : []), limit]);
      return c.json(items);
    });
    http.post("/read", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { ids?: string[]; all?: boolean; feed?: string; read?: boolean };
      const v = b.read === false ? 0 : 1;
      if (b.all) db.run(`UPDATE {{t:items}} SET read = ?${b.feed ? " WHERE feed_id = ?" : ""}`, b.feed ? [v, b.feed] : [v]);
      else for (const id of b.ids ?? []) db.run(`UPDATE {{t:items}} SET read = ? WHERE id = ?`, [v, id]);
      changed();
      return c.json({ ok: true });
    });

    einkRender = (req) => {
      const cfg = req.config as { feedId?: string; count?: number };
      const items = db.sql<Item>(`SELECT i.*, f.title AS feed_title FROM {{t:items}} i JOIN {{t:feeds}} f ON f.id = i.feed_id ${cfg.feedId ? "WHERE i.feed_id = ?" : ""} ORDER BY i.published DESC LIMIT ?`, cfg.feedId ? [cfg.feedId, 20] : [20]);
      const max = Math.max(1, Math.floor((req.height - 4) / 34));
      if (!items.length) return { type: "text", text: ctx.i18n.t("eink.empty"), size: 12, gray: 0.5 };
      return { type: "col", grow: 1, gap: 4, children: items.slice(0, max).map((it) => ({ type: "col" as const, gap: 0, children: [{ type: "text" as const, text: it.title, size: 13, pixel: false, wrap: false }, { type: "text" as const, text: `${it.feed_title} · ${new Date(it.published).toLocaleTimeString(req.locale, { hour: "2-digit", minute: "2-digit" })}`, size: 10, pixel: false, gray: 0.5, wrap: false }] })) };
    };
    logger.info(`feeds ready (${feeds().length} feeds)`);
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
