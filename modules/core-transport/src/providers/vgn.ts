/**
 * VGN (Verkehrsverbund Großraum Nürnberg) via the open VAG departure monitor api
 * (`https://start.vag.de/dm/api/v1/`, "VAG Abfahrtsmonitor API", no key).
 *
 * Shapes as the live api returns them (checked 2026-10-06, Puls-API-v1.3.0):
 *   GET haltestellen.json/vgn?name=Stein                → { Haltestellen: [{ Haltestellenname, VAGKennung, VGNKennung, Longitude, Latitude, Produkte: "Bus,Tram" }] }
 *   GET haltestellen.json/vgn/location?lon=&lat=&radius= → same shape, nearest first
 *   GET abfahrten.json/vgn/<VGNKennung>?timespan=60&limitcount=40
 *                                                       → { Abfahrten: [{ Linienname, Richtungstext, AbfahrtszeitSoll, AbfahrtszeitIst, Produkt, Fahrtnummer, Betriebstag, Prognose, HaltesteigText, … }] }
 *   GET fahrten.json/<Produkt>/<Fahrtnummer>?betriebstag=YYYY-MM-DD
 *                                                       → { Linienname, Richtungstext, Produkt, Fahrtverlauf: [{ Haltestellenname, VGNKennung, Longitude, Latitude, AnkunftszeitSoll/Ist?, AbfahrtszeitSoll/Ist? }] }
 *   (`fahrten.json/vgn/<nr>/<day>` from the docs answers 404 / "Unsupported betriebszweig" — the first segment is the product.)
 *
 * `Produkte` is a comma separated string and is missing on some stops; there is no cancellation flag
 * and no polyline, the route on the map connects the trip's stops.
 */
import { haversineKm, hashColor, type LatLon, type TripRoute, type TripStopover } from "../lib";
import type { Departure, JsonGet, Stop, TransportProvider } from "./types";

export const VGN_BASE = "https://start.vag.de/dm/api/v1";
export const VGN_ID = "vgn";
export const VGN_UNAVAILABLE = "vgn api unavailable";

const STOPS_TIMEOUT_MS = 6_000;
const DEPARTURES_TIMEOUT_MS = 8_000;
const TRIP_TIMEOUT_MS = 8_000;
const NEARBY_RADIUS_M = 1_500;

export type VgnStop = { Haltestellenname?: string; VAGKennung?: string; VGNKennung?: number | string; Longitude?: number; Latitude?: number; Produkte?: string };
export type VgnDeparture = {
  Linienname?: string;
  Richtungstext?: string;
  AbfahrtszeitSoll?: string;
  AbfahrtszeitIst?: string;
  Produkt?: string;
  Fahrtnummer?: number | string;
  Betriebstag?: string;
  Prognose?: boolean;
  HaltesteigText?: string;
  Haltepunkt?: string;
  /** not seen live yet, but cheap to honour if the api ever sends it */
  Ausfall?: boolean;
};
export type VgnTripStop = { Haltestellenname?: string; VGNKennung?: number | string; Longitude?: number; Latitude?: number; AnkunftszeitSoll?: string; AnkunftszeitIst?: string; AbfahrtszeitSoll?: string; AbfahrtszeitIst?: string };
export type VgnTrip = { Linienname?: string; Richtungstext?: string; Produkt?: string; Fahrtnummer?: number | string; Betriebstag?: string; Fahrtverlauf?: VgnTripStop[] };

/** vag product names → the hafas-style products the widget filters on */
const PRODUCTS: Record<string, string> = { bus: "bus", tram: "tram", ubahn: "subway", sbahn: "suburban", rbahn: "regional", zug: "regional", bahn: "regional" };
/** official line colours for the three underground lines; everything else gets the stable hash */
const LINE_COLORS: Record<string, string> = { U1: "#005ca9", U2: "#e30613", U3: "#00a7b5" };

