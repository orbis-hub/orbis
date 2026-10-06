/**
 * Secret module settings (#38). A property in `settingsSchema.properties` with `"format": "secret"` (or the older
 * `"password"`) holds a credential: api secrets, tokens, passwords. Admins read and write them; everyone else gets
 * the settings without those keys, so widgets keep their non-secret config (units, ids, urls) and nothing leaks.
 */

type SchemaLike = { settingsSchema?: unknown } | null | undefined;

const SECRET_FORMATS = new Set(["secret", "password"]);

/** keys of the top-level properties that hold secrets */
export function secretSettingKeys(manifest: SchemaLike): string[] {
  const schema = manifest?.settingsSchema as { properties?: Record<string, { format?: unknown }> } | undefined;
  const props = schema?.properties;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props)
    .filter(([, p]) => p && typeof p === "object" && typeof p.format === "string" && SECRET_FORMATS.has(p.format))
    .map(([k]) => k);
}

/** the settings without their secret keys (a shallow copy; the original is untouched) */
export function stripSecretSettings(manifest: SchemaLike, settings: Record<string, unknown>): Record<string, unknown> {
  const secret = secretSettingKeys(manifest);
  if (!secret.length) return { ...settings };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) if (!secret.includes(k)) out[k] = v;
  return out;
}

/** what a user with `role` may see of a module's settings */
export function settingsForRole(manifest: SchemaLike, settings: Record<string, unknown>, role: string): Record<string, unknown> {
  return role === "owner" || role === "admin" ? settings : stripSecretSettings(manifest, settings);
}
