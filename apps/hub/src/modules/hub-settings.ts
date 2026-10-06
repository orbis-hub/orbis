/**
 * The subset of hub settings a module may read through `ctx.hub.settings()` (manifest permission `settings:read`).
 * No secrets: notification channels, registries and the like stay hub-internal.
 */
import type { PublicHubSettings } from "@orbis/sdk/server";
import { getAllSettings } from "../services/settings";

export function publicHubSettings(): PublicHubSettings {
  const s = getAllSettings();
  return {
    hubName: s.hubName,
    language: s.language,
    locale: s.locale,
    timezone: s.timezone,
    units: s.units === "imperial" ? "imperial" : "metric",
    location: s.location && Number.isFinite(s.location.lat) && Number.isFinite(s.location.lon) ? { lat: s.location.lat, lon: s.location.lon, name: String(s.location.name ?? "") } : null,
  };
}
