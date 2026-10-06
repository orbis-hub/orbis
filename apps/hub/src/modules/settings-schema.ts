/**
 * Tiny json-schema subset validator for module `settingsSchema` (module.json).
 *
 * Supported keywords: type (string | number | integer | boolean | array | object | null, or a list),
 * enum, minimum / maximum, minLength / maxLength, pattern, items (type / nested), properties, required,
 * additionalProperties (unknown keys are rejected unless it is `true`).
 * Everything the form renderer only uses for display (title, description, default, format, order, …) is ignored.
 */

export type SettingsSchema = {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: SettingsSchema;
  properties?: Record<string, SettingsSchema>;
  required?: string[];
  additionalProperties?: boolean | SettingsSchema;
  [key: string]: unknown;
};

export type SchemaIssue = { path: string; message: string };

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "string":
    case "boolean":
      return typeof v === t;
    case "array":
      return Array.isArray(v);
    case "object":
      return typeOf(v) === "object";
    case "null":
      return v === null;
    default:
      return true; // unknown type keyword: do not block the module
  }
}

const pathStr = (p: string[]) => (p.length ? p.join(".") : "$");

/** Validates `value` against `schema`; returns a (possibly empty) list of issues. */
export function validateSchema(schema: SettingsSchema | undefined, value: unknown, path: string[] = []): SchemaIssue[] {
  if (!schema || typeof schema !== "object") return [];
  const issues: SchemaIssue[] = [];
  const at = pathStr(path);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      issues.push({ path: at, message: `expected ${types.join(" | ")}, got ${typeOf(value)}` });
      return issues; // the rest of the keywords assume the right type
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value || (typeof e === "object" && JSON.stringify(e) === JSON.stringify(value)))) {
    issues.push({ path: at, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) issues.push({ path: at, message: `must be >= ${schema.minimum}` });
    if (typeof schema.maximum === "number" && value > schema.maximum) issues.push({ path: at, message: `must be <= ${schema.maximum}` });
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push({ path: at, message: `must be at least ${schema.minLength} characters` });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) issues.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) issues.push({ path: at, message: `must match ${schema.pattern}` });
      } catch {
        /* a broken pattern in module.json must not lock the settings */
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => issues.push(...validateSchema(schema.items, item, [...path, String(i)])));
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) issues.push({ path: pathStr([...path, key]), message: "is required" });
    }
    for (const [key, v] of Object.entries(obj)) {
      if (key in props) issues.push(...validateSchema(props[key], v, [...path, key]));
      else if (schema.additionalProperties === true) continue;
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") issues.push(...validateSchema(schema.additionalProperties, v, [...path, key]));
      else if (schema.properties) issues.push({ path: pathStr([...path, key]), message: "unknown key" });
      // a schema without `properties` (e.g. `{ type: "object" }`) accepts anything
    }
  }
  return issues;
}

export function formatIssues(issues: SchemaIssue[]): string {
  return issues.map((i) => (i.path === "$" ? i.message : `${i.path}: ${i.message}`)).join("; ");
}

/**
 * Merge a settings PATCH into the current settings: `null` removes a key, everything else replaces it.
 * The merged result is validated against the schema (when there is one); throws with a readable message.
 */
export function applySettingsPatch(schema: SettingsSchema | undefined, current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  // keys that were stored before validation existed and are unknown to the schema must not block every later save:
  // they are dropped silently (unknown keys *in the patch* are still rejected below)
  if (schema?.properties && schema.additionalProperties !== true) {
    for (const k of Object.keys(next)) if (!(k in schema.properties) && !(k in patch)) delete next[k];
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  const issues = validateSchema(schema, next);
  if (issues.length) throw new SettingsValidationError(issues);
  return next;
}

export class SettingsValidationError extends Error {
  status = 400 as const;
  issues: SchemaIssue[];
  constructor(issues: SchemaIssue[]) {
    super(`invalid settings: ${formatIssues(issues)}`);
    this.issues = issues;
  }
}
