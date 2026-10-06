/**
 * Jumomind / MyMüll – the app backend many german municipalities use. Public, no key.
 *   GET https://mymuell.jumomind.com/mmapp/api.php?r=cities
 *       → [{ id, name, _name, region_code, area_id, has_streets, img }]
 *   GET ?r=streets&city_id=<id>            → [{ id, name, _name, area_id, street_comment }]
 *   GET ?r=trash&city_id=<id>&area_id=<a>  → [{ title, name, _name, color }]
 *   GET ?r=dates&city_id=<id>&area_id=<a>  → [{ id, title, trash_name, day: "YYYY-MM-DD", description, color }]
 * `area_id` is the city's `area_id` when it has no streets, else the chosen street's `area_id` (not its `id`).
 * (The hostname is .com – the .de name does not resolve.)
 */
import { mapTrashName, normalize, normalizeLoose, providerColor } from "../bins";
import { isIso } from "../dates";
import type { Fetch, ProviderBin, ProviderCity, ProviderLocation, ProviderPickup, ProviderStreet, ScheduleProvider } from "./index";

export const JUMOMIND_BASE = "https://mymuell.jumomind.com/mmapp/api.php";

export type JumomindCityRow = { id: string; name: string; _name?: string; region_code?: string; area_id?: string; has_streets?: boolean };
export type JumomindStreetRow = { id: string; name: string; _name?: string; area_id?: string; street_comment?: string };
export type JumomindTrashRow = { title: string; name: string; _name?: string; color?: string };
export type JumomindDateRow = { id?: string; title?: string; trash_name?: string; day?: string; date?: string; description?: string; color?: string };

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export function mapCities(rows: unknown): ProviderCity[] {
  if (!Array.isArray(rows)) return [];
  return (rows as JumomindCityRow[])
    .filter((r) => r && str(r.id) && str(r.name))
    .map((r) => ({ id: str(r.id), name: str(r.name), hasStreets: !!r.has_streets, areaId: r.has_streets ? null : str(r.area_id) || str(r.id) }));
}

export function mapStreets(rows: unknown): ProviderStreet[] {
  if (!Array.isArray(rows)) return [];
  return (rows as JumomindStreetRow[]).filter((r) => r && str(r.id) && str(r.name)).map((r) => ({ id: str(r.id), name: str(r.name), areaId: str(r.area_id) || str(r.id) }));
}

export function mapTrash(rows: unknown): ProviderBin[] {
  if (!Array.isArray(rows)) return [];
  const out: ProviderBin[] = [];
  for (const r of rows as JumomindTrashRow[]) {
    const key = str(r?.name) || str(r?._name);
    if (!key) continue;
    const title = str(r.title) || key;
    out.push({ key, title, color: providerColor(r.color), type: mapTrashName(title, key) });
  }
  return out;
}

export function mapDates(rows: unknown): ProviderPickup[] {
  if (!Array.isArray(rows)) return [];
  const out: ProviderPickup[] = [];
  for (const r of rows as JumomindDateRow[]) {
    const date = str(r?.day) || str(r?.date);
    const key = str(r?.trash_name);
    if (!isIso(date) || !key) continue;
    out.push({ date, key, title: str(r.title) || key, color: providerColor(r.color) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/** 0 = exact, 1 = prefix, 2 = word prefix, 3 = substring, -1 = no match */
export function matchScore(query: string, candidate: string): number {
  const q1 = normalize(query), q2 = normalizeLoose(query);
  if (!q1) return -1;
  const c1 = normalize(candidate), c2 = normalizeLoose(candidate);
  for (const [q, c] of [[q1, c1], [q2, c2]] as const) {
    if (c === q) return 0;
    if (c.startsWith(q)) return 1;
    if (c.split(" ").some((w) => w.startsWith(q))) return 2;
    if (c.includes(q)) return 3;
  }
  return -1;
}

/** "Adelungstraße 1-41, 2-38" / "Adelungstraße 40-Ende, 43-Ende" → does house number `n` fall into a listed range? null = no ranges */
export function houseNumberMatches(streetName: string, houseNumber: string): boolean | null {
  const n = parseInt(houseNumber, 10);
  if (!Number.isFinite(n)) return null;
  const ranges = [...streetName.matchAll(/(\d+)\s*-\s*(\d+|ende)/gi)];
  if (!ranges.length) return null;
  for (const m of ranges) {
    const a = Number(m[1]);
    const b = /ende/i.test(m[2]!) ? Infinity : Number(m[2]);
    if (n >= a && n <= b) return true;
  }
  return false;
}

const CACHE_MS = 24 * 60 * 60_000;
let citiesCache: { at: number; list: ProviderCity[] } | null = null;
const streetsCache = new Map<string, { at: number; list: ProviderStreet[] }>();
let lastCall = 0;

async function call(fetch: Fetch, params: Record<string, string>): Promise<unknown> {
  // be polite: at most ~2 requests per second
  const wait = lastCall + 500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const u = new URL(JUMOMIND_BASE);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u.toString(), { headers: { accept: "application/json", "user-agent": "orbis-hub (+https://github.com/orbis-hub/orbis)" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`jumomind HTTP ${res.status}`);
  return res.json();
}

async function allCities(fetch: Fetch): Promise<ProviderCity[]> {
  if (citiesCache && Date.now() - citiesCache.at < CACHE_MS) return citiesCache.list;
  const list = mapCities(await call(fetch, { r: "cities" }));
  if (list.length) citiesCache = { at: Date.now(), list };
  return list;
}

async function allStreets(cityId: string, fetch: Fetch): Promise<ProviderStreet[]> {
  const hit = streetsCache.get(cityId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const list = mapStreets(await call(fetch, { r: "streets", city_id: cityId }));
  if (list.length) streetsCache.set(cityId, { at: Date.now(), list });
  return list;
}

export function rankCities(list: ProviderCity[], query: string, limit = 15): ProviderCity[] {
  return list
    .map((c) => ({ c, s: matchScore(query, c.name) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c);
}

export function rankStreets(list: ProviderStreet[], query: string, houseNumber?: string, limit = 25): ProviderStreet[] {
  return list
    .map((st) => {
      const s = query.trim() ? matchScore(query, st.name.replace(/\s*\d.*$/, "")) : 3;
      const hn = houseNumber ? houseNumberMatches(st.name, houseNumber) : null;
      return { st, s, hn: hn === true ? 0 : hn === null ? 1 : 2 };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.hn - b.hn || a.st.name.localeCompare(b.st.name))
    .slice(0, limit)
    .map((x) => x.st);
}

export const jumomind: ScheduleProvider = {
  id: "jumomind",
  name: "MyMüll (Jumomind)",
  async searchCities(query, fetch) {
    return rankCities(await allCities(fetch), query);
  },
  async searchStreets(cityId, query, fetch, houseNumber) {
    return rankStreets(await allStreets(cityId, fetch), query, houseNumber);
  },
  async bins(loc: ProviderLocation, fetch) {
    return mapTrash(await call(fetch, { r: "trash", city_id: loc.cityId, area_id: loc.areaId }));
  },
  async pickups(loc: ProviderLocation, fetch) {
    return mapDates(await call(fetch, { r: "dates", city_id: loc.cityId, area_id: loc.areaId }));
  },
};
