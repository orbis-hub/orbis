import { defineModule } from "@orbis/sdk/server";
import { ReverseGeocoder, parseLatLon, type Place, type TripRoute } from "./lib";
import { ApiUnavailable, PROVIDER_INFOS, backendFor, createProvider, isProviderId, parseStopId, providerForTrip, type Backend, type Departure, type JsonGet, type ProviderId, type Stop, type TransportProvider } from "./providers";

export type { Place, TripRoute, TripStopover } from "./lib";
export type { Departure, Stop } from "./providers";

/**
 * Departure boards. Two provider families behind one interface (`src/providers`):
 *   hafas — public transport.rest apis (db / vbb / bvg / oebb), friendly-public-transport-format
 *   vgn   — VAG Abfahrtsmonitor api for the Nürnberg region
 * A stop id carries its family (`hafas:…`, `vgn:…`; bare = hafas) so dashboards can mix providers.
 */
export type ApiError = { error: string; retryAt?: string };

type Settings = { provider?: ProviderId; refreshSeconds?: number };

const FAILURE_TTL_MS = 60_000;
const ENRICH_MAX = 8;
const ENRICH_DEADLINE_MS = 3_000;

export default defineModule<Settings>({
  setup(ctx) {
    const { http, logger, settings, i18n } = ctx;
    const providerId = (): ProviderId => {
      const p = settings.get().provider;
      return isProviderId(p) ? p : "db";
    };
    const userAgent = `orbis-hub/${ctx.hubVersion} (+https://github.com/orbis-hub/orbis)`;

    /* ---------- http client: ttl cache, in-flight dedupe, per-backend failure cache ---------- */
    const cache = new Map<string, { at: number; value: unknown }>();
    const inflight = new Map<string, Promise<unknown>>();
    /** key → when the backend may be asked again (per url for 4xx, per backend for network trouble / 5xx / 429) */
    const failures = new Map<string, { until: number; message: string }>();

    function failed(url: string, backend: Backend): ApiUnavailable | null {
      for (const k of [url, backend.key]) {
        const f = failures.get(k);
        if (!f) continue;
        if (Date.now() < f.until) return new ApiUnavailable(f.message, f.until);
        failures.delete(k);
      }
      return null;
    }

    async function getJson<T>(url: string, ttlMs: number, timeoutMs: number, backend: Backend): Promise<T> {
      const hit = cache.get(url);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
      const down = failed(url, backend);
      if (down) throw down;
      const running = inflight.get(url);
      if (running) return running as Promise<T>;
      const p = (async () => {
        let res: Response;
        try {
          res = await ctx.fetch(url, { headers: { accept: "application/json", "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
          // timeout / dns / connection reset: the whole backend is in trouble, do not hammer it
          const until = Date.now() + FAILURE_TTL_MS;
          failures.set(backend.key, { until, message: backend.unavailable });
          logger.warn(`${backend.key} unreachable (${(err as Error).name}: ${(err as Error).message}); backing off ${FAILURE_TTL_MS / 1000}s`);
          throw new ApiUnavailable(backend.unavailable, until);
        }
        if (res.status === 429 || res.status >= 500) {
          const until = Date.now() + FAILURE_TTL_MS;
          const message = res.status === 429 ? backend.rateLimit : backend.unavailable;
          failures.set(backend.key, { until, message });
          logger.warn(`${backend.key} HTTP ${res.status}; backing off ${FAILURE_TTL_MS / 1000}s`);
          throw new ApiUnavailable(message, until);
        }
        if (!res.ok) {
          // 4xx is about this url (unknown stop, unknown trip): remember it, leave the backend alone
          const until = Date.now() + FAILURE_TTL_MS;
          failures.set(url, { until, message: `${backend.unavailable.split(" ")[0]} api HTTP ${res.status}` });
          throw new ApiUnavailable(failures.get(url)!.message, until);
        }
        const value = (await res.json()) as T;
        cache.set(url, { at: Date.now(), value });
        if (cache.size > 300) cache.delete(cache.keys().next().value!);
        return value;
      })();
      inflight.set(url, p);
      try {
        return await p;
      } finally {
        inflight.delete(url);
      }
    }

    const providers = new Map<ProviderId, TransportProvider>();
    function provider(id: ProviderId = providerId()): TransportProvider {
      let p = providers.get(id);
      if (!p) {
        const backend = backendFor(id);
        const get: JsonGet = (url, ttlMs, timeoutMs) => getJson(url, ttlMs, timeoutMs, backend);
        p = createProvider(id, get);
        providers.set(id, p);
      }
      return p;
    }

    function errorResponse(c: { json: (body: unknown, status: 502) => Response }, err: unknown): Response {
      if (err instanceof ApiUnavailable) return c.json({ error: err.message, retryAt: new Date(err.retryAt).toISOString() } satisfies ApiError, 502);
      return c.json({ error: (err as Error).message } satisfies ApiError, 502);
    }

    const departuresTtl = () => Math.max(20_000, (settings.get().refreshSeconds ?? 60) * 1000 - 5000);

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

    /* ---------- routes ---------- */
    http.get("/providers", (c) => c.json(PROVIDER_INFOS.map((p) => ({ id: p.id, name: p.name, family: p.family, country: p.country, active: p.id === providerId() }))));

    /**
     * `?q=` name search (sorted by distance when `near=lat,lon` is given), or just `near=` for stops around a point.
     * Searches the configured provider; the first 8 results carry `place` once nominatim answered (never waits longer than ~3 s).
     */
    http.get("/stops", async (c) => {
      const q = c.req.query("q")?.trim() ?? "";
      const near = parseLatLon(c.req.query("near"));
      if (q.length < 2 && !near) return c.json([]);
      try {
        const stops = await provider().searchStops(q, near);
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

    async function board(stopId: string, durationMin: number, ttlMs: number): Promise<{ provider: ProviderId; departures: Departure[] }> {
      const ref = parseStopId(stopId, settings.get().provider);
      if (!ref) throw new Error("stop id required");
      return { provider: ref.providerId, departures: await provider(ref.providerId).departures(ref.localId, durationMin, ttlMs) };
    }

    http.get("/departures/:stopId", async (c) => {
      const stopId = c.req.param("stopId");
      const wanted = Number(c.req.query("duration"));
      const duration = Number.isFinite(wanted) ? Math.min(180, Math.max(5, Math.round(wanted))) : 60;
      try {
        const r = await board(stopId, duration, departuresTtl());
        return c.json({ stopId, provider: r.provider, departures: r.departures, fetchedAt: new Date().toISOString() });
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
        const trip: TripRoute | null = await provider(providerForTrip(id, settings.get().provider)).trip(id, { line });
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
        const { departures } = await board(cfg.stopId, 90, 60_000);
        const list = departures.filter((d) => !cfg.lines?.length || cfg.lines.includes(d.line));
        const max = Math.max(1, Math.floor((req.height - 22) / 20));
        const rows = list.slice(0, max).map((d) => {
          const when = d.when ?? d.plannedWhen;
          const mins = Math.max(0, Math.round((new Date(when).getTime() - req.now.getTime()) / 60_000));
          const delay = d.delayMin ?? 0;
          return { type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "text" as const, text: d.line, size: 13, bold: true, wrap: false }, { type: "text" as const, text: d.direction, size: 12, pixel: false, grow: 1, wrap: false }, { type: "text" as const, text: d.cancelled ? "✕" : mins === 0 ? i18n.t("now") : `${mins}'${delay > 0 ? ` (+${delay})` : ""}`, size: 13, pixel: false, bold: delay > 0 }] };
        });
        return { type: "col", grow: 1, gap: 3, children: [{ type: "text", text: cfg.stopName ?? cfg.stopId, size: 12, gray: 0.5 }, ...rows] };
      } catch (err) {
        return { type: "text", text: err instanceof ApiUnavailable ? i18n.t(err.message.startsWith("vgn") ? "error.vgnUnavailable" : "error.unavailable") : (err as Error).message, size: 11, gray: 0.5 };
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
