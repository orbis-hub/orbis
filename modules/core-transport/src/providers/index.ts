/**
 * Provider registry and stop / trip id routing.
 *
 * Stop ids carry their provider family so one dashboard can mix providers:
 *   `vgn:1990`            → vgn, VGNKennung 1990
 *   `hafas:8000260`       → hafas, resolved with the configured hafas profile (db when the setting is vgn)
 *   `vbb:900000100003`    → hafas profile named explicitly
 *   `8000260`             → bare id from an old config: hafas, like `hafas:8000260`
 */
import { HAFAS_ID_PREFIX, HAFAS_PROFILES, HAFAS_RATE_LIMIT, HAFAS_UNAVAILABLE, createHafasProvider } from "./hafas";
import type { JsonGet, ProviderFamily, TransportProvider } from "./types";
import { VGN_BASE, VGN_ID, VGN_UNAVAILABLE, createVgnProvider } from "./vgn";

export type ProviderId = keyof typeof HAFAS_PROFILES | typeof VGN_ID;

export type ProviderInfo = { id: string; family: ProviderFamily; name: string; country: string };

/** everything a user can pick under module settings, in menu order */
export const PROVIDER_INFOS: ProviderInfo[] = [
  ...Object.entries(HAFAS_PROFILES).map(([id, p]) => ({ id, family: "hafas" as const, name: p.name, country: p.country })),
  { id: VGN_ID, family: "vgn", name: "Nürnberg – VGN (VAG Abfahrtsmonitor)", country: "de" },
];

export const isHafasProfile = (id: string | undefined | null): id is keyof typeof HAFAS_PROFILES => !!id && Object.prototype.hasOwnProperty.call(HAFAS_PROFILES, id);
export const isProviderId = (id: string | undefined | null): id is ProviderId => id === VGN_ID || isHafasProfile(id);

export type Backend = {
  /** cache / back-off key, one per upstream host */
  key: string;
  /** error strings the client translates ("transport api unavailable", "vgn api unavailable") */
  unavailable: string;
  rateLimit: string;
};

export function backendFor(providerId: string): Backend {
  if (providerId === VGN_ID) return { key: VGN_BASE, unavailable: VGN_UNAVAILABLE, rateLimit: VGN_UNAVAILABLE };
  const p = HAFAS_PROFILES[providerId] ?? HAFAS_PROFILES.db!;
  return { key: p.base, unavailable: HAFAS_UNAVAILABLE, rateLimit: HAFAS_RATE_LIMIT };
}

export type StopRef = { providerId: ProviderId; localId: string };

/**
 * Split a stored stop id into provider + local id. `defaultProvider` is the module setting; a `hafas:` or
 * bare id uses it when it is a hafas profile, otherwise db (an old db dashboard keeps working after switching to vgn).
 */
export function parseStopId(raw: string, defaultProvider: string | undefined): StopRef | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const hafasDefault: ProviderId = isHafasProfile(defaultProvider) ? defaultProvider : "db";
  const at = s.indexOf(":");
  if (at <= 0) return { providerId: hafasDefault, localId: s };
  const prefix = s.slice(0, at);
  const rest = s.slice(at + 1);
  if (!rest) return null;
  if (prefix === VGN_ID) return { providerId: VGN_ID, localId: rest };
  if (prefix === HAFAS_ID_PREFIX) return { providerId: hafasDefault, localId: rest };
  if (isHafasProfile(prefix)) return { providerId: prefix, localId: rest };
  // unknown prefix: hafas ids can legally contain ":" in some profiles, keep the whole thing
  return { providerId: hafasDefault, localId: s };
}

/** trip ids are opaque per family: `vgn:…` is ours, anything else is a raw hafas id */
export function providerForTrip(tripId: string, defaultProvider: string | undefined): ProviderId {
  if (tripId.startsWith(`${VGN_ID}:`)) return VGN_ID;
  return isHafasProfile(defaultProvider) ? defaultProvider : "db";
}

export function createProvider(id: ProviderId, get: JsonGet): TransportProvider {
  return id === VGN_ID ? createVgnProvider(get) : createHafasProvider(id, get);
}

export type { Departure, JsonGet, Stop, TransportProvider } from "./types";
export { ApiUnavailable } from "./types";