export function vgnProduct(raw: string | undefined | null): string {
  const key = (raw ?? "").replace(/[^a-z]/gi, "").toLowerCase();
  return PRODUCTS[key] ?? (key || "bus");
}

export function vgnProducts(raw: string | undefined | null): string[] {
  const out: string[] = [];
  for (const p of (raw ?? "").split(",")) {
    const v = p.trim();
    if (!v) continue;
    const n = vgnProduct(v);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function vgnLineColor(line: string): string {
  return LINE_COLORS[line.toUpperCase()] ?? hashColor(line);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function mapVgnStop(x: VgnStop): Stop | null {
  const id = x.VGNKennung;
  if ((typeof id !== "number" && typeof id !== "string") || !x.Haltestellenname) return null;
  return { id: `${VGN_ID}:${id}`, name: x.Haltestellenname, lat: num(x.Latitude), lon: num(x.Longitude), products: vgnProducts(x.Produkte) };
}

/** `vgn:<Produkt>:<Fahrtnummer>:<Betriebstag>` — everything `fahrten.json` needs to find the trip again */
export function vgnTripId(d: { Produkt?: string; Fahrtnummer?: number | string; Betriebstag?: string }): string | null {
  if (d.Fahrtnummer == null || !d.Produkt) return null;
  return `${VGN_ID}:${d.Produkt}:${d.Fahrtnummer}:${d.Betriebstag ?? ""}`;
}

export function parseVgnTripId(id: string): { product: string; tripNumber: string; day: string | null } | null {
  const m = /^vgn:([^:]+):([^:]+):?([0-9-]*)$/.exec(id);
  if (!m) return null;
  return { product: m[1]!, tripNumber: m[2]!, day: m[3] || null };
}

export function mapVgnDeparture(d: VgnDeparture): Departure | null {
  const planned = iso(d.AbfahrtszeitSoll) ?? iso(d.AbfahrtszeitIst);
  if (!planned) return null;
  const line = (d.Linienname ?? "?").trim() || "?";
  const realtime = !!d.Prognose && iso(d.AbfahrtszeitIst);
  const when = realtime ? iso(d.AbfahrtszeitIst) : null;
  let delayMin: number | null = null;
  if (when) {
    const ms = new Date(when).getTime() - new Date(planned).getTime();
    delayMin = Number.isFinite(ms) ? Math.round(ms / 60_000) : null;
  }
  return {
    tripId: vgnTripId(d) ?? `${line}-${planned}`,
    line,
    product: vgnProduct(d.Produkt),
    direction: (d.Richtungstext ?? "").trim(),
    when,
    plannedWhen: planned,
    delayMin,
    platform: iso(d.HaltesteigText),
    cancelled: d.Ausfall === true,
    color: vgnLineColor(line),
  };
}

export function mapVgnTrip(t: VgnTrip, fallback: { id: string; line?: string }): TripRoute | null {
  if (!t || typeof t !== "object" || !Array.isArray(t.Fahrtverlauf)) return null;
  const line = (t.Linienname ?? fallback.line ?? "?").trim() || "?";
  const stopovers: TripStopover[] = t.Fahrtverlauf.filter((s) => s.Haltestellenname).map((s) => ({
    id: s.VGNKennung != null ? `${VGN_ID}:${s.VGNKennung}` : null,
    name: s.Haltestellenname!,
    lat: num(s.Latitude),
    lon: num(s.Longitude),
    arrival: iso(s.AnkunftszeitIst) ?? iso(s.AnkunftszeitSoll),
    departure: iso(s.AbfahrtszeitIst) ?? iso(s.AbfahrtszeitSoll),
    cancelled: false,
  }));
  // no polyline from the api: the route is the ordered stop coordinates
  const polyline = stopovers.filter((s) => s.lat != null && s.lon != null).map((s) => [s.lat!, s.lon!] as LatLon);
  return {
    id: vgnTripId(t) ?? fallback.id,
    line,
    product: t.Produkt ? vgnProduct(t.Produkt) : null,
    direction: iso(t.Richtungstext),
    color: vgnLineColor(line),
    polyline,
    stopovers,
  };
}

/**
 * substring hits come back in the api's own order; rank them: exact name, the query as a whole word at the
 * start ("Stein Schloss"), as a whole word anywhere ("Nürnberg-Stein", "Kirche (Stein (b Nürnberg))"), then
 * as the start of a longer word ("Steinacher Str.", "Nürnberg-Steinbühl"), then inside a word ("Ziegelstein")
 */
export function rankStops(stops: Stop[], query: string): Stop[] {
  const q = query.trim().toLowerCase();
  if (!q) return stops;
  const boundary = (ch: string) => ch === "" || /[^\p{L}\p{N}]/u.test(ch);
  const score = (s: Stop) => {
    const n = s.name.toLowerCase();
    if (n === q) return 0;
    const at = n.indexOf(q);
    if (at < 0) return 5;
    const wordStart = at === 0 || boundary(n.charAt(at - 1));
    const wordEnd = boundary(n.charAt(at + q.length));
    if (wordStart && wordEnd) return at === 0 ? 1 : 2;
    if (wordStart) return 3;
    return 4;
  };
  return stops.map((s, i) => ({ s, i, r: score(s) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.s);
}

export function createVgnProvider(get: JsonGet): TransportProvider {
  return {
    id: VGN_ID,
    family: "vgn",
    name: "Nürnberg – VGN (VAG Abfahrtsmonitor)",
    country: "de",

    async searchStops(query, near) {
      let raw: { Haltestellen?: VgnStop[] };
      if (query.length >= 2) raw = await get(`${VGN_BASE}/haltestellen.json/vgn?name=${encodeURIComponent(query)}`, 10 * 60_000, STOPS_TIMEOUT_MS);
      else if (near) raw = await get(`${VGN_BASE}/haltestellen.json/vgn/location?lon=${near[1]}&lat=${near[0]}&radius=${NEARBY_RADIUS_M}`, 5 * 60_000, STOPS_TIMEOUT_MS);
      else return [];
      let stops = (Array.isArray(raw?.Haltestellen) ? raw.Haltestellen : []).map(mapVgnStop).filter((s): s is Stop => !!s);
      if (near) {
        for (const s of stops) if (s.lat != null && s.lon != null) s.distanceKm = Math.round(haversineKm(near, [s.lat, s.lon]) * 100) / 100;
        stops = stops.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
      } else {
        stops = rankStops(stops, query);
      }
      return stops.slice(0, near ? 8 : 10);
    },

    async departures(localId, durationMin, ttlMs) {
      const raw = await get<{ Abfahrten?: VgnDeparture[] }>(`${VGN_BASE}/abfahrten.json/vgn/${encodeURIComponent(localId)}?timespan=${durationMin}&limitcount=40`, ttlMs, DEPARTURES_TIMEOUT_MS);
      const list = Array.isArray(raw?.Abfahrten) ? raw.Abfahrten : [];
      return list
        .map(mapVgnDeparture)
        .filter((d): d is Departure => !!d)
        .sort((a, b) => new Date(a.when ?? a.plannedWhen).getTime() - new Date(b.when ?? b.plannedWhen).getTime());
    },

    async trip(tripId, hint) {
      const ref = parseVgnTripId(tripId);
      if (!ref) return null;
      const qs = ref.day ? `?betriebstag=${encodeURIComponent(ref.day)}` : "";
      const raw = await get<VgnTrip>(`${VGN_BASE}/fahrten.json/${encodeURIComponent(ref.product)}/${encodeURIComponent(ref.tripNumber)}${qs}`, 5 * 60_000, TRIP_TIMEOUT_MS);
      return mapVgnTrip(raw, { id: tripId, line: hint.line });
    },
  };
}
