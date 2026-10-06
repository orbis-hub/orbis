/**
 * HAFAS backends via the public transport.rest apis (no key, be polite). One provider per profile;
 * the response shape is the same for all of them (friendly-public-transport-format).
 */
import { haversineKm, lineColor, parseTrip, type TripRoute } from "../lib";
import type { Departure, JsonGet, Stop, TransportProvider } from "./types";

export const HAFAS_ID_PREFIX = "hafas";
export const HAFAS_UNAVAILABLE = "transport api unavailable";
export const HAFAS_RATE_LIMIT = "transport api rate limit, try again in a minute";

export const HAFAS_PROFILES: Record<string, { base: string; name: string; country: string }> = {
  db: { base: "https://v6.db.transport.rest", name: "Deutsche Bahn (hafas)", country: "de" },
  vbb: { base: "https://v6.vbb.transport.rest", name: "VBB", country: "de" },
  bvg: { base: "https://v6.bvg.transport.rest", name: "BVG", country: "de" },
  oebb: { base: "https://v6.oebb.transport.rest", name: "ÖBB", country: "at" },
};

const STOPS_TIMEOUT_MS = 6_000;
const DEPARTURES_TIMEOUT_MS = 8_000;
const TRIP_TIMEOUT_MS = 8_000;

export type HafasLocation = { id?: string; name?: string; type?: string; location?: { latitude?: number; longitude?: number }; products?: Record<string, boolean> };
export type HafasDeparture = Record<string, unknown>;

export function mapHafasStop(x: HafasLocation): Stop | null {
  if (!x.id || !x.name) return null;
  return {
    id: `${HAFAS_ID_PREFIX}:${x.id}`,
    name: x.name,
    lat: typeof x.location?.latitude === "number" ? x.location.latitude : null,
    lon: typeof x.location?.longitude === "number" ? x.location.longitude : null,
    products: Object.entries(x.products ?? {}).filter(([, v]) => v).map(([k]) => k),
  };
}

export function mapHafasDeparture(d: HafasDeparture): Departure {
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

export function createHafasProvider(profileId: string, get: JsonGet): TransportProvider {
  const profile = HAFAS_PROFILES[profileId] ?? HAFAS_PROFILES.db!;
  const base = profile.base;
  return {
    id: HAFAS_PROFILES[profileId] ? profileId : "db",
    family: "hafas",
    name: profile.name,
    country: profile.country,

    async searchStops(query, near) {
      let raw: HafasLocation[];
      if (query.length >= 2) raw = await get(`${base}/locations?query=${encodeURIComponent(query)}&results=${near ? 12 : 8}&stops=true&addresses=false&poi=false`, 10 * 60_000, STOPS_TIMEOUT_MS);
      else if (near) raw = await get(`${base}/locations/nearby?latitude=${near[0]}&longitude=${near[1]}&results=8&stops=true&poi=false&distance=3000`, 5 * 60_000, STOPS_TIMEOUT_MS);
      else return [];
      if (!Array.isArray(raw)) raw = [];
      let stops = raw.map(mapHafasStop).filter((s): s is Stop => !!s);
      if (near) {
        for (const s of stops) if (s.lat != null && s.lon != null) s.distanceKm = Math.round(haversineKm(near, [s.lat, s.lon]) * 100) / 100;
        stops = stops.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)).slice(0, 8);
      }
      return stops;
    },

    async departures(localId, durationMin, ttlMs) {
      const r = await get<{ departures?: HafasDeparture[] } | HafasDeparture[]>(`${base}/stops/${encodeURIComponent(localId)}/departures?duration=${durationMin}&results=40&remarks=false`, ttlMs, DEPARTURES_TIMEOUT_MS);
      const list = Array.isArray(r) ? r : (r?.departures ?? []);
      return list.map(mapHafasDeparture);
    },

    async trip(tripId, hint): Promise<TripRoute | null> {
      const qs = new URLSearchParams({ stopovers: "true", polyline: "true", remarks: "false" });
      if (hint.line) qs.set("lineName", hint.line);
      const raw = await get<unknown>(`${base}/trips/${encodeURIComponent(tripId)}?${qs}`, 5 * 60_000, TRIP_TIMEOUT_MS);
      return parseTrip(raw, { id: tripId, line: hint.line });
    },
  };
}
