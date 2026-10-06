import { createHash } from "node:crypto";
import { defineModule, parseBody, parseQuery, z } from "@orbis/sdk/server";
import { XMLParser } from "fast-xml-parser";

export type Feed = {
  id: string;
  url: string;
  title: string;
  site: string | null;
  favicon: string | null;
  last_fetched: string | null;
  /** when the feed last parsed fine */
  last_ok: string | null;
  error: string | null;
  /** when `error` was first seen (null while the feed is healthy) */
  last_error_at: string | null;
  sort: number;
};
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
/** named html entities (html 4 set: latin-1, greek, typographic, arrows) → code point; numeric ones are decoded directly */
const ENTITIES: Record<string, number> = (() => {
  const t: Record<string, number> = { quot: 34, amp: 38, apos: 39, lt: 60, gt: 62 };
  const latin1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
  latin1.forEach((n, i) => (t[n] = 160 + i));
  const greekU = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho _ Sigma Tau Upsilon Phi Chi Psi Omega".split(" ");
  greekU.forEach((n, i) => n !== "_" && (t[n] = 913 + i));
  const greekL = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega".split(" ");
  greekL.forEach((n, i) => (t[n] = 945 + i));
  Object.assign(t, { OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, minus: 8722, infin: 8734, ne: 8800, le: 8804, ge: 8805, hearts: 9829, spades: 9824, clubs: 9827, diams: 9830, loz: 9674 });
  return t;
})();
/** `&eacute;`, `&#8217;`, `&#x2019;` → characters; unknown names are left alone */
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, body: string) => {
    let cp: number | undefined;
    if (body[0] === "#") cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    else cp = ENTITIES[body];
    if (cp === undefined || !Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
    return cp === 160 ? " " : String.fromCodePoint(cp);
  });
