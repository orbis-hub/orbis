/**
 * Provider interface for departure boards. Every provider maps its own api onto the same three
 * calls and the same `Stop` / `Departure` / `TripRoute` shapes, so the widget, page and e-ink
 * renderer do not care where the data comes from.
 *
 * Pure (no sdk / node imports) so the mappers can be unit-tested with captured json.
 */
import type { LatLon, Place, TripRoute } from "../lib";

export type Departure = {
  /** opaque id for `/trip?id=` — `vgn:<Produkt>:<Fahrtnummer>:<Betriebstag>` for vgn, the raw hafas trip id otherwise */
  tripId: string;
  line: string;
  /** normalised: bus, tram, subway, suburban, regional, national, nationalExpress, ferry, taxi */
  product: string;
  direction: string;
  /** realtime time when known (planned + delay) */
  when: string | null;
  plannedWhen: string;
  delayMin: number | null;
  platform: string | null;
  cancelled: boolean;
  /** css colour for the line (api colour when present, else a stable hash) */
  color: string;
};

export type Stop = {
  /** always prefixed with the provider family: `hafas:<id>` or `vgn:<VGNKennung>` */
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

export type ProviderFamily = "hafas" | "vgn";

/** thrown by the http client while a backend is in its back-off window (or just failed) */
export class ApiUnavailable extends Error {
  constructor(
    message: string,
    public readonly retryAt: number,
  ) {
    super(message);
    this.name = "ApiUnavailable";
  }
}

/**
 * Cached, deduplicated json GET bound to one backend (base url): the server's http client decides
 * the back-off per backend, the provider only says how long a response stays fresh and how long to wait.
 */
export type JsonGet = <T>(url: string, ttlMs: number, timeoutMs: number) => Promise<T>;

export type TransportProvider = {
  /** settings value: db, vbb, bvg, oebb, vgn */
  id: string;
  family: ProviderFamily;
  name: string;
  /** iso 3166-1 alpha-2, lowercase — the picker hides this country in place labels */
  country: string;
  /** name search (≥ 2 chars) and / or stops around a point; ids come back prefixed */
  searchStops(query: string, near: LatLon | null): Promise<Stop[]>;
  /** `localId` is the id without the family prefix */
  departures(localId: string, durationMin: number, ttlMs: number): Promise<Departure[]>;
  /** `tripId` as it came out of `Departure.tripId`; null when the backend does not know it */
  trip(tripId: string, hint: { line?: string }): Promise<TripRoute | null>;
};
