import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq, lt, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { nanoid } from "nanoid";
import { config } from "./config";
import { getDb, now, schema } from "./db";

export const SESSION_COOKIE = "orbis_session";

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const tokenId = (token: string) => createHash("sha256").update(token).digest("hex");

/** Hash to verify against when the account does not exist, so unknown names cost the same scrypt as wrong passwords. */
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));
export function burnPasswordCheck(password: string) {
  verifyPassword(password, DUMMY_HASH);
}

export function hasUsers() {
  return getDb().select({ id: schema.users.id }).from(schema.users).limit(1).all().length > 0;
}

export function createUser(name: string, password: string, role = "owner") {
  const user = { id: nanoid(12), name, passwordHash: hashPassword(password), role, createdAt: now() };
  getDb().insert(schema.users).values(user).run();
  return user;
}

/** Case-insensitive: names are unique ignoring case (see services/users nameTaken). */
export function findUserByName(name: string) {
  return getDb().select().from(schema.users).where(eq(sql`lower(${schema.users.name})`, name.toLowerCase())).get() ?? null;
}

export function createSession(userId: string, userAgent?: string | null, label?: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  getDb()
    .insert(schema.sessions)
    .values({ id: tokenId(token), userId, createdAt: now(), expiresAt: expires.toISOString(), userAgent: userAgent ?? null, label: label ?? null })
    .run();
  return { token, expiresAt: expires };
}

export function revokeSession(token: string) {
  getDb().delete(schema.sessions).where(eq(schema.sessions.id, tokenId(token))).run();
}

export function purgeExpiredSessions() {
  getDb().delete(schema.sessions).where(lt(schema.sessions.expiresAt, now())).run();
}

export type AuthUser = { id: string; name: string; role: string };
export const isAdminRole = (role: string) => role === "owner" || role === "admin";

export function resolveToken(token: string): AuthUser | null {
  const db = getDb();
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, tokenId(token))).get();
  if (!session) return null;
  if (session.expiresAt < now()) {
    db.delete(schema.sessions).where(eq(schema.sessions.id, session.id)).run();
    return null;
  }
  const user = db.select().from(schema.users).where(eq(schema.users.id, session.userId)).get();
  if (!user || user.disabled) return null;
  return { id: user.id, name: user.name, role: user.role };
}

/**
 * Session token from the request: `authorization: Bearer`, then the cookie.
 * `?token=` is only honoured where the caller passes `allowQuery` – websocket upgrades and e-ink devices,
 * which cannot set headers. Everywhere else the query string is ignored (it ends up in logs and history).
 */
export function tokenFromRequest(c: Context, opts: { allowQuery?: boolean } = {}): string | null {
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return cookie;
  if (opts.allowQuery) return c.req.query("token") ?? null;
  return null;
}

/** true when the client reached us over https, directly or through a tls-terminating proxy */
export function requestIsHttps(c: Context) {
  const fwd = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (fwd) return fwd === "https";
  return new URL(c.req.url).protocol === "https:";
}

/** best-effort client ip for rate limiting; x-forwarded-for is trusted only when the hop is a local proxy */
export function clientIp(c: Context, remote?: string | null): string {
  const addr = remote ?? "";
  const local = !addr || addr === "::1" || addr === "127.0.0.1" || addr.startsWith("::ffff:127.") || /^(10.|192.168.|172.(1[6-9]|2d|3[01]).)/.test(addr.replace(/^::ffff:/, ""));
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return local && fwd ? fwd : addr || "unknown";
}

export function setSessionCookie(c: Context, token: string, expires: Date, opts: { remember?: boolean } = {}) {
  const secure = requestIsHttps(c);
  // remember=false → browser-session cookie; the token itself still expires with the session row
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", ...(opts.remember === false ? {} : { expires }), secure });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

type AuthEnv = { Variables: { user: AuthUser } };

/** Requires a valid session; sets c.var.user. */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const token = tokenFromRequest(c);
  const user = token ? resolveToken(token) : null;
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
};

/** Requires at least the given role. owner > admin > member. Must run after requireAuth. */
export function requireRole(min: "admin" | "owner"): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const role = c.var.user?.role;
    const ok = min === "owner" ? role === "owner" : isAdminRole(role ?? "");
    if (!ok) return c.json({ error: "forbidden: " + min + " role required" }, 403);
    await next();
  };
}
