import { eq } from "drizzle-orm";
import { getDb, now, schema } from "../db";
import { broadcast } from "../ws";

export type HubSettings = {
  hubName: string;
  /** ui language (bcp-47, e.g. "en", "de"); separate from `locale`, which only drives date/number formatting */
  language: string;
  locale: string;
  timezone: string;
  theme: "system" | "light" | "dark";
  registries: string[];
  /** Latitude/longitude used as default by location-aware modules. */
  location: { lat: number; lon: number; name: string } | null;
  units: "metric" | "imperial";
  /** module ids whose notifications are dropped */
  mutedModules: string[];
  notifyChannels: {
    ntfy?: { server?: string; topic: string; token?: string; minLevel?: "info" | "warning" | "urgent" };
    telegram?: { botToken: string; chatId: string; minLevel?: "info" | "warning" | "urgent" };
  };
};

export const defaultSettings: HubSettings = {
  hubName: "Orbis",
  language: "en",
  locale: "de-DE",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Europe/Berlin",
  theme: "system",
  registries: [],
  location: null,
  units: "metric",
  mutedModules: [],
  notifyChannels: {},
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

/** keys every signed-in user may read; the rest (registries, notification channels with their tokens, muted modules) is admin-only */
export const MEMBER_SETTINGS_KEYS = ["hubName", "language", "locale", "timezone", "units", "location", "theme"] as const satisfies readonly (keyof HubSettings)[];
export type MemberSettings = Pick<HubSettings, (typeof MEMBER_SETTINGS_KEYS)[number]> & { registries: [] };

/** the member view of the settings: safe keys only. `registries: []` keeps the client shape (the settings page joins it) without disclosing the list. */
export function getMemberSettings(): MemberSettings {
  const all = getAllSettings();
  const out = {} as Record<string, unknown>;
  for (const k of MEMBER_SETTINGS_KEYS) out[k] = all[k];
  out.registries = [];
  return out as MemberSettings;
}

/** full settings for admins, the safe subset for everyone else */
export function getSettingsFor(role: string): HubSettings | MemberSettings {
  return role === "owner" || role === "admin" ? getAllSettings() : getMemberSettings();
}

const listeners = new Set<(key: keyof HubSettings, value: unknown) => void>();

/** in-process hook for hub code that wants to react to a setting (module contexts use it for the language) */
export function onSettingChange(cb: (key: keyof HubSettings, value: unknown) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let languageCache: string | null = null;
/** current ui language, cached (read on every translation call) */
export function getLanguage(): string {
  if (languageCache === null) languageCache = getSetting("language") || defaultSettings.language;
  return languageCache;
}

export function setSetting<K extends keyof HubSettings>(key: K, value: HubSettings[K]) {
  if (key === "language") languageCache = (value as string) || defaultSettings.language;
  getDb()
    .insert(schema.settings)
    .values({ key, value: JSON.stringify(value), updatedAt: now() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value), updatedAt: now() } })
    .run();
  broadcast({ type: "settings:changed", key });
  for (const cb of listeners) {
    try {
      cb(key, value);
    } catch {
      /* listener errors must not break the request */
    }
  }
}

export function patchSettings(patch: Partial<HubSettings>) {
  for (const [k, v] of Object.entries(patch)) {
    if (k in defaultSettings) setSetting(k as keyof HubSettings, v as never);
  }
  return getAllSettings();
}
