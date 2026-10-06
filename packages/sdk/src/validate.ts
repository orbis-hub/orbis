/**
 * Request validation for module http handlers, built on zod.
 *
 *   import { parseBody, nonEmptyString, idParam, z } from "@orbis/sdk/server";
 *
 *   http.post("/items", async (c) => {
 *     const b = await parseBody(c, z.object({ name: nonEmptyString(200), listId: idParam.optional() }));
 *     if (!b.ok) return b.res;              // 400 { error: "invalid input", issues } or { error: "invalid json" }
 *     ...b.data is typed and trimmed
 *   });
 *
 * Modules do not depend on zod themselves: `z` is re-exported here so one copy ends up in the bundle.
 */
import type { Context } from "hono";
import { z } from "zod";

export { z };

/** Hono request context of a module http handler, for helpers shared between routes (modules don't depend on hono directly). */
export type HttpContext = Context;

export type ValidationIssue = { path: string; message: string };
export type ParseResult<T> = { ok: true; data: T } | { ok: false; res: Response };

/** `{ error: "invalid input", issues: [{ path: "name", message: "…" }] }` */
export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

/** 400 response for a failed parse; exported so handlers can reuse it for checks zod can't express. */
export function invalid(c: Context, issues: ValidationIssue[] | string): Response {
  return c.json({ error: "invalid input", issues: typeof issues === "string" ? [{ path: "", message: issues }] : issues }, 400);
}

/** `{ error: "not found" }` with status 404 */
export function notFound(c: Context, what = "not found"): Response {
  return c.json({ error: what }, 404);
}

/**
 * Parse the json body against `schema`. Unparseable (or empty) json → 400 `{ error: "invalid json" }`,
 * schema failure → 400 `{ error: "invalid input", issues }`.
 */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "invalid json" }, 400) };
  }
  return parseValue(c, schema, raw);
}

/** Same as `parseBody` for the query string (`?days=30` → `{ days: "30" }`; use `z.coerce` for numbers). */
export function parseQuery<T>(c: Context, schema: z.ZodType<T>): ParseResult<T> {
  return parseValue(c, schema, c.req.query());
}

/** Validate an already-decoded value (path params, settings, …). */
export function parseValue<T>(c: Context, schema: z.ZodType<T>, value: unknown): ParseResult<T> {
  const r = schema.safeParse(value);
  if (!r.success) return { ok: false, res: invalid(c, issuesOf(r.error)) };
  return { ok: true, data: r.data };
}

/* ---------- shared schemas ---------- */

/** opaque ids the modules generate (`uid()`), fixed ids like "inbox", slugs */
export const idParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid id");

/** full ISO-8601 timestamp with zone, e.g. 2026-10-06T08:00:00.000Z */
export const isoDate = z.iso.datetime({ offset: true, message: "expected an ISO timestamp" });

/** calendar day as YYYY-MM-DD (a real date: 2026-02-30 is rejected) */
export const dateKey = z.iso.date({ message: "expected YYYY-MM-DD" });

/** trimmed, at least one character, at most `max` */
export function nonEmptyString(max: number) {
  return z.string().trim().min(1, "must not be empty").max(max, `at most ${max} characters`);
}

/** #rgb or #rrggbb */
export const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "expected a hex colour like #4fc47f");

/** integer in [min, max]; rejects "7" strings and 7.5 so nothing like "7.0" ends up in the database */
export function intRange(min: number, max: number) {
  return z.number().int().min(min).max(max);
}
