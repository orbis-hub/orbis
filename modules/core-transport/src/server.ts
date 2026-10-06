import { defineModule } from "@orbis/sdk/server";
import { ReverseGeocoder, haversineKm, lineColor, parseLatLon, parseTrip, type Place, type TripRoute } from "./lib";

export type { Place, TripRoute, TripStopover } from "./lib";

/**
 * Departure boards via the public transport.rest apis (hafas based, no key, be polite).
 * Providers map to base urls; the response shape is the same (friendly-public-transport-format).
 */
export type Departure = {
  tripId: string;
  line: string;
  product: string;
  direction: string;
  when: string | null; // planned + delay
  plannedWhen: string;
  delayMin: number | null;
  platform: string | null;
  cancelled: boolean;
  /** css colour for the line (hafas colour when present, else a stable hash) */
  color: string;
};
export type Stop = {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  products: string[];
  /** reverse geocoded city / landkreis / bundesland — missing while nominatim is still queued */
  place?: Place | null;
  /** only when the search had a `near=` reference point */
  distanceKm?: number;
};
export type ApiError = { error: string; retryAt?: string };

type Settings = { provider?: "db" | "vbb" | "bvg" | "oebb"; refreshSeconds?: number };

const PROVIDERS: Record<string, { base: string; name: string; country: string }> = {
  db: { base: "https://v6.db.transport.rest", name: "Deutsche Bahn (hafas)", country: "de" },
  vbb: { base: "https://v6.vbb.transport.rest", name: "VBB", country: "de" },
  bvg: { base: "https://v6.bvg.transport.rest", name: "BVG", country: "de" },
  oebb: { base: "https://v6.oebb.transport.rest", name: "ÖBB", country: "at" },
};

const STOPS_TIMEOUT_MS = 6_000;
const DEPARTURES_TIMEOUT_MS = 8_000;
const TRIP_TIMEOUT_MS = 8_000;
const FAILURE_TTL_MS = 60_000;
const ENRICH_MAX = 8;
const ENRICH_DEADLINE_MS = 3_000;

class ApiUnavailable extends Error {
  constructor(
    message: string,
    public readonly retryAt: number,
  ) {
    super(message);
  }
}

type HafasLocation = { id?: string; name?: string; type?: string; location?: { latitude?: number; longitude?: number }; products?: Record<string, boolean> };
type HafasDeparture = Record<string, unknown>;

