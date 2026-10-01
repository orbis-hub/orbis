import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { hashPassword, verifyPassword } from "../auth";
import { getDb, now, schema } from "../db";
import { broadcast } from "../ws";

export type Role = "owner" | "admin" | "member";
export const ROLES: Role[] = ["owner", "admin", "member"];

export type PublicUser = { id: string; name: string; role: Role; disabled: boolean; createdAt: string; sessions: number };

export function isAdmin(role: string) {
  return role === "owner" || role === "admin";
}

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

export function nameTaken(name: string, exceptId?: string) {
  const u = getDb().select().from(schema.users).where(eq(schema.users.name, name)).get();
  return !!u && u.id !== exceptId;
}

export function createUserAccount(name: string, password: string, role: Role = "member"): PublicUser {
  if (role === "owner") role = "admin"; // exactly one owner, created at setup
  if (nameTaken(name)) throw new Error("name already taken");
  const user = { id: nanoid(12), name, passwordHash: hashPassword(password), role, createdAt: now(), disabled: false };
  getDb().insert(schema.users).values(user).run();
  broadcast({ type: "users:changed" } as never);
  return toPublic(user as typeof schema.users.$inferSelect);
}

export function updateUser(id: string, patch: { name?: string; role?: Role; disabled?: boolean }, actor: { id: string; role: string }) {
  const db = getDb();
  const target = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!target) throw new Error("user not found");
  if (target.role === "owner" && (patch.role !== undefined && patch.role !== "owner")) throw new Error("the owner's role cannot be changed");
  if (target.role === "owner" && patch.disabled) throw new Error("the owner cannot be disabled");
  if (patch.role === "owner") throw new Error("there is exactly one owner");
  if (actor.role !== "owner" && target.role === "admin" && actor.id !== target.id && (patch.role !== undefined || patch.disabled !== undefined)) {
    throw new Error("only the owner can change other admins");
  }
  if (patch.name !== undefined && nameTaken(patch.name, id)) throw new Error("name already taken");
  const set: Partial<typeof schema.users.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.disabled !== undefined) set.disabled = patch.disabled;
  db.update(schema.users).set(set).where(eq(schema.users.id, id)).run();
  if (patch.disabled) db.delete(schema.sessions).where(eq(schema.sessions.userId, id)).run();
  broadcast({ type: "users:changed" } as never);
  return getUser(id)!;
}

export function setPassword(id: string, password: string, opts: { current?: string; requireCurrent: boolean }) {
  const db = getDb();
  const u = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!u) throw new Error("user not found");
  if (opts.requireCurrent && !(opts.current && verifyPassword(opts.current, u.passwordHash))) throw new Error("current password is wrong");
  db.update(schema.users).set({ passwordHash: hashPassword(password) }).where(eq(schema.users.id, id)).run();
  // log out everywhere else
  db.delete(schema.sessions).where(eq(schema.sessions.userId, id)).run();
}

export function deleteUser(id: string, actor: { id: string; role: string }) {
  const db = getDb();
  const u = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!u) throw new Error("user not found");
  if (u.role === "owner") throw new Error("the owner cannot be deleted");
  if (u.id === actor.id) throw new Error("you cannot delete yourself");
  if (actor.role !== "owner" && u.role === "admin") throw new Error("only the owner can delete admins");
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

export function revokeAllSessions(userId: string) {
  getDb().delete(schema.sessions).where(eq(schema.sessions.userId, userId)).run();
  broadcast({ type: "users:changed" } as never);
}
