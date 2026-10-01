import { defineModule } from "@orbis/sdk/server";

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
};
export type Stop = { id: string; name: string; lat: number | null; lon: number | null; products: string[] };

type Settings = { provider?: "db" | "vbb" | "bvg" | "oebb"; refreshSeconds?: number };

const PROVIDERS: Record<string, { base: string; name: string }> = {
  db: { base: "https://v6.db.transport.rest", name: "Deutsche Bahn (hafas)" },
  vbb: { base: "https://v6.vbb.transport.rest", name: "VBB" },
  bvg: { base: "https://v6.bvg.transport.rest", name: "BVG" },
  oebb: { base: "https://v6.oebb.transport.rest", name: "ÖBB" },
};

export default defineModule<Settings>({
  setup(ctx) {
    const { http, logger, settings } = ctx;
    const base = () => PROVIDERS[settings.get().provider ?? "db"]?.base ?? PROVIDERS.db!.base;
    const cache = new Map<string, { at: number; value: unknown }>();

    async function api<T>(path: string, ttlMs: number): Promise<T> {
      const key = `${base()}${path}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
      const res = await ctx.fetch(key, { headers: { accept: "application/json", "user-agent": "orbis-transport/0.1 (github.com/orbis-hub/orbis)" }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 429) throw new Error("transport api rate limit, try again in a minute");
      if (!res.ok) throw new Error(`transport api HTTP ${res.status}`);
      const value = (await res.json()) as T;
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      return value;
    }

    http.get("/providers", (c) => c.json(Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name }))));
    http.get("/stops", async (c) => {
      const q = c.req.query("q")?.trim();
      if (!q || q.length < 2) return c.json([]);
      try {
        const r = await api<Array<{ id: string; name: string; location?: { latitude: number; longitude: number }; products?: Record<string, boolean> }>>(`/locations?query=${encodeURIComponent(q)}&results=8&stops=true&addresses=false&poi=false`, 10 * 60_000);
        const stops: Stop[] = r.filter((x) => x.id && x.name).map((x) => ({ id: x.id, name: x.name, lat: x.location?.latitude ?? null, lon: x.location?.longitude ?? null, products: Object.entries(x.products ?? {}).filter(([, v]) => v).map(([k]) => k) }));
        return c.json(stops);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    });
    http.get("/departures/:stopId", async (c) => {
      const stopId = c.req.param("stopId");
      const duration = Math.min(180, Number(c.req.query("duration") ?? 60));
      try {
        const r = await api<{ departures?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(`/stops/${encodeURIComponent(stopId)}/departures?duration=${duration}&results=40&remarks=false`, Math.max(20_000, (settings.get().refreshSeconds ?? 60) * 1000 - 5000));
        const list = Array.isArray(r) ? r : (r.departures ?? []);
        const deps: Departure[] = list.map((d) => {
          const line = d.line as { name?: string; product?: string } | undefined;
          const when = d.when as string | null;
          const planned = (d.plannedWhen as string) ?? when ?? new Date().toISOString();
          const delay = d.delay as number | null | undefined;
          return {
            tripId: String(d.tripId ?? `${line?.name}-${planned}`),
            line: line?.name ?? "?",
            product: line?.product ?? "bus",
            direction: String(d.direction ?? ""),
            when,
            plannedWhen: planned,
            delayMin: delay == null ? null : Math.round(delay / 60),
            platform: (d.platform as string | null) ?? (d.plannedPlatform as string | null) ?? null,
            cancelled: !!d.cancelled,
          };
        });
        return c.json({ stopId, departures: deps, fetchedAt: new Date().toISOString() });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    });

    einkRender = async (req) => {
      const cfg = req.config as { stopId?: string; stopName?: string; count?: number; lines?: string[] };
      if (!cfg.stopId) return { type: "text", text: "no stop configured", size: 12, gray: 0.5 };
      try {
        const r = await api<{ departures?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(`/stops/${encodeURIComponent(cfg.stopId)}/departures?duration=90&results=30&remarks=false`, 60_000);
        const list = (Array.isArray(r) ? r : (r.departures ?? [])).filter((d) => !cfg.lines?.length || cfg.lines.includes(String((d.line as { name?: string })?.name)));
        const max = Math.max(1, Math.floor((req.height - 22) / 20));
        const rows = list.slice(0, max).map((d) => {
          const when = (d.when as string | null) ?? (d.plannedWhen as string);
          const mins = Math.max(0, Math.round((new Date(when).getTime() - req.now.getTime()) / 60_000));
          const delay = d.delay ? Math.round((d.delay as number) / 60) : 0;
          return { type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "text" as const, text: String((d.line as { name?: string })?.name ?? "?"), size: 13, bold: true, wrap: false }, { type: "text" as const, text: String(d.direction ?? ""), size: 12, pixel: false, grow: 1, wrap: false }, { type: "text" as const, text: d.cancelled ? "✕" : mins === 0 ? "now" : `${mins}'${delay > 0 ? ` (+${delay})` : ""}`, size: 13, pixel: false, bold: delay > 0 }] };
        });
        return { type: "col", grow: 1, gap: 3, children: [{ type: "text", text: cfg.stopName ?? cfg.stopId, size: 12, gray: 0.5 }, ...rows] };
      } catch (err) {
        return { type: "text", text: (err as Error).message, size: 11, gray: 0.5 };
      }
    };
    logger.info(`departures ready (${settings.get().provider ?? "db"})`);
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => Promise<import("@orbis/sdk/server").EinkTree>) | null = null;
