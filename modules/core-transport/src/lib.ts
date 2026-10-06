/**
 * Pure helpers shared by the server and the client bundle (no sdk / node imports so both can use them
 * and a node script can unit-test them with sample json).
 */

export type Place = {
  /** city / town / village / municipality */
  city: string | null;
  /** landkreis / county */
  district: string | null;
  /** bundesland */
  state: string | null;
  /** iso 3166-1 alpha-2, lowercase */
  country: string | null;
};

export type LatLon = [lat: number, lon: number];

export type TripStopover = {
  id: string | null;
  name: string;
  lat: number | null;
  lon: number | null;
  arrival: string | null;
  departure: string | null;
  cancelled: boolean;
};

export type TripRoute = {
  id: string;
  line: string;
  product: string | null;
  direction: string | null;
  color: string;
  /** [lat, lon] pairs in travel order */
  polyline: LatLon[];
  stopovers: TripStopover[];
};

/* ---------- nominatim ---------- */

type NominatimAddress = Partial<Record<string, string>>;
export type NominatimReverse = { error?: string; address?: NominatimAddress; display_name?: string };

function clean(v: string | undefined | null): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

/** `address.city|town|village|municipality`, `address.county` (landkreis), `address.state`, `address.country_code` */
export function parsePlace(json: NominatimReverse | null | undefined): Place | null {
  if (!json || json.error || !json.address) return null;
  const a = json.address;
  const city = clean(a.city) ?? clean(a.town) ?? clean(a.village) ?? clean(a.municipality) ?? clean(a.city_district) ?? clean(a.suburb);
  const district = clean(a.county) ?? clean(a.state_district);
  const state = clean(a.state);
  const country = clean(a.country_code)?.toLowerCase() ?? null;
  if (!city && !district && !state && !country) return null;
  return { city, district, state, country };
}

/** "würzburg · landkreis würzburg · bayern" — dedupes repeated parts, drops the country when it is the hub's own */
export function placeLabel(place: Place | null | undefined, opts: { homeCountry?: string | null; lowercase?: boolean; locale?: string } = {}): string {
  if (!place) return "";
  const parts: string[] = [];
  for (const p of [place.city, place.district, place.state]) {
    if (!p) continue;
    if (parts.some((x) => x.toLowerCase() === p.toLowerCase())) continue;
    parts.push(p);
  }
  if (place.country && opts.homeCountry && place.country !== opts.homeCountry.toLowerCase()) parts.push(place.country.toUpperCase());
  const s = parts.join(" · ");
  return opts.lowercase === false ? s : s.toLocaleLowerCase(opts.locale ?? undefined);
}

/** 3 decimals ≈ 110 m — close enough to share one reverse lookup between neighbouring platforms */
export function placeKey(lat: number, lon: number, language = "en"): string {
  return `place:${language}:${lat.toFixed(3)},${lon.toFixed(3)}`;
}

export const PLACE_TTL_MS = 30 * 24 * 3600_000;
export const PLACE_NEGATIVE_TTL_MS = 3600_000;

type GeoStorage = { get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void };
type Cached = { at: number; place: Place | null };

/**
 * Serial reverse geocoder with nominatim's usage policy baked in: one request at a time, ≥ 1 s apart,
 * a real user-agent, persistent cache (30 days, misses 1 h). `lookup()` resolves whenever the answer is
 * there — callers race it against their own deadline.
 */
export class ReverseGeocoder {
  private readonly queue: Array<{ key: string; lat: number; lon: number; language: string; resolve: (p: Place | null) => void }> = [];
  private readonly pending = new Map<string, Promise<Place | null>>();
  private lastAt = 0;
  private running = false;

  constructor(
    private readonly deps: {
      fetch: typeof fetch;
      storage: GeoStorage;
      userAgent: string;
      log?: (msg: string) => void;
      minIntervalMs?: number;
      timeoutMs?: number;
      base?: string;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** what is already known, without touching the network (undefined = unknown) */
  cached(lat: number, lon: number, language: string): Place | null | undefined {
    const hit = this.deps.storage.get<Cached>(placeKey(lat, lon, language));
    if (!hit) return undefined;
    const ttl = hit.place ? PLACE_TTL_MS : PLACE_NEGATIVE_TTL_MS;
    if (this.now() - hit.at > ttl) return undefined;
    return hit.place;
  }

  lookup(lat: number, lon: number, language: string): Promise<Place | null> {
    const known = this.cached(lat, lon, language);
    if (known !== undefined) return Promise.resolve(known);
    const key = placeKey(lat, lon, language);
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = new Promise<Place | null>((resolve) => {
      this.queue.push({ key, lat, lon, language, resolve });
      void this.drain();
    });
    this.pending.set(key, p);
    return p;
  }

  get queued(): number {
    return this.queue.length;
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        const wait = this.lastAt + (this.deps.minIntervalMs ?? 1100) - this.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastAt = this.now();
        let place: Place | null = null;
        try {
          place = await this.fetchPlace(job.lat, job.lon, job.language);
        } catch (err) {
          this.deps.log?.(`reverse geocode failed for ${job.lat},${job.lon}: ${(err as Error).message}`);
        }
        try {
          this.deps.storage.set(job.key, { at: this.now(), place } satisfies Cached);
        } catch {
          /* storage is best effort */
        }
        this.pending.delete(job.key);
        job.resolve(place);
      }
    } finally {
      this.running = false;
    }
  }

