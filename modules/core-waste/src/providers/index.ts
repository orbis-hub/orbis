/**
 * Schedule providers: municipal apis that turn an address into a pickup calendar.
 * Add a provider by implementing `ScheduleProvider` and registering it in `PROVIDERS` (see README.md).
 */
import type { BinType } from "../types";

export type Fetch = typeof fetch;

export type ProviderCity = { id: string; name: string; hasStreets: boolean; areaId: string | null };
export type ProviderStreet = { id: string; name: string; areaId: string };
export type ProviderBin = { key: string; title: string; color: string | null; type: BinType };
export type ProviderPickup = { date: string; key: string; title: string; color: string | null };

/** what we persist in the source config to fetch dates again later */
export type ProviderLocation = { provider: string; cityId: string; cityName: string; areaId: string; streetId?: string; streetName?: string };

export type ScheduleProvider = {
  id: string;
  name: string;
  /** fuzzy, umlaut-insensitive city search */
  searchCities(query: string, fetch: Fetch): Promise<ProviderCity[]>;
  /** streets of a city (only when `hasStreets`); `houseNumber` ranks streets whose range includes it first */
  searchStreets(cityId: string, query: string, fetch: Fetch, houseNumber?: string): Promise<ProviderStreet[]>;
  bins(loc: ProviderLocation, fetch: Fetch): Promise<ProviderBin[]>;
  pickups(loc: ProviderLocation, fetch: Fetch): Promise<ProviderPickup[]>;
};

import { jumomind } from "./jumomind";

export const PROVIDERS: Record<string, ScheduleProvider> = { [jumomind.id]: jumomind };

export function getProvider(id: string): ScheduleProvider | null {
  return PROVIDERS[id] ?? null;
}
