import { defineModule, type EinkRequest, type EinkTree, type ModuleServerContext } from "@orbis/sdk/server";
import { BIN_STYLE, isHexColor, mapTrashName } from "./bins";
import { addDays, daysBetween, isIso, todayIso } from "./dates";
import { reverseGeocode } from "./geocode";
import { parseIcs } from "./ics";
import { getProvider, PROVIDERS, type ProviderLocation } from "./providers/index";
import { expandRule, parseRule } from "./recurrence";
import { BIN_TYPES, type Bin, type BinType, type IcsConfig, type JumomindConfig, type ManualConfig, type Overview, type PickupView, type Source, type SourceConfig, type SourceKind, type SourceView } from "./types";

export type { Bin, BinType, GeoResult, ManualRule, Overview, PickupView, Source, SourceConfig, SourceKind, SourceView } from "./types";

type Settings = { reminderHour?: number; lookaheadDays?: number };
type Ctx = ModuleServerContext<Settings>;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const PAGE_URL = "/m/?id=waste&page=waste";
const JUMOMIND_STALE_MS = 7 * 24 * 60 * 60_000;
const ICS_STALE_MS = 24 * 60 * 60_000;
const KINDS: SourceKind[] = ["jumomind", "ics", "manual"];

function settingsOf(ctx: Ctx) {
  const s = ctx.settings.get() ?? {};
  const hour = Number(s.reminderHour);
  const days = Number(s.lookaheadDays);
  return { reminderHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 18, lookaheadDays: Number.isInteger(days) && days >= 7 && days <= 120 ? days : 28 };
}

function parseConfig(kind: SourceKind, raw: unknown): SourceConfig | string {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (kind === "jumomind") {
    const provider = typeof c.provider === "string" && c.provider ? c.provider : "jumomind";
    if (!getProvider(provider)) return `unknown provider ${provider}`;
    const cityId = String(c.cityId ?? "").trim(), areaId = String(c.areaId ?? "").trim();
    if (!cityId || !areaId) return "cityId and areaId required";
    const out: JumomindConfig = { provider: "jumomind", cityId, cityName: String(c.cityName ?? "").trim() || cityId, areaId };
    if (c.streetId) out.streetId = String(c.streetId);
    if (c.streetName) out.streetName = String(c.streetName);
    return out;
  }
  if (kind === "ics") {
    let url = String(c.url ?? "").trim().replace(/^webcal:\/\//i, "https://");
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "url must be http(s)";
      url = u.toString();
    } catch {
      return "invalid url";
    }
    return { url } satisfies IcsConfig;
  }
  return { shiftOnHolidays: !!c.shiftOnHolidays } satisfies ManualConfig;
}

