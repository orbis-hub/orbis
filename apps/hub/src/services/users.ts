import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth";
import { getDb, now, schema } from "../db";
import { HttpError, badRequest, forbidden, notFound } from "../errors";
import { broadcast } from "../ws";

export type Role = "owner" | "admin" | "member";
export const ROLES: Role[] = ["owner", "admin", "member"];

export type PublicUser = { id: string; name: string; role: Role; disabled: boolean; createdAt: string; sessions: number };

export function isAdmin(role: string) {
  return role === "owner" || role === "admin";
}

/**
 * Account names: 1-64 printable characters after trimming, no control/format characters (no line breaks,
 * zero-width joiners, ...) - they are shown verbatim in a shared ui. Uniqueness ignores case.
 */
export const NAME_RULE = "1-64 printable characters";
export const userName = z
  .string()
  .trim()
  .min(1, NAME_RULE)
  .max(64, NAME_RULE)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, NAME_RULE);

function toPublic(u: typeof schema.users.$inferSelect, sessions = 0): PublicUser {
  return { id: u.id, name: u.name, role: u.role as Role, disabled: u.disabled, createdAt: u.createdAt, sessions };
}

export function listUsers(): PublicUser[] {
  const db = getDb();
  const sessions = db.select({ userId: schema.sessions.userId }).from(schema.sessions).all();
  const count = (id: string) => sessions.filter((s) => s.userId === id).length;
  return db
    .select()
    .from(schema.users)
    .all()
    .sort((a, b) => ROLES.indexOf(a.role as Role) - ROLES.indexOf(b.role as Role) || a.createdAt.localeCompare(b.createdAt))
    .map((u) => toPublic(u, count(u.id)));
}

export function getUser(id: string): PublicUser | null {
  const u = getDb().select().from(schema.users).where(eq(schema.users.id, id)).get();
  return u ? toPublic(u) : null;
}

/** case-insensitive: "Mia" and "mia" are the same account name */
export function nameTaken(name: string, exceptId?: string) {
  const u = getDb()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.name})`, name.trim().toLowerCase()))
    .get();
  return !!u && u.id !== exceptId;
}

function validName(name: string): string {
  const r = userName.safeParse(name);
  if (!r.success) throw badRequest(`invalid name (${NAME_RULE})`);
  return r.data;
}

export function createUserAccount(name: string, password: string, role: Role = "member"): PublicUser {
  if (role === "owner") throw badRequest("there is exactly one owner, created at setup"); // never a second owner
  name = validName(name);
  if (nameTaken(name)) throw new HttpError(409, "name already taken");
  const user = { id: nanoid(12), name, passwordHash: hashPassword(password), role, createdAt: now(), disabled: false };
  getDb().insert(schema.users).values(user).run();
  broadcast({ type: "users:changed" } as never);
  return toPublic(user as typeof schema.users.$inferSelect);
}

type Actor = { id: string; role: string };

/**
 * Who may touch whom: the owner everyone, an admin only members and themselves, a member only themselves.
 * Throws 403 otherwise. Used for every mutation (rename, role, disable, password, logout, delete).
 */
export function assertMayManage(target: { id: string; role: string }, actor: Actor, what: string) {
  if (target.id === actor.id) return;
  if (actor.role === "owner") return;
  if (target.role === "owner") throw forbidden(`only the owner can ${what} the owner`);
  if (target.role === "admin") throw forbidden(`only the owner can ${what} other admins`);
  if (!isAdmin(actor.role)) throw forbidden(`only admins can ${what} other accounts`);
}

export function updateUser(id: string, patch: { name?: string; role?: Role; disabled?: boolean }, actor: Actor) {
  const db = getDb();
  const target = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!target) throw notFound("user not found");
  assertMayManage(target, actor, "change");
  if (target.role === "owner" && patch.role !== undefined && patch.role !== "owner") throw forbidden("the owner's role cannot be changed");
  if (target.role === "owner" && patch.disabled) throw forbidden("the owner cannot be disabled");
  if (patch.role === "owner") throw badRequest("there is exactly one owner");
  if (patch.role === "admin" && target.role !== "admin" && actor.role !== "owner") throw forbidden("only the owner can promote to admin");
  if (target.id === actor.id && patch.role !== undefined && patch.role !== target.role) throw forbidden("you cannot change your own role");
  if (target.id === actor.id && patch.disabled) throw forbidden("you cannot disable yourself");
  const set: Partial<typeof schema.users.$inferInsert> = {};
  if (patch.name !== undefined) {
    const name = validName(patch.name);
    if (nameTaken(name, id)) throw new HttpError(409, "name already taken");
    set.name = name;
  }
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.disabled !== undefined) set.disabled = patch.disabled;
  if (Object.keys(set).length) db.update(schema.users).set(set).where(eq(schema.users.id, id)).run();
  if (patch.disabled) db.delete(schema.sessions).where(eq(schema.sessions.userId, id)).run();
  broadcast({ type: "users:changed" } as never);
  return getUser(id)!;
}

export function setPassword(id: string, password: string, opts: { current?: string; requireCurrent: boolean }) {
  const db = getDb();
  const u = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!u) throw notFound("user not found");
  if (opts.requireCurrent && !(opts.current && verifyPassword(opts.current, u.passwordHash))) throw badRequest("current password is wrong");
  db.update(schema.users).set({ passwordHash: hashPassword(password) }).where(eq(schema.users.id, id)).run();
  // log out everywhere else
  db.delete(schema.sessions).where(eq(schema.sessions.userId, id)).run();
}

export function deleteUser(id: string, actor: Actor) {
  const db = getDb();
  const u = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!u) throw notFound("user not found");
  if (u.role === "owner") throw forbidden("the owner cannot be deleted");
  if (u.id === actor.id) throw badRequest("you cannot delete yourself");
  assertMayManage(u, actor, "delete");
  db.delete(schema.sessions).where(eq(schema.sessions.userId, id)).run();
  db.delete(schema.dashboardAccess).where(eq(schema.dashboardAccess.userId, id)).run();
  // private dashboards of that user go away, shared ones are handed to the owner
  const owner = db.select().from(schema.users).where(eq(schema.users.role, "owner")).get();
  for (const d of db.select().from(schema.dashboards).where(eq(schema.dashboards.ownerId, id)).all()) {
    if (d.shared && owner) db.update(schema.dashboards).set({ ownerId: owner.id }).where(eq(schema.dashboards.id, d.id)).run();
    else {
      db.delete(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.dashboardId, d.id)).run();
      db.delete(schema.dashboardAccess).where(eq(schema.dashboardAccess.dashboardId, d.id)).run();
      db.delete(schema.dashboards).where(eq(schema.dashboards.id, d.id)).run();
    }
  }
  db.delete(schema.users).where(eq(schema.users.id, id)).run();
  broadcast({ type: "users:changed" } as never);
  broadcast({ type: "dashboards:changed" });
}

/** End every session of an account. Same guard as the other mutations: admins cannot log out the owner or other admins. */
export function revokeAllSessions(userId: string, actor?: Actor) {
  const u = getDb().select({ id: schema.users.id, role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!u) throw notFound("user not found");
  if (actor) assertMayManage(u, actor, "log out");
  getDb().delete(schema.sessions).where(eq(schema.sessions.userId, userId)).run();
  broadcast({ type: "users:changed" } as never);
}
