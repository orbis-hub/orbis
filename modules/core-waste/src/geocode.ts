/** Reverse geocoding via Nominatim (OSM). Usage policy: identify yourself, max 1 request per second. */
import type { Fetch } from "./providers/index";
import type { GeoResult } from "./types";

export const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";

type NominatimAddress = Record<string, string | undefined>;
export type NominatimResponse = { display_name?: string; address?: NominatimAddress; error?: string };

export function mapNominatim(json: NominatimResponse | null | undefined): GeoResult {
  if (!json || json.error || !json.address) return null;
  const a = json.address;
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.city_district ?? a.county ?? "";
  const street = a.road ?? a.pedestrian ?? a.footway ?? a.residential ?? "";
  if (!city && !street) return null;
  return { city, street, houseNumber: a.house_number ?? "", postcode: a.postcode ?? "", display: json.display_name ?? [street, a.house_number, a.postcode, city].filter(Boolean).join(" ") };
}

let lastCall = 0;
let chain: Promise<unknown> = Promise.resolve();

/** serialised + throttled: never more than one request per second against nominatim */
export function reverseGeocode(lat: number, lon: number, opts: { fetch: Fetch; language: string; hubVersion: string }): Promise<GeoResult> {
  const run = async (): Promise<GeoResult> => {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const u = new URL(NOMINATIM_REVERSE);
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("lat", String(lat));
    u.searchParams.set("lon", String(lon));
    u.searchParams.set("zoom", "18");
    u.searchParams.set("accept-language", opts.language || "en");
    const res = await opts.fetch(u.toString(), { headers: { accept: "application/json", "user-agent": `orbis-hub/${opts.hubVersion} (+https://github.com/orbis-hub/orbis)` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`nominatim HTTP ${res.status}`);
    return mapNominatim((await res.json()) as NominatimResponse);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}
