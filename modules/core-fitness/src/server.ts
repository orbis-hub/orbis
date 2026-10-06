import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { defineModule, parseBody, z } from "@orbis/sdk/server";
import type { Context } from "hono";

export type Activity = {
  id: string;
  source: string; // "strava" | source id
  ext_id: string | null;
  type: string; // run, ride, swim, walk, hike, workout, …
  name: string | null;
  start: string; // ISO
  duration_s: number;
  distance_m: number;
  calories: number | null;
  elevation_m: number | null;
  created_at: string;
};
/** `secret` is only present for admins (and in the create / rotate response) */
export type Source = { id: string; name: string; secret?: string; created_at: string; last_at: string | null; count: number };
export type WeekStats = {
  weekStart: string;
  days: string[]; // 7 ISO dates
  thisWeek: { distance: number[]; duration: number[]; calories: number[]; count: number[] };
  lastWeek: { distance: number[]; duration: number[]; calories: number[]; count: number[] };
  totals: { thisWeek: { distance: number; duration: number; calories: number; count: number }; lastWeek: { distance: number; duration: number; calories: number; count: number } };
};
type Settings = { stravaClientId?: string; stravaClientSecret?: string; units?: "metric" | "imperial"; weekStart?: "monday" | "sunday"; syncMinutes?: number };
type Tokens = { access: string; refresh: string; expiresAt: number; athlete?: { id: number; firstname?: string; lastname?: string } };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();
/** the hub sets x-orbis-role for session-authenticated calls; in-process calls (ctx.modules.call) carry none */
const isAdmin = (c: Context) => ["owner", "admin"].includes(c.req.header("x-orbis-role") ?? "");
const forbidden = (c: Context) => c.json({ error: "forbidden: admin role required" }, 403);
/** constant-time secret comparison (hash first so lengths never leak) */
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
/** origin as the browser sees it: behind a tls proxy the Host header is the internal one, x-forwarded-* carry the public one */
export function publicOrigin(c: Context): string {
  const u = new URL(c.req.url);
  const first = (v: string | undefined) => v?.split(",")[0]?.trim() ?? "";
  const proto = first(c.req.header("x-forwarded-proto")).replace(/:$/, "") || u.protocol.replace(/:$/, "");
  const host = first(c.req.header("x-forwarded-host")) || c.req.header("host") || u.host;
  return /^https?$/.test(proto) && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${proto}://${host}` : u.origin;
}
/** sane bounds for one workout: anything outside is garbage, not a record */
const MAX_DURATION_S = 30 * 86400;
const MAX_DISTANCE_M = 5_000_000;
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** strava sport_type → short lowercase type */
export const normType = (t: unknown): string => {
  const s = String(t ?? "workout").toLowerCase().replace(/[\s_-]+/g, "");
  if (/run|jog/.test(s)) return "run";
  if (/ride|cycl|bik|velo/.test(s)) return "ride";
  if (/swim/.test(s)) return "swim";
  if (/hik/.test(s)) return "hike";
  if (/walk/.test(s)) return "walk";
  if (/row/.test(s)) return "row";
  if (/ski|snowboard/.test(s)) return "ski";
  if (/yoga|pilates|stretch/.test(s)) return "yoga";
  if (/strength|weight|lift|crossfit|gym|functional|traditional/.test(s)) return "strength";
  if (/soccer|football|basketball|tennis|badminton|volleyball|hockey|climb|golf/.test(s)) return s.replace(/training|workout/g, "") || "sport";
  return s || "workout";
};