export default defineModule<Settings>({
  setup(ctx) {
    const { storage: db, http, events, logger } = ctx;
    const t = (key: string, vars?: Record<string, string | number>) => ctx.i18n.t(key, vars);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:sources}} (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL, last_fetched TEXT, error TEXT, created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:bins}} (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, icon TEXT NOT NULL, key TEXT, enabled INTEGER NOT NULL DEFAULT 1, rule TEXT, created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:pickups}} (source_id TEXT NOT NULL, bin_id TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (bin_id, date))`);
    db.run(`CREATE INDEX IF NOT EXISTS {{t:pickups_date}} ON {{t:pickups}}(date)`);
    const changed = () => events.publish("changed");

    /* ---------- reads ---------- */
    const sources = () => db.sql<Source>(`SELECT * FROM {{t:sources}} ORDER BY created_at`);
    const source = (id: string) => db.sql<Source>(`SELECT * FROM {{t:sources}} WHERE id = ?`, [id])[0] ?? null;
    const bins = () => db.sql<Bin>(`SELECT * FROM {{t:bins}} ORDER BY created_at`);
    const bin = (id: string) => db.sql<Bin>(`SELECT * FROM {{t:bins}} WHERE id = ?`, [id])[0] ?? null;
    const cfgOf = (s: Source): SourceConfig => {
      try {
        return JSON.parse(s.config) as SourceConfig;
      } catch {
        return {} as SourceConfig;
      }
    };
    const sourceView = (s: Source): SourceView => ({
      ...s,
      config: cfgOf(s),
      binCount: db.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM {{t:bins}} WHERE source_id = ?`, [s.id])[0]?.n ?? 0,
      pickupCount: db.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM {{t:pickups}} WHERE source_id = ? AND date >= ?`, [s.id, todayIso()])[0]?.n ?? 0,
    });
    const putOutKey = (binId: string, date: string) => `putout:${binId}:${date}`;

    function upcoming(from: string, days: number): PickupView[] {
      const to = addDays(from, days);
      const srcById = new Map(sources().map((s) => [s.id, s] as const));
      const out: PickupView[] = [];
      for (const b of bins()) {
        if (!b.enabled) continue;
        const s = srcById.get(b.source_id);
        if (!s) continue;
        let dates: string[] = [];
        if (s.kind === "manual") {
          const rule = parseRule(b.rule);
          if (rule) dates = expandRule(rule, from, to, { shiftOnHolidays: !!(cfgOf(s) as ManualConfig).shiftOnHolidays });
        } else dates = db.sql<{ date: string }>(`SELECT date FROM {{t:pickups}} WHERE bin_id = ? AND date >= ? AND date <= ? ORDER BY date`, [b.id, from, to]).map((r) => r.date);
        for (const date of dates) out.push({ binId: b.id, bin: { name: b.name, type: b.type, color: b.color, icon: b.icon }, date, daysUntil: daysBetween(from, date), putOut: db.get<boolean>(putOutKey(b.id, date)) === true });
      }
      return out.sort((a, b) => a.date.localeCompare(b.date) || a.bin.name.localeCompare(b.bin.name));
    }

    const overview = (): Overview => {
      const { lookaheadDays } = settingsOf(ctx);
      const today = todayIso();
      return { today, lookaheadDays, sources: sources().map(sourceView), bins: bins(), upcoming: upcoming(today, lookaheadDays) };
    };

    function updateStatus() {
      const all = sources();
      if (!all.length) return ctx.status.set({ state: "needs-setup", message: t("status.needsSetup"), action: { label: t("status.open"), page: "waste" } });
      const bad = all.filter((s) => s.error);
      if (bad.length) return ctx.status.set({ state: "warning", message: t("status.sourceError", { name: bad[0]!.name }), action: { label: t("status.open"), page: "waste" } });
      ctx.status.set({ state: "ok" });
    }

    /* ---------- bins ---------- */
    function ensureBin(sourceId: string, key: string, title: string, color: string | null, type?: BinType): Bin {
      const existing = db.sql<Bin>(`SELECT * FROM {{t:bins}} WHERE source_id = ? AND key = ?`, [sourceId, key])[0];
      if (existing) return existing;
      const ty = type ?? mapTrashName(title, key);
      const style = BIN_STYLE[ty];
      const id = uid();
      db.run(`INSERT INTO {{t:bins}} (id, source_id, type, name, color, icon, key, enabled, rule, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`, [id, sourceId, ty, title, ty === "custom" && color ? color : style.color, style.icon, key, new Date().toISOString()]);
      return bin(id)!;
    }

    /* ---------- refresh ---------- */
    async function refreshSource(s: Source): Promise<void> {
      if (s.kind === "manual") return;
      try {
        const rows: Array<{ binId: string; date: string }> = [];
        if (s.kind === "jumomind") {
          const loc = cfgOf(s) as JumomindConfig;
          const provider = getProvider(loc.provider || "jumomind");
          if (!provider) throw new Error(`unknown provider ${loc.provider}`);
          const pl: ProviderLocation = { ...loc, provider: provider.id };
          const types = await provider.bins(pl, ctx.fetch);
          for (const ty of types) ensureBin(s.id, ty.key, ty.title, ty.color, ty.type);
          const pickups = await provider.pickups(pl, ctx.fetch);
          for (const p of pickups) rows.push({ binId: ensureBin(s.id, p.key, p.title, p.color).id, date: p.date });
          if (!types.length && !pickups.length) throw new Error(t("error.providerEmpty"));
        } else if (s.kind === "ics") {
          const { url } = cfgOf(s) as IcsConfig;
          const res = await ctx.fetch(url, { headers: { accept: "text/calendar, text/plain, */*", "user-agent": `orbis-hub/${ctx.hubVersion} (+https://github.com/orbis-hub/orbis)` }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error(t("error.notIcs"));
          const horizon = addDays(todayIso(), 400);
          const evs = parseIcs(text, { horizon });
          for (const ev of evs) rows.push({ binId: ensureBin(s.id, ev.summary, ev.summary, null).id, date: ev.date });
          if (!evs.length) throw new Error(t("error.icsEmpty"));
        }
        db.run(`DELETE FROM {{t:pickups}} WHERE source_id = ?`, [s.id]);
        for (const r of rows) db.run(`INSERT OR IGNORE INTO {{t:pickups}} (source_id, bin_id, date) VALUES (?, ?, ?)`, [s.id, r.binId, r.date]);
        db.run(`UPDATE {{t:sources}} SET last_fetched = ?, error = NULL WHERE id = ?`, [new Date().toISOString(), s.id]);
        logger.info(`refreshed ${s.kind} source "${s.name}": ${rows.length} pickups`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.run(`UPDATE {{t:sources}} SET error = ? WHERE id = ?`, [msg, s.id]);
        logger.warn(`refresh failed for "${s.name}": ${msg}`);
      }
      updateStatus();
      changed();
    }

    async function refreshStale(force = false) {
      const now = Date.now();
      for (const s of sources()) {
        if (s.kind === "manual") continue;
        const stale = s.kind === "jumomind" ? JUMOMIND_STALE_MS : ICS_STALE_MS;
        const last = s.last_fetched ? new Date(s.last_fetched).getTime() : 0;
        if (force || now - last > stale) await refreshSource(s);
      }
    }

    /* ---------- http ---------- */
    http.get("/overview", (c) => c.json(overview()));
    http.get("/upcoming", (c) => {
      const days = Math.min(120, Math.max(1, Number(c.req.query("days")) || settingsOf(ctx).lookaheadDays));
      return c.json(upcoming(todayIso(), days));
    });
    http.get("/types", (c) => c.json(BIN_TYPES.map((type) => ({ type, name: t(`bin.${type}`), ...BIN_STYLE[type] }))));

    http.get("/sources", (c) => c.json(sources().map(sourceView)));
    http.post("/sources", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { kind?: string; name?: string; config?: unknown };
      const kind = b.kind as SourceKind;
      if (!KINDS.includes(kind)) return c.json({ error: "kind must be jumomind, ics or manual" }, 400);
      const cfg = parseConfig(kind, b.config);
      if (typeof cfg === "string") return c.json({ error: cfg }, 400);
      const name = b.name?.trim() || (kind === "jumomind" ? [(cfg as JumomindConfig).cityName, (cfg as JumomindConfig).streetName].filter(Boolean).join(", ") : kind === "ics" ? new URL((cfg as IcsConfig).url).hostname : t("source.manualName"));
      const id = uid();
      db.run(`INSERT INTO {{t:sources}} (id, kind, name, config, last_fetched, error, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)`, [id, kind, name, JSON.stringify(cfg), new Date().toISOString()]);
      const s = source(id)!;
      await refreshSource(s);
      updateStatus();
      changed();
      const fresh = source(id)!;
      return c.json({ source: sourceView(fresh), bins: bins().filter((x) => x.source_id === id) }, fresh.error ? 502 : 201);
    });
    http.patch("/sources/:id", async (c) => {
      const s = source(c.req.param("id"));
      if (!s) return c.json({ error: "not found" }, 404);
      const b = (await c.req.json().catch(() => ({}))) as { name?: string; config?: unknown };
      if (typeof b.name === "string" && b.name.trim()) db.run(`UPDATE {{t:sources}} SET name = ? WHERE id = ?`, [b.name.trim(), s.id]);
      let needsRefresh = false;
      if (b.config !== undefined) {
        const cfg = parseConfig(s.kind, { ...cfgOf(s), ...(b.config as object) });
        if (typeof cfg === "string") return c.json({ error: cfg }, 400);
        needsRefresh = JSON.stringify(cfg) !== s.config && s.kind !== "manual";
        db.run(`UPDATE {{t:sources}} SET config = ? WHERE id = ?`, [JSON.stringify(cfg), s.id]);
      }
      if (needsRefresh) await refreshSource(source(s.id)!);
      changed();
      return c.json(sourceView(source(s.id)!));
    });
    http.post("/sources/:id/refresh", async (c) => {
      const s = source(c.req.param("id"));
      if (!s) return c.json({ error: "not found" }, 404);
      await refreshSource(s);
      return c.json(sourceView(source(s.id)!));
    });
    http.delete("/sources/:id", (c) => {
      const id = c.req.param("id");
      db.run(`DELETE FROM {{t:pickups}} WHERE source_id = ?`, [id]);
      db.run(`DELETE FROM {{t:bins}} WHERE source_id = ?`, [id]);
      db.run(`DELETE FROM {{t:sources}} WHERE id = ?`, [id]);
      updateStatus();
      changed();
      return c.json({ ok: true });
    });

    http.get("/bins", (c) => c.json(bins()));
    http.post("/bins", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { source_id?: string; name?: string; type?: string; color?: string; icon?: string; rule?: unknown };
      const s = b.source_id ? source(b.source_id) : null;
      if (!s || s.kind !== "manual") return c.json({ error: "source_id of a manual source required" }, 400);
      const type = (BIN_TYPES as string[]).includes(b.type ?? "") ? (b.type as BinType) : "custom";
      const rule = parseRule(b.rule === undefined ? null : JSON.stringify(b.rule));
      if (!rule) return c.json({ error: "rule required: { mode: 'weekly', interval, weekday, start } or { mode: 'dates', dates }" }, 400);
      const style = BIN_STYLE[type];
      const id = uid();
      db.run(`INSERT INTO {{t:bins}} (id, source_id, type, name, color, icon, key, enabled, rule, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`, [id, s.id, type, b.name?.trim() || t(`bin.${type}`), isHexColor(b.color ?? "") ? b.color : style.color, b.icon?.trim() || style.icon, JSON.stringify(rule), new Date().toISOString()]);
      changed();
      return c.json(bin(id), 201);
    });
    http.patch("/bins/:id", async (c) => {
      const x = bin(c.req.param("id"));
      if (!x) return c.json({ error: "not found" }, 404);
      const b = (await c.req.json().catch(() => ({}))) as { name?: string; type?: string; color?: string; icon?: string; enabled?: boolean; rule?: unknown };
      if (typeof b.name === "string" && b.name.trim()) db.run(`UPDATE {{t:bins}} SET name = ? WHERE id = ?`, [b.name.trim(), x.id]);
      if (typeof b.type === "string" && (BIN_TYPES as string[]).includes(b.type)) {
        // switching the type also resets colour/icon to the type's defaults unless given explicitly
        const style = BIN_STYLE[b.type as BinType];
        db.run(`UPDATE {{t:bins}} SET type = ?, color = ?, icon = ? WHERE id = ?`, [b.type, isHexColor(b.color ?? "") ? b.color : style.color, b.icon?.trim() || style.icon, x.id]);
      }
      if (typeof b.color === "string" && isHexColor(b.color)) db.run(`UPDATE {{t:bins}} SET color = ? WHERE id = ?`, [b.color, x.id]);
      if (typeof b.icon === "string" && b.icon.trim()) db.run(`UPDATE {{t:bins}} SET icon = ? WHERE id = ?`, [b.icon.trim(), x.id]);
      if (typeof b.enabled === "boolean") db.run(`UPDATE {{t:bins}} SET enabled = ? WHERE id = ?`, [b.enabled ? 1 : 0, x.id]);
      if (b.rule !== undefined) {
        const rule = parseRule(JSON.stringify(b.rule));
        if (!rule) return c.json({ error: "invalid rule" }, 400);
        db.run(`UPDATE {{t:bins}} SET rule = ? WHERE id = ?`, [JSON.stringify(rule), x.id]);
      }
      changed();
      return c.json(bin(x.id));
    });
    http.delete("/bins/:id", (c) => {
      const id = c.req.param("id");
      db.run(`DELETE FROM {{t:pickups}} WHERE bin_id = ?`, [id]);
      db.run(`DELETE FROM {{t:bins}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });

    http.post("/putout", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { binId?: string; date?: string; value?: boolean };
      if (!b.binId || !isIso(b.date)) return c.json({ error: "binId and date required" }, 400);
      if (b.value === false) db.delete(putOutKey(b.binId, b.date));
      else db.set(putOutKey(b.binId, b.date), true);
      if (b.value !== false) ctx.dismissNotification(`pickup:${b.binId}:${b.date}`);
      changed();
      return c.json({ ok: true, putOut: b.value !== false });
    });

    http.get("/geo/reverse", async (c) => {
      const lat = Number(c.req.query("lat")), lon = Number(c.req.query("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return c.json({ error: "lat and lon required" }, 400);
      try {
        return c.json(await reverseGeocode(lat, lon, { fetch: ctx.fetch, language: ctx.i18n.language, hubVersion: ctx.hubVersion }));
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    });

    http.get("/providers", (c) => c.json(Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name }))));
    http.get("/providers/:id/cities", async (c) => {
      const p = getProvider(c.req.param("id"));
      if (!p) return c.json({ error: "unknown provider" }, 404);
      const q = (c.req.query("q") ?? "").trim();
      if (q.length < 2) return c.json([]);
      try {
        return c.json(await p.searchCities(q, ctx.fetch));
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    });
    http.get("/providers/:id/streets", async (c) => {
      const p = getProvider(c.req.param("id"));
      if (!p) return c.json({ error: "unknown provider" }, 404);
      const cityId = (c.req.query("cityId") ?? "").trim();
      if (!cityId) return c.json({ error: "cityId required" }, 400);
      try {
        return c.json(await p.searchStreets(cityId, (c.req.query("q") ?? "").trim(), ctx.fetch, (c.req.query("house") ?? "").trim() || undefined));
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    });

    /* ---------- schedulers ---------- */
    ctx.scheduler.every("refresh", 60 * 60_000, () => refreshStale(), { immediate: true });

    ctx.scheduler.every("remind", 30 * 60_000, () => {
      const today = todayIso();
      const tomorrow = addDays(today, 1);
      // retire reminders and put-out marks whose date has passed
      for (const key of db.keys("sent:")) {
        const date = db.get<string>(key);
        if (date && date < today) {
          ctx.dismissNotification(key.slice(5));
          db.delete(key);
        }
      }
      for (const key of db.keys("putout:")) {
        const date = key.split(":")[2];
        if (date && date < today) db.delete(key);
      }
      const { reminderHour } = settingsOf(ctx);
      if (new Date().getHours() !== reminderHour) return;
      const fmt = new Intl.DateTimeFormat(ctx.i18n.language, { weekday: "long", day: "numeric", month: "long" });
      for (const p of upcoming(today, 1)) {
        if (p.date !== tomorrow || p.putOut) continue;
        const key = `pickup:${p.binId}:${p.date}`;
        if (db.get(`sent:${key}`)) continue;
        ctx.notify({ key, title: t("notify.title", { bin: p.bin.name }), body: t("notify.body", { date: fmt.format(new Date(p.date + "T12:00:00")) }), level: "info", icon: p.bin.icon, url: PAGE_URL });
        db.set(`sent:${key}`, p.date);
      }
    }, { immediate: true });

    ctx.i18n.onChange(() => updateStatus());
    updateStatus();

    /* ---------- e-ink ---------- */
    einkRender = (req) => {
      const today = todayIso(req.now);
      const when = (d: number, iso: string) => (d === 0 ? t("when.today") : d === 1 ? t("when.tomorrow") : d < 7 ? t("when.inDays", { count: d }) : new Intl.DateTimeFormat(req.locale, { weekday: "short", day: "numeric", month: "numeric" }).format(new Date(iso + "T12:00:00")));
      if (req.widget === "week") {
        const list = upcoming(today, 6);
        const dayFmt = new Intl.DateTimeFormat(req.locale, { weekday: "short" });
        const cols: EinkTree[] = [];
        for (let i = 0; i < 7; i++) {
          const iso = addDays(today, i);
          const n = list.filter((p) => p.date === iso).length;
          cols.push({ type: "col", gap: 3, align: "center", grow: 1, children: [{ type: "text", text: dayFmt.format(new Date(iso + "T12:00:00")), size: 10, pixel: false, gray: i === 0 ? 0 : 0.5, bold: i === 0 }, { type: "text", text: String(Number(iso.slice(8, 10))), size: 13, pixel: false, bold: n > 0 }, { type: "dots", count: Math.max(1, n), filled: n, size: 6 }] });
        }
        return { type: "row", gap: 4, grow: 1, align: "center", children: cols };
      }
      const cfg = req.config as { count?: number };
      const list = upcoming(today, settingsOf(ctx).lookaheadDays).slice(0, cfg.count ?? 4);
      if (!list.length) return { type: "text", text: sources().length ? t("eink.nothing") : t("eink.empty"), size: 12, gray: 0.5 };
      return { type: "col", grow: 1, gap: 4, children: list.map((p): EinkTree => ({ type: "row", gap: 8, align: "center", children: [{ type: "dots", count: 1, filled: p.daysUntil <= 1 ? 1 : 0, size: 10 }, { type: "text", text: p.bin.name, size: 13, pixel: false, grow: 1, wrap: false, bold: p.daysUntil <= 1 }, { type: "text", text: when(p.daysUntil, p.date), size: 11, pixel: false, gray: 0.5, wrap: false }] })) };
    };
    logger.info("waste ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: EinkRequest) => EinkTree) | null = null;
