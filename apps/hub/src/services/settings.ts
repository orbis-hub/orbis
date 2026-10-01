import { eq } from "drizzle-orm";
import { getDb, now, schema } from "../db";
import { broadcast } from "../ws";

export type HubSettings = {
  hubName: string;
  locale: string;
  timezone: string;
  theme: "system" | "light" | "dark";
  registries: string[];
  /** Latitude/longitude used as default by location-aware modules. */
  location: { lat: number; lon: number; name: string } | null;
  units: "metric" | "imperial";
};

export const defaultSettings: HubSettings = {
  hubName: "Orbis",
  locale: "de-DE",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Europe/Berlin",
  theme: "system",
  registries: [],
  location: null,
  units: "metric",
};

export function getSetting<K extends keyof HubSettings>(key: K): HubSettings[K] {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (!row) return defaultSettings[key];
  try {
    return JSON.parse(row.value) as HubSettings[K];
  } catch {
    return defaultSettings[key];
  }
}

export function getAllSettings(): HubSettings {
  const rows = getDb().select().from(schema.settings).all();
  const out: Record<string, unknown> = { ...defaultSettings };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore */
    }
  }
  return out as HubSettings;
}

export function setSetting<K extends keyof HubSettings>(key: K, value: HubSettings[K]) {
  getDb()
    .insert(schema.settings)
    .values({ key, value: JSON.stringify(value), updatedAt: now() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value), updatedAt: now() } })
    .run();
  broadcast({ type: "settings:changed", key });
}

export function patchSettings(patch: Partial<HubSettings>) {
  for (const [k, v] of Object.entries(patch)) {
    if (k in defaultSettings) setSetting(k as keyof HubSettings, v as never);
  }
  return getAllSettings();
}