/** anything someone might post to /ingest – apple health shortcut, health auto export, a watch script */
export function normalizeIngest(body: unknown, source: string): Array<Omit<Activity, "id" | "created_at">> {
  const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { workouts?: unknown }).workouts) ? (body as { workouts: unknown[] }).workouts : body && typeof body === "object" && Array.isArray((body as { data?: { workouts?: unknown } }).data?.workouts) ? (body as { data: { workouts: unknown[] } }).data.workouts : [body];
  const out: Array<Omit<Activity, "id" | "created_at">> = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    // numbers, numeric strings ("5,2", "300"), health-auto-export {qty, units}; anything non-finite is ignored
    const num = (...keys: string[]) => {
      for (const k of keys) {
        const v = w[k];
        if (v == null) continue;
        if (typeof v === "number") {
          if (Number.isFinite(v)) return v;
          continue;
        }
        if (typeof v === "object" && v && "qty" in v) {
          const n = Number((v as { qty: unknown }).qty);
          if (Number.isFinite(n)) return n;
          continue;
        }
        const n = parseFloat(String(v).trim().replace(",", "."));
        if (Number.isFinite(n)) return n;
      }
      return null;
    };
    /** unit written into a distance string ("5.2 km", "3 mi") */
    const strUnit = (v: unknown): string | null => (typeof v === "string" ? (v.trim().match(/[\d.,]\s*(km|mi|m)\s*$/i)?.[1]?.toLowerCase() ?? null) : null);
    const str = (...keys: string[]) => {
      for (const k of keys) if (w[k] != null && w[k] !== "") return String(w[k]);
      return null;
    };
    const startRaw = str("start", "startDate", "start_date", "startTime", "date", "begin");
    const endRaw = str("end", "endDate", "end_date", "endTime");
    const start = startRaw ? new Date(startRaw) : null;
    if (!start || Number.isNaN(start.getTime())) continue;
    let duration = num("duration_s", "durationSeconds", "seconds", "elapsed_time", "moving_time");
    if (duration == null) {
      const mins = num("duration", "durationMin", "minutes", "duration_min");
      if (mins != null) duration = mins > 1000 ? mins : mins * 60; // big numbers are probably seconds already
    }
    if (duration == null && endRaw) duration = Math.max(0, (new Date(endRaw).getTime() - start.getTime()) / 1000);
    let distance = num("distance_m", "distanceMeters", "meters", "distance");
    const km = num("distanceKm", "distance_km", "km");
    const mi = num("distanceMi", "distance_mi", "miles");
    // units: explicit field ({qty, units} / distanceUnit) or a suffix in the string; plain numbers and bare numeric strings are metres
    const unitsStr = String((w.distance as { units?: string })?.units ?? w.distanceUnit ?? strUnit(w.distance) ?? "").toLowerCase();
    if (km != null) distance = km * 1000;
    else if (mi != null) distance = mi * 1609.344;
    else if (unitsStr === "km") distance = (num("distance") ?? 0) * 1000;
    else if (unitsStr === "mi") distance = (num("distance") ?? 0) * 1609.344;
    // garbage, not a workout: negative / absurd values are dropped rather than stored
    if (duration != null && (duration < 0 || duration > MAX_DURATION_S)) continue;
    if (distance != null && (distance < 0 || distance > MAX_DISTANCE_M)) continue;
    const nonNeg = (v: number | null) => (v != null && v >= 0 ? v : null);
    out.push({
      source,
      ext_id: str("id", "uuid", "ext_id", "workoutId"),
      type: normType(str("type", "sport_type", "workoutActivityType", "activityType", "name") ?? "workout"),
      name: str("name", "title"),
      start: start.toISOString(),
      duration_s: Math.round(duration ?? 0),
      distance_m: Math.round(distance ?? 0),
      calories: nonNeg(num("calories", "activeEnergy", "activeEnergyBurned", "kcal", "energy")),
      elevation_m: nonNeg(num("elevation_m", "elevation", "total_elevation_gain", "elevationGain")),
    });
  }
  return out;
}