  private async fetchPlace(lat: number, lon: number, language: string): Promise<Place | null> {
    const base = this.deps.base ?? "https://nominatim.openstreetmap.org/reverse";
    const url = `${base}?format=jsonv2&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=10&accept-language=${encodeURIComponent(language)}`;
    const res = await this.deps.fetch(url, {
      headers: { accept: "application/json", "user-agent": this.deps.userAgent, "accept-language": language },
      signal: AbortSignal.timeout(this.deps.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`nominatim HTTP ${res.status}`);
    return parsePlace((await res.json()) as NominatimReverse);
  }
}

/* ---------- geometry ---------- */

export function haversineKm(a: LatLon, b: LatLon): number {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** "49.801,9.936" → [49.801, 9.936]; anything else → null */
export function parseLatLon(s: string | null | undefined): LatLon | null {
  if (!s) return null;
  const m = s.split(",").map((x) => Number(x.trim()));
  if (m.length !== 2 || !m.every((n) => Number.isFinite(n))) return null;
  const [lat, lon] = m as [number, number];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.max(50, Math.round(km * 1000 / 50) * 50)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/* ---------- lines & colours ---------- */

/** stable, reasonably saturated colour for a line name when hafas does not give us one */
export function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 70% 45%)`;
}

/** hafas `line.color` comes in a few shapes: "#ff0000", { bg: "#ff0000" }, { fg, bg } — normalise to a css colour */
export function lineColor(raw: unknown, fallbackName: string): string {
  if (typeof raw === "string" && raw.trim()) return raw.startsWith("#") || /^[a-z]+\(/.test(raw) ? raw : `#${raw}`;
  if (raw && typeof raw === "object") {
    const o = raw as { bg?: unknown; background?: unknown; fg?: unknown };
    const c = o.bg ?? o.background ?? o.fg;
    if (typeof c === "string" && c.trim()) return c.startsWith("#") ? c : `#${c}`;
  }
  return hashColor(fallbackName);
}

/* ---------- trips ---------- */

type GeoJsonFeature = { type?: string; geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> | null };
type HafasStop = { type?: string; id?: string; name?: string; location?: { latitude?: number; longitude?: number } };
type HafasStopover = { stop?: HafasStop; arrival?: string | null; departure?: string | null; plannedArrival?: string | null; plannedDeparture?: string | null; cancelled?: boolean };
export type HafasTrip = {
  id?: string;
  line?: { name?: string; product?: string; color?: unknown };
  direction?: string | null;
  polyline?: { type?: string; features?: GeoJsonFeature[] } | null;
  stopovers?: HafasStopover[];
  origin?: HafasStop;
  destination?: HafasStop;
};

/** transport.rest v6 wraps the trip: `{ trip, realtimeDataUpdatedAt }`; older versions return the trip itself */
export function unwrapTrip(json: unknown): HafasTrip | null {
  if (!json || typeof json !== "object") return null;
  const o = json as { trip?: HafasTrip; id?: string };
  if (o.trip && typeof o.trip === "object") return o.trip;
  if ("id" in o || "line" in o || "stopovers" in o) return o as HafasTrip;
  return null;
}

/** hafas polylines are a FeatureCollection of Points in travel order ([lon, lat]); LineStrings are accepted too */
export function polylineToLatLon(poly: HafasTrip["polyline"]): LatLon[] {
  const out: LatLon[] = [];
  const push = (c: unknown) => {
    if (!Array.isArray(c) || c.length < 2) return;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
  };
  for (const f of poly?.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Point") push(g.coordinates);
    else if (g.type === "LineString" && Array.isArray(g.coordinates)) for (const c of g.coordinates) push(c);
    else if (g.type === "MultiLineString" && Array.isArray(g.coordinates)) for (const line of g.coordinates) if (Array.isArray(line)) for (const c of line) push(c);
  }
  return out;
}

export function parseTrip(json: unknown, fallback: { id: string; line?: string }): TripRoute | null {
  const trip = unwrapTrip(json);
  if (!trip) return null;
  const line = trip.line?.name ?? fallback.line ?? "?";
  const stopovers: TripStopover[] = (trip.stopovers ?? [])
    .filter((s) => s.stop?.name)
    .map((s) => ({
      id: s.stop?.id ?? null,
      name: s.stop!.name!,
      lat: s.stop?.location?.latitude ?? null,
      lon: s.stop?.location?.longitude ?? null,
      arrival: s.arrival ?? s.plannedArrival ?? null,
      departure: s.departure ?? s.plannedDeparture ?? null,
      cancelled: !!s.cancelled,
    }));
  let polyline = polylineToLatLon(trip.polyline);
  // no polyline from the backend (some profiles): connect the stopovers so there is still a route to show
  if (polyline.length < 2) polyline = stopovers.filter((s) => s.lat != null && s.lon != null).map((s) => [s.lat!, s.lon!] as LatLon);
  return {
    id: trip.id ?? fallback.id,
    line,
    product: trip.line?.product ?? null,
    direction: trip.direction ?? trip.destination?.name ?? null,
    color: lineColor(trip.line?.color, line),
    polyline,
    stopovers,
  };
}