export const strip = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** feeds bigger than this are refused (the hub fetch policy caps bodies too; this is the module's own guard) */
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_FAVICON_BYTES = 100 * 1024;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
/** read a body up to `max` bytes; throws once more arrives (does not buffer the rest) */
async function readCapped(res: Response, max: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new Error(`${what} too large (${mb(declared)}, limit ${mb(max)})`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${what} too large (over ${mb(max)})`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export default defineModule<Settings>({
  setup(ctx) {
    const { storage: db, http, events, logger, settings } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:feeds}} (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, site TEXT, favicon TEXT, last_fetched TEXT, error TEXT, sort INTEGER NOT NULL DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:items}} (id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, summary TEXT, published TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0)`);
    db.run(`CREATE INDEX IF NOT EXISTS {{t:items_pub}} ON {{t:items}}(published)`);
    // per-feed health timestamps (added later: migrate older tables)
    const cols = new Set(db.sql<{ name: string }>(`PRAGMA table_info("m_rss_feeds")`).map((c) => c.name));
    if (!cols.has("last_ok")) db.run(`ALTER TABLE {{t:feeds}} ADD COLUMN last_ok TEXT`);
    if (!cols.has("last_error_at")) db.run(`ALTER TABLE {{t:feeds}} ADD COLUMN last_error_at TEXT`);
    const feeds = () => db.sql<Feed>(`SELECT * FROM {{t:feeds}} ORDER BY sort, title`);
    const changed = () => events.publish("changed");

    async function fetchFeed(f: Feed) {
      try {
        const res = await ctx.fetch(f.url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", "user-agent": "orbis-rss/0.1" }, signal: AbortSignal.timeout(20_000), redirect: "follow", maxBytes: MAX_FEED_BYTES });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = new TextDecoder().decode(await readCapped(res, MAX_FEED_BYTES, "feed"));
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
            const r2 = await ctx.fetch(new URL("/favicon.ico", site).toString(), { signal: AbortSignal.timeout(6000), maxBytes: MAX_FAVICON_BYTES });
            if (r2.ok && (r2.headers.get("content-type") ?? "").startsWith("image/")) {
              const buf = Buffer.from(await readCapped(r2, MAX_FAVICON_BYTES, "favicon"));
              favicon = `data:${(r2.headers.get("content-type") ?? "image/x-icon").split(";")[0]};base64,${buf.toString("base64")}`;
            }
          } catch {
            /* fine */
          }
        }
        const at = new Date().toISOString();
        db.run(`UPDATE {{t:feeds}} SET title = ?, site = ?, favicon = ?, last_fetched = ?, last_ok = ?, error = NULL, last_error_at = NULL WHERE id = ?`, [title, site, favicon, at, at, f.id]);
        if (added) logger.debug(`${f.title}: ${added} new`);
        return added;
      } catch (err) {
        const at = new Date().toISOString();
        // keep the time the trouble started so a flaky provider shows "failing since …"
        db.run(`UPDATE {{t:feeds}} SET error = ?, last_fetched = ?, last_error_at = COALESCE(last_error_at, ?) WHERE id = ?`, [(err as Error).message, at, at, f.id]);
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
      const b = await parseBody(c, z.object({ url: z.string().trim().max(2048).optional() }));
      if (!b.ok) return b.res;
      if (!b.data.url) return c.json({ error: ctx.i18n.t("error.url_required") }, 400);
      let url = b.data.url;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      let parsed: URL;
      try {
        parsed = new URL(url);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) throw new Error("bad");
      } catch {
        return c.json({ error: ctx.i18n.t("error.invalid_url") }, 400);
      }
      url = parsed.toString();
      if (db.sql(`SELECT id FROM {{t:feeds}} WHERE url = ?`, [url]).length) return c.json({ error: ctx.i18n.t("error.already_added") }, 409);
      const id = uid();
      try {
        db.run(`INSERT INTO {{t:feeds}} (id, url, title, sort) VALUES (?, ?, ?, ?)`, [id, url, parsed.hostname, feeds().length]);
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
      if (!db.sql(`SELECT id FROM {{t:feeds}} WHERE id = ?`, [c.req.param("id")]).length) return c.json({ error: ctx.i18n.t("error.unknown_feed") }, 404);
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
      const q = parseQuery(c, z.object({ feed: z.string().max(64).optional(), unread: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }));
      if (!q.ok) return q.res;
      const feed = q.data.feed;
      const unread = q.data.unread === "1";
      const limit = q.data.limit ?? 50;
      const where = [feed ? "i.feed_id = ?" : null, unread ? "i.read = 0" : null].filter(Boolean).join(" AND ");
      const items = db.sql<Item>(`SELECT i.*, f.title AS feed_title, f.favicon FROM {{t:items}} i JOIN {{t:feeds}} f ON f.id = i.feed_id ${where ? `WHERE ${where}` : ""} ORDER BY i.published DESC LIMIT ?`, [...(feed ? [feed] : []), limit]);
      return c.json(items);
    });
    http.post("/read", async (c) => {
      const b = await parseBody(c, z.object({ ids: z.array(z.string().max(64)).max(1000).optional(), all: z.boolean().optional(), feed: z.string().max(64).optional(), read: z.boolean().optional() }));
      if (!b.ok) return b.res;
      const v = b.data.read === false ? 0 : 1;
      let touched = 0;
      if (b.data.all) {
        if (b.data.feed && !db.sql(`SELECT id FROM {{t:feeds}} WHERE id = ?`, [b.data.feed]).length) return c.json({ error: ctx.i18n.t("error.unknown_feed") }, 404);
        touched = db.run(`UPDATE {{t:items}} SET read = ?${b.data.feed ? " WHERE feed_id = ?" : ""}`, b.data.feed ? [v, b.data.feed] : [v]).changes;
      } else {
        const ids = b.data.ids ?? [];
        if (!ids.length) return c.json({ error: "ids or all required" }, 400);
        const known = db.sql<{ id: string }>(`SELECT id FROM {{t:items}} WHERE id IN (${ids.map(() => "?").join(",")})`, ids).length;
        if (!known) return c.json({ error: ctx.i18n.t("error.unknown_item") }, 404);
        for (const id of ids) touched += db.run(`UPDATE {{t:items}} SET read = ? WHERE id = ?`, [v, id]).changes;
      }
      changed();
      return c.json({ ok: true, updated: touched });
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