export default defineModule<Settings>({
  setup(ctx) {
    const { http, logger, settings, i18n } = ctx;
    const providerId = () => settings.get().provider ?? "db";
    const provider = () => PROVIDERS[providerId()] ?? PROVIDERS.db!;
    const base = () => provider().base;
    const userAgent = `orbis-hub/${ctx.hubVersion} (+https://github.com/orbis-hub/orbis)`;

    /* ---------- transport.rest client: ttl cache, in-flight dedupe, failure cache ---------- */
    const cache = new Map<string, { at: number; value: unknown }>();
    const inflight = new Map<string, Promise<unknown>>();
    /** key → when the backend may be asked again (per url for 4xx, per backend for network trouble) */
    const failures = new Map<string, { until: number; message: string }>();

    function failed(key: string): ApiUnavailable | null {
      for (const k of [key, base()]) {
        const f = failures.get(k);
        if (!f) continue;
        if (Date.now() < f.until) return new ApiUnavailable(f.message, f.until);
        failures.delete(k);
      }
      return null;
    }

    async function api<T>(path: string, ttlMs: number, timeoutMs: number): Promise<T> {
      const key = `${base()}${path}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
      const down = failed(key);
      if (down) throw down;
      const running = inflight.get(key);
      if (running) return running as Promise<T>;
      const p = (async () => {
        let res: Response;
        try {
          res = await ctx.fetch(key, { headers: { accept: "application/json", "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
          // timeout / dns / connection reset: the whole backend is in trouble, do not hammer it
          const until = Date.now() + FAILURE_TTL_MS;
          failures.set(base(), { until, message: "transport api unavailable" });
          logger.warn(`transport.rest ${providerId()} unreachable (${(err as Error).name}: ${(err as Error).message}); backing off ${FAILURE_TTL_MS / 1000}s`);
          throw new ApiUnavailable("transport api unavailable", until);
        }
        if (res.status === 429 || res.status >= 500) {
          const until = Date.now() + FAILURE_TTL_MS;
          failures.set(base(), { until, message: res.status === 429 ? "transport api rate limit, try again in a minute" : "transport api unavailable" });
          logger.warn(`transport.rest ${providerId()} HTTP ${res.status}; backing off ${FAILURE_TTL_MS / 1000}s`);
          throw new ApiUnavailable(failures.get(base())!.message, until);
        }
        if (!res.ok) {
          const until = Date.now() + FAILURE_TTL_MS;
          failures.set(key, { until, message: `transport api HTTP ${res.status}` });
          throw new ApiUnavailable(`transport api HTTP ${res.status}`, until);
        }
        const value = (await res.json()) as T;
        cache.set(key, { at: Date.now(), value });
        if (cache.size > 300) cache.delete(cache.keys().next().value!);
        return value;
      })();
      inflight.set(key, p);
      try {
        return await p;
      } finally {
        inflight.delete(key);
      }
    }

    function errorResponse(c: { json: (body: unknown, status: 502) => Response }, err: unknown): Response {
      if (err instanceof ApiUnavailable) return c.json({ error: err.message, retryAt: new Date(err.retryAt).toISOString() } satisfies ApiError, 502);
      return c.json({ error: (err as Error).message } satisfies ApiError, 502);
    }

    /* ---------- places (nominatim) ---------- */
    const geocoder = new ReverseGeocoder({ fetch: ctx.fetch, storage: ctx.storage, userAgent, log: (m) => logger.warn(m) });

    /** fill `place` on the first few stops, but give up waiting after the deadline (the lookups keep running and land in the cache) */
    async function enrichStops(stops: Stop[], language: string): Promise<void> {
      const targets = stops.filter((s) => s.lat != null && s.lon != null).slice(0, ENRICH_MAX);
      if (!targets.length) return;
      const jobs = targets.map((s) => geocoder.lookup(s.lat!, s.lon!, language).then((p) => { s.place = p; }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(jobs), new Promise<void>((r) => { timer = setTimeout(r, ENRICH_DEADLINE_MS); })]);
      clearTimeout(timer);
    }

    function toStop(x: HafasLocation): Stop | null {
      if (!x.id || !x.name) return null;
      return {
        id: x.id,
        name: x.name,
        lat: typeof x.location?.latitude === "number" ? x.location.latitude : null,
        lon: typeof x.location?.longitude === "number" ? x.location.longitude : null,
        products: Object.entries(x.products ?? {}).filter(([, v]) => v).map(([k]) => k),
      };
    }

    function toDeparture(d: HafasDeparture): Departure {
      const line = d.line as { name?: string; product?: string; color?: unknown } | undefined;
      const when = (d.when as string | null) ?? null;
      const planned = (d.plannedWhen as string) ?? when ?? new Date().toISOString();
      const delay = d.delay as number | null | undefined;
      const name = line?.name ?? "?";
      return {
        tripId: String(d.tripId ?? `${name}-${planned}`),
        line: name,
        product: line?.product ?? "bus",
        direction: String(d.direction ?? ""),
        when,
        plannedWhen: planned,
        delayMin: typeof delay === "number" && Number.isFinite(delay) ? Math.round(delay / 60) : null,
        platform: (d.platform as string | null) ?? (d.plannedPlatform as string | null) ?? null,
        cancelled: !!d.cancelled,
        color: lineColor(line?.color, name),
      };
    }

    /* ---------- routes ---------- */
    http.get("/providers", (c) => c.json(Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name }))));

    /**
     * `?q=` name search (sorted by distance when `near=lat,lon` is given), or just `near=` for stops around a point.
     * The first 8 results carry `place` once nominatim answered (never waits longer than ~3 s).
     */
    http.get("/stops", async (c) => {
      const q = c.req.query("q")?.trim() ?? "";
      const near = parseLatLon(c.req.query("near"));
      if (q.length < 2 && !near) return c.json([]);
      try {
        let raw: HafasLocation[];
        if (q.length >= 2) {
          raw = await api<HafasLocation[]>(`/locations?query=${encodeURIComponent(q)}&results=${near ? 12 : 8}&stops=true&addresses=false&poi=false`, 10 * 60_000, STOPS_TIMEOUT_MS);
        } else {
          raw = await api<HafasLocation[]>(`/locations/nearby?latitude=${near![0]}&longitude=${near![1]}&results=8&stops=true&poi=false&distance=3000`, 5 * 60_000, STOPS_TIMEOUT_MS);
        }
        if (!Array.isArray(raw)) raw = [];
        let stops = raw.map(toStop).filter((s): s is Stop => !!s);
        if (near) {
          for (const s of stops) if (s.lat != null && s.lon != null) s.distanceKm = Math.round(haversineKm(near, [s.lat, s.lon]) * 100) / 100;
          stops = stops.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)).slice(0, 8);
        }
        await enrichStops(stops, i18n.language);
        return c.json(stops);
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    /** place for one coordinate: answers from the cache or waits a few seconds for nominatim (the client uses it to fill in late results) */
    http.get("/place", async (c) => {
      const at = parseLatLon(`${c.req.query("lat") ?? ""},${c.req.query("lon") ?? ""}`);
      if (!at) return c.json({ error: "lat/lon required" }, 400);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const place = await Promise.race([
        geocoder.lookup(at[0], at[1], i18n.language),
        new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), 4_000); }),
      ]);
      clearTimeout(timer);
      if (place === undefined) return c.json({ pending: true, queued: geocoder.queued }, 202);
      return c.json({ place });
    });

    http.get("/departures/:stopId", async (c) => {
      const stopId = c.req.param("stopId");
      const wanted = Number(c.req.query("duration"));
      const duration = Number.isFinite(wanted) ? Math.min(180, Math.max(5, Math.round(wanted))) : 60;
      try {
        const r = await api<{ departures?: HafasDeparture[] } | HafasDeparture[]>(
          `/stops/${encodeURIComponent(stopId)}/departures?duration=${duration}&results=40&remarks=false`,
          Math.max(20_000, (settings.get().refreshSeconds ?? 60) * 1000 - 5000),
          DEPARTURES_TIMEOUT_MS,
        );
        const list = Array.isArray(r) ? r : (r?.departures ?? []);
        return c.json({ stopId, departures: list.map(toDeparture), fetchedAt: new Date().toISOString() });
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    /** route of one trip (polyline + stopovers) for the map; `line` helps some hafas backends resolve the id */
    http.get("/trip", async (c) => {
      const id = c.req.query("id")?.trim();
      const line = c.req.query("line")?.trim();
      if (!id) return c.json({ error: "id required" }, 400);
      try {
        const qs = new URLSearchParams({ stopovers: "true", polyline: "true", remarks: "false" });
        if (line) qs.set("lineName", line);
        const raw = await api<unknown>(`/trips/${encodeURIComponent(id)}?${qs}`, 5 * 60_000, TRIP_TIMEOUT_MS);
        const trip: TripRoute | null = parseTrip(raw, { id, line });
        if (!trip) return c.json({ error: "trip not found" }, 404);
        return c.json(trip);
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    /* ---------- e-ink ---------- */
    einkRender = async (req) => {
      const cfg = req.config as { stopId?: string; stopName?: string; count?: number; lines?: string[] };
      if (!cfg.stopId) return { type: "text", text: i18n.t("eink.noStop"), size: 12, gray: 0.5 };
      try {
        const r = await api<{ departures?: HafasDeparture[] } | HafasDeparture[]>(`/stops/${encodeURIComponent(cfg.stopId)}/departures?duration=90&results=30&remarks=false`, 60_000, DEPARTURES_TIMEOUT_MS);
        const list = (Array.isArray(r) ? r : (r?.departures ?? [])).filter((d) => !cfg.lines?.length || cfg.lines.includes(String((d.line as { name?: string })?.name)));
        const max = Math.max(1, Math.floor((req.height - 22) / 20));
        const rows = list.slice(0, max).map((d) => {
          const when = (d.when as string | null) ?? (d.plannedWhen as string);
          const mins = Math.max(0, Math.round((new Date(when).getTime() - req.now.getTime()) / 60_000));
          const delay = typeof d.delay === "number" ? Math.round(d.delay / 60) : 0;
          return { type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "text" as const, text: String((d.line as { name?: string })?.name ?? "?"), size: 13, bold: true, wrap: false }, { type: "text" as const, text: String(d.direction ?? ""), size: 12, pixel: false, grow: 1, wrap: false }, { type: "text" as const, text: d.cancelled ? "✕" : mins === 0 ? i18n.t("now") : `${mins}'${delay > 0 ? ` (+${delay})` : ""}`, size: 13, pixel: false, bold: delay > 0 }] };
        });
        return { type: "col", grow: 1, gap: 3, children: [{ type: "text", text: cfg.stopName ?? cfg.stopId, size: 12, gray: 0.5 }, ...rows] };
      } catch (err) {
        return { type: "text", text: err instanceof ApiUnavailable ? i18n.t("error.unavailable") : (err as Error).message, size: 11, gray: 0.5 };
      }
    };
    logger.info(`departures ready (${providerId()})`);
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => Promise<import("@orbis/sdk/server").EinkTree>) | null = null;