export default defineModule<Settings>({
  setup(ctx) {
    const { http, storage, events, logger, settings, scheduler, status } = ctx;
    const t = ctx.i18n.t;
    storage.run(`CREATE TABLE IF NOT EXISTS {{t:activities}} (id TEXT PRIMARY KEY, source TEXT NOT NULL, ext_id TEXT, type TEXT NOT NULL, name TEXT, start TEXT NOT NULL, duration_s INTEGER NOT NULL DEFAULT 0, distance_m INTEGER NOT NULL DEFAULT 0, calories REAL, elevation_m REAL, created_at TEXT NOT NULL)`);
    storage.run(`CREATE UNIQUE INDEX IF NOT EXISTS {{t:activities_ext}} ON {{t:activities}} (source, ext_id)`);
    storage.run(`CREATE TABLE IF NOT EXISTS {{t:sources}} (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL, last_at TEXT, count INTEGER NOT NULL DEFAULT 0)`);
    const changed = () => events.publish("changed");
    const tokens = () => storage.get<Tokens>("strava:tokens") ?? null;
    const clientId = () => settings.get().stravaClientId?.trim() ?? "";
    const clientSecret = () => settings.get().stravaClientSecret?.trim() ?? "";

    const upsert = (a: Omit<Activity, "id" | "created_at">) => {
      if (a.ext_id) {
        const prev = storage.sql<{ id: string }>(`SELECT id FROM {{t:activities}} WHERE source = ? AND ext_id = ?`, [a.source, a.ext_id])[0];
        if (prev) {
          storage.run(`UPDATE {{t:activities}} SET type = ?, name = COALESCE(?, name), start = ?, duration_s = ?, distance_m = ?, calories = COALESCE(?, calories), elevation_m = COALESCE(?, elevation_m) WHERE id = ?`, [a.type, a.name, a.start, a.duration_s, a.distance_m, a.calories, a.elevation_m, prev.id]);
          return false;
        }
      } else {
        // no id: dedupe on source + start + duration
        const prev = storage.sql<{ id: string }>(`SELECT id FROM {{t:activities}} WHERE source = ? AND start = ? AND duration_s = ?`, [a.source, a.start, a.duration_s])[0];
        if (prev) return false;
      }
      storage.run(`INSERT INTO {{t:activities}} (id, source, ext_id, type, name, start, duration_s, distance_m, calories, elevation_m, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uid(), a.source, a.ext_id, a.type, a.name, a.start, a.duration_s, a.distance_m, a.calories, a.elevation_m, now()]);
      return true;
    };

    const reportStatus = () => {
      const srcCount = storage.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM {{t:sources}}`)[0]?.n ?? 0;
      if (!tokens() && srcCount === 0) status.set({ state: "needs-setup", message: t("status.needsSetup"), action: { label: t("status.openFitness"), page: "fitness" } });
      else status.set(null);
    };
    ctx.i18n.onChange(reportStatus);

    /* ---------- strava (authorization code; strava has no pkce, so the secret lives in settings) ---------- */
    async function stravaToken(): Promise<string | null> {
      const t = tokens();
      if (!t) return null;
      if (Date.now() < t.expiresAt - 60_000) return t.access;
      const res = await ctx.fetch("https://www.strava.com/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), grant_type: "refresh_token", refresh_token: t.refresh }) });
      if (!res.ok) {
        logger.warn(`strava refresh failed: HTTP ${res.status}`);
        return null;
      }
      const j = (await res.json()) as { access_token: string; refresh_token: string; expires_at: number };
      storage.set("strava:tokens", { ...t, access: j.access_token, refresh: j.refresh_token, expiresAt: j.expires_at * 1000 } satisfies Tokens);
      return j.access_token;
    }
    let syncing = false;
    async function syncStrava(full = false): Promise<{ added: number; seen: number } | { error: string }> {
      if (syncing) return { added: 0, seen: 0 };
      const access = await stravaToken();
      if (!access) return { error: t("error.notConnected") };
      syncing = true;
      try {
        const after = full ? Math.floor((Date.now() - 365 * 86400_000) / 1000) : Math.floor((Date.now() - 45 * 86400_000) / 1000);
        let page = 1;
        let added = 0;
        let seen = 0;
        for (;;) {
          const res = await ctx.fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100&page=${page}`, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(20_000) });
          if (res.status === 429) return { error: t("error.rateLimit") };
          if (!res.ok) return { error: t("error.http", { status: res.status }) };
          const list = (await res.json()) as Array<Record<string, unknown>>;
          for (const a of list) {
            seen++;
            if (upsert({ source: "strava", ext_id: String(a.id), type: normType(a.sport_type ?? a.type), name: (a.name as string) ?? null, start: new Date(a.start_date as string).toISOString(), duration_s: Number(a.moving_time ?? a.elapsed_time ?? 0), distance_m: Math.round(Number(a.distance ?? 0)), calories: a.calories != null ? Number(a.calories) : a.kilojoules != null ? Math.round(Number(a.kilojoules) / 4.184 * 1.0 * 1.0) : null, elevation_m: a.total_elevation_gain != null ? Number(a.total_elevation_gain) : null })) added++;
          }
          if (list.length < 100 || page >= 10) break;
          page++;
        }
        storage.set("strava:lastSync", now());
        if (added) changed();
        return { added, seen };
      } catch (err) {
        return { error: (err as Error).message };
      } finally {
        syncing = false;
      }
    }

    http.get("/strava/login", (c) => {
      if (!clientId() || !clientSecret()) return c.json({ error: t("error.noClient") }, 400);
      const stateKey = randomBytes(12).toString("hex");
      const origin = publicOrigin(c);
      const redirectUri = `${origin}/api/m/fitness/strava/callback`;
      storage.set(`strava:state:${stateKey}`, { redirectUri, back: c.req.query("return") ?? `${origin}/m/?id=fitness`, at: Date.now() });
      const u = new URL("https://www.strava.com/oauth/authorize");
      u.search = new URLSearchParams({ client_id: clientId(), response_type: "code", redirect_uri: redirectUri, approval_prompt: "auto", scope: "read,activity:read_all", state: stateKey }).toString();
      return c.redirect(u.toString());
    });
    http.get("/strava/callback", async (c) => {
      const stateKey = c.req.query("state") ?? "";
      const pending = storage.get<{ redirectUri: string; back: string }>(`strava:state:${stateKey}`);
      storage.delete(`strava:state:${stateKey}`);
      if (!pending) return c.text(t("error.loginExpired"), 400);
      if (c.req.query("error")) return c.redirect(`${pending.back}${pending.back.includes("?") ? "&" : "?"}strava_error=${encodeURIComponent(c.req.query("error")!)}`);
      const res = await ctx.fetch("https://www.strava.com/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), code: c.req.query("code") ?? "", grant_type: "authorization_code" }) });
      if (!res.ok) return c.text(t("error.tokenExchange", { detail: await res.text() }), 400);
      const j = (await res.json()) as { access_token: string; refresh_token: string; expires_at: number; athlete?: Tokens["athlete"] };
      storage.set("strava:tokens", { access: j.access_token, refresh: j.refresh_token, expiresAt: j.expires_at * 1000, athlete: j.athlete } satisfies Tokens);
      logger.info("strava connected");
      reportStatus();
      void syncStrava(true);
      return c.redirect(pending.back);
    });
    http.post("/strava/logout", (c) => {
      storage.delete("strava:tokens");
      reportStatus();
      changed();
      return c.json({ ok: true });
    });
    http.post("/strava/sync", async (c) => c.json(await syncStrava(c.req.query("full") === "1")));
    http.get("/status", (c) => {
      const t = tokens();
      return c.json({ strava: t ? { connected: true, athlete: t.athlete ? `${t.athlete.firstname ?? ""} ${t.athlete.lastname ?? ""}`.trim() : null, lastSync: storage.get<string>("strava:lastSync") ?? null } : { connected: false, configured: !!(clientId() && clientSecret()) }, units: settings.get().units ?? "metric", weekStart: settings.get().weekStart ?? "monday" });
    });
    scheduler.every("strava-sync", (settings.get().syncMinutes ?? 30) * 60_000, () => void syncStrava(false));

    /* ---------- ingest sources (apple health shortcut, scripts, …) ---------- */
    type SourceRow = Source & { secret: string };
    const sources = () => storage.sql<SourceRow>(`SELECT * FROM {{t:sources}} ORDER BY created_at`);
    /** members see the sources but never the secrets */
    const forRole = (c: Context, s: SourceRow): Source => (isAdmin(c) ? s : { id: s.id, name: s.name, created_at: s.created_at, last_at: s.last_at, count: s.count });
    http.get("/sources", (c) => c.json(sources().map((s) => forRole(c, s))));
    http.post("/sources", async (c) => {
      if (!isAdmin(c)) return forbidden(c);
      const b = await parseBody(c, z.object({ name: z.string().trim().max(60).optional() }));
      if (!b.ok) return b.res;
      const id = (b.data.name ?? "source").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 24) || "source";
      const finalId = storage.sql(`SELECT id FROM {{t:sources}} WHERE id = ?`, [id]).length ? `${id}-${uid().slice(0, 4)}` : id;
      storage.run(`INSERT INTO {{t:sources}} (id, name, secret, created_at) VALUES (?, ?, ?, ?)`, [finalId, b.data.name || finalId, randomBytes(24).toString("base64url"), now()]);
      reportStatus();
      changed();
      return c.json(storage.sql<SourceRow>(`SELECT * FROM {{t:sources}} WHERE id = ?`, [finalId])[0], 201);
    });
    http.delete("/sources/:id", (c) => {
      if (!isAdmin(c)) return forbidden(c);
      const r = storage.run(`DELETE FROM {{t:sources}} WHERE id = ?`, [c.req.param("id")]);
      if (!r.changes) return c.json({ error: "unknown source" }, 404);
      reportStatus();
      changed();
      return c.json({ ok: true });
    });
    http.post("/sources/:id/rotate", (c) => {
      if (!isAdmin(c)) return forbidden(c);
      const r = storage.run(`UPDATE {{t:sources}} SET secret = ? WHERE id = ?`, [randomBytes(24).toString("base64url"), c.req.param("id")]);
      if (!r.changes) return c.json({ error: "unknown source" }, 404);
      changed();
      return c.json(storage.sql<SourceRow>(`SELECT * FROM {{t:sources}} WHERE id = ?`, [c.req.param("id")])[0]);
    });
    /** public: POST /api/m/fitness/ingest/<source> with `Authorization: Bearer <secret>` (?key= still works for clients that cannot set headers, but ends up in logs) */
    http.post("/ingest/:id", async (c) => {
      const src = storage.sql<SourceRow>(`SELECT * FROM {{t:sources}} WHERE id = ?`, [c.req.param("id")])[0];
      const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("key") ?? "";
      if (!src || !key || !sameSecret(key, src.secret)) return c.json({ error: "unknown source or bad key" }, 401);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        // shortcuts sometimes send form fields; accept those too
        body = Object.fromEntries(new URLSearchParams(await c.req.text()));
      }
      const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { workouts?: unknown }).workouts) ? (body as { workouts: unknown[] }).workouts : body && typeof body === "object" && Array.isArray((body as { data?: { workouts?: unknown } }).data?.workouts) ? (body as { data: { workouts: unknown[] } }).data.workouts : [body];
      if (list.length > 1000) return c.json({ error: "at most 1000 workouts per request" }, 400);
      const acts = normalizeIngest(body, src.id);
      let added = 0;
      for (const a of acts) if (upsert(a)) added++;
      storage.run(`UPDATE {{t:sources}} SET last_at = ?, count = count + ? WHERE id = ?`, [now(), added, src.id]);
      if (added) changed();
      return c.json({ ok: true, received: list.length, accepted: acts.length, rejected: list.length - acts.length, added });
    });

    /* ---------- read ---------- */
    const query = (from: string, to: string, types?: string[]) => storage.sql<Activity>(`SELECT * FROM {{t:activities}} WHERE start >= ? AND start < ?${types?.length ? ` AND type IN (${types.map(() => "?").join(",")})` : ""} ORDER BY start DESC`, [from, to, ...(types ?? [])]);
    http.get("/activities", (c) => {
      const rawLimit = Number(c.req.query("limit") ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
      const types = c.req.query("types")?.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
      const rows = storage.sql<Activity>(`SELECT * FROM {{t:activities}} ${types?.length ? `WHERE type IN (${types.map(() => "?").join(",")})` : ""} ORDER BY start DESC LIMIT ?`, [...(types ?? []), limit]);
      return c.json(rows);
    });
    http.delete("/activities/:id", (c) => {
      storage.run(`DELETE FROM {{t:activities}} WHERE id = ?`, [c.req.param("id")]);
      changed();
      return c.json({ ok: true });
    });
    const weekStats = (types?: string[], ref = new Date()): WeekStats => {
      const start = new Date(ref);
      start.setHours(0, 0, 0, 0);
      const offset = settings.get().weekStart === "sunday" ? start.getDay() : (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - offset);
      const last = new Date(start);
      last.setDate(last.getDate() - 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const rows = query(last.toISOString(), end.toISOString(), types);
      const empty = () => ({ distance: Array(7).fill(0) as number[], duration: Array(7).fill(0) as number[], calories: Array(7).fill(0) as number[], count: Array(7).fill(0) as number[] });
      const tw = empty();
      const lw = empty();
      for (const a of rows) {
        const d = new Date(a.start);
        const inThis = d >= start;
        const idx = Math.floor((d.getTime() - (inThis ? start : last).getTime()) / 86400_000);
        if (idx < 0 || idx > 6) continue;
        const b = inThis ? tw : lw;
        b.distance[idx]! += a.distance_m;
        b.duration[idx]! += a.duration_s;
        b.calories[idx]! += a.calories ?? 0;
        b.count[idx]! += 1;
      }
      const sum = (x: number[]) => x.reduce((s, v) => s + v, 0);
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        return localDay(d);
      });
      return { weekStart: localDay(start), days, thisWeek: tw, lastWeek: lw, totals: { thisWeek: { distance: sum(tw.distance), duration: sum(tw.duration), calories: sum(tw.calories), count: sum(tw.count) }, lastWeek: { distance: sum(lw.distance), duration: sum(lw.duration), calories: sum(lw.calories), count: sum(lw.count) } } };
    };
    http.get("/week", (c) => c.json(weekStats(c.req.query("types")?.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))));
    http.get("/types", (c) => c.json(storage.sql<{ type: string; n: number }>(`SELECT type, COUNT(*) AS n FROM {{t:activities}} GROUP BY type ORDER BY n DESC`)));

    einkRender = (req) => {
      const cfg = req.config as { metric?: "distance" | "duration" | "calories" | "count"; types?: string[]; count?: number };
      const imperial = settings.get().units === "imperial";
      if (req.widget === "recent") {
        const rows = storage.sql<Activity>(`SELECT * FROM {{t:activities}} ${cfg.types?.length ? `WHERE type IN (${cfg.types.map(() => "?").join(",")})` : ""} ORDER BY start DESC LIMIT ?`, [...(cfg.types ?? []), Math.min(cfg.count ?? 5, Math.max(1, Math.floor((req.height - 4) / 20)))]);
        if (!rows.length) return { type: "text", text: t("eink.empty"), size: 12, gray: 0.5 };
        return { type: "col", grow: 1, gap: 3, children: rows.map((a) => ({ type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "text" as const, text: new Date(a.start).toLocaleDateString(req.locale, { weekday: "short", timeZone: req.timezone }).toLowerCase(), size: 11, pixel: false, gray: 0.5 }, { type: "text" as const, text: a.name ?? a.type, size: 12, pixel: false, grow: 1, wrap: false }, { type: "text" as const, text: a.distance_m ? `${(a.distance_m / (imperial ? 1609.344 : 1000)).toFixed(1)} ${imperial ? "mi" : "km"}` : `${Math.round(a.duration_s / 60)} min`, size: 12, pixel: false, bold: true }] })) };
      }
      const w = weekStats(cfg.types);
      const metric = cfg.metric ?? "distance";
      const vals = w.thisWeek[metric];
      const max = Math.max(1, ...vals, ...w.lastWeek[metric]);
      const fmt = (v: number) => (metric === "distance" ? `${(v / (imperial ? 1609.344 : 1000)).toFixed(1)} ${imperial ? "mi" : "km"}` : metric === "duration" ? `${Math.round(v / 60)} min` : metric === "calories" ? `${Math.round(v)} kcal` : `${v}`);
      const barH = Math.max(20, req.height - 50);
      return {
        type: "col",
        grow: 1,
        gap: 4,
        children: [
          { type: "row", gap: 6, align: "center", children: [{ type: "text", text: t("eink.thisWeek"), size: 11, gray: 0.5, grow: 1 }, { type: "text", text: fmt(w.totals.thisWeek[metric]), size: 13, bold: true }, { type: "text", text: t("eink.last", { value: fmt(w.totals.lastWeek[metric]) }), size: 10, pixel: false, gray: 0.5 }] },
          { type: "row", gap: 4, align: "end", grow: 1, children: vals.map((v, i) => ({ type: "col" as const, grow: 1, gap: 2, align: "center" as const, justify: "end" as const, children: [{ type: "box" as const, height: Math.max(v > 0 ? 3 : 1, Math.round((v / max) * barH)), fill: v > 0 ? 1 : 0, border: v > 0 ? 1 : 0, children: [] }, { type: "text" as const, text: w.days[i]!.slice(8), size: 9, pixel: false, gray: 0.5 }] })) },
        ],
      };
    };
    reportStatus();
    logger.info("fitness ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
