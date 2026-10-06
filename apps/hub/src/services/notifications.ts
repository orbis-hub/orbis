import type { Notification, NotificationInput } from "@orbis/sdk";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { isAdminRole, type AuthUser } from "../auth";
import { getDb, now, schema } from "../db";
import { childLog } from "../log";
import { broadcast } from "../ws";
import { getAllSettings } from "./settings";

const log = childLog("notify");

/**
 * Notifications are per account (#41): `user_id` null = shared with everyone, otherwise one account.
 * The read state lives in notification_reads (notification_id, user_id), so one person marking a shared
 * notification read does not hide it from the others.
 */

type Row = typeof schema.notifications.$inferSelect;

function toPublic(r: Row, readAt: string | null): Notification {
  return {
    id: r.id,
    module: r.module,
    key: r.key,
    title: r.title,
    body: r.body,
    url: r.url,
    level: r.level as Notification["level"],
    icon: r.icon,
    createdAt: r.createdAt,
    readAt,
    userId: r.userId,
  };
}

/** shared or addressed to this user */
const visibleTo = (userId: string) => or(isNull(schema.notifications.userId), eq(schema.notifications.userId, userId));

function readAtFor(userId: string, ids: string[]): Map<string, string> {
  if (!ids.length) return new Map();
  const rows = getDb()
    .select()
    .from(schema.notificationReads)
    .where(and(eq(schema.notificationReads.userId, userId), inArray(schema.notificationReads.notificationId, ids)))
    .all();
  return new Map(rows.map((r) => [r.notificationId, r.readAt]));
}

function getRow(id: string): Row | null {
  return getDb().select().from(schema.notifications).where(eq(schema.notifications.id, id)).get() ?? null;
}

/** one notification as the given user sees it; null when it does not exist or is addressed to somebody else */
export function getNotification(id: string, userId: string): Notification | null {
  const r = getRow(id);
  if (!r || (r.userId !== null && r.userId !== userId)) return null;
  return toPublic(r, readAtFor(userId, [id]).get(id) ?? null);
}

export function listNotifications(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(500, opts.limit || 100));
  const rows = db.select().from(schema.notifications).where(visibleTo(userId)).orderBy(desc(schema.notifications.createdAt)).limit(opts.unreadOnly ? 500 : limit).all();
  const reads = readAtFor(
    userId,
    rows.map((r) => r.id),
  );
  const items = rows.map((r) => toPublic(r, reads.get(r.id) ?? null));
  return opts.unreadOnly ? items.filter((n) => !n.readAt).slice(0, limit) : items;
}

/** unread for one account; without a user: shared notifications nobody has read yet (used for broadcasts) */
export function unreadCount(userId?: string | null) {
  const db = getDb();
  if (!userId) {
    return db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(and(isNull(schema.notifications.userId), sql`NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = ${schema.notifications.id})`))
      .all().length;
  }
  return db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(and(visibleTo(userId), sql`NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = ${schema.notifications.id} AND r.user_id = ${userId})`))
    .all().length;
}

/** Per-module mute list lives in hub settings (`mutedModules`). */
function isMuted(module: string) {
  return (getAllSettings().mutedModules ?? []).includes(module);
}

function userExists(id: string) {
  return !!getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, id)).get();
}

export function notify(module: string, input: NotificationInput): Notification | null {
  if (isMuted(module)) return null;
  const db = getDb();
  const level = input.level ?? "info";
  const userId = input.userId ?? null;
  if (userId !== null && !userExists(userId)) {
    log.warn({ module, userId }, "notification for unknown user dropped");
    return null;
  }
  const values = { module, key: input.key ?? null, title: input.title, body: input.body ?? null, url: input.url ?? null, level, icon: input.icon ?? null, createdAt: now(), readAt: null, userId };
  // `key` makes a notification replaceable: same module + key → update instead of a new row (e.g. "task-due:<id>")
  if (input.key) {
    const existing = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.module, module), eq(schema.notifications.key, input.key)))
      .get();
    if (existing) {
      db.update(schema.notifications).set(values).where(eq(schema.notifications.id, existing.id)).run();
      // a replaced notification is new again for everyone
      db.delete(schema.notificationReads).where(eq(schema.notificationReads.notificationId, existing.id)).run();
      const n = toPublic(getRow(existing.id)!, null);
      deliver(n);
      return n;
    }
  }
  const id = nanoid(10);
  db.insert(schema.notifications).values({ id, ...values }).run();
  const n = toPublic(getRow(id)!, null);
  deliver(n);
  // keep the table small
  const old = db.select({ id: schema.notifications.id }).from(schema.notifications).orderBy(desc(schema.notifications.createdAt)).all();
  if (old.length > 500) for (const r of old.slice(500)) removeRow(r.id);
  return n;
}

function removeRow(id: string) {
  const db = getDb();
  db.delete(schema.notificationReads).where(eq(schema.notificationReads.notificationId, id)).run();
  db.delete(schema.notifications).where(eq(schema.notifications.id, id)).run();
}

function changed(userId?: string | null) {
  broadcast({ type: "notifications:changed", unread: unreadCount(userId) } as never);
}

export function dismiss(module: string, key: string) {
  const existing = getDb()
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.module, module), eq(schema.notifications.key, key)))
    .get();
  if (!existing) return;
  removeRow(existing.id);
  changed(existing.userId);
}

/** mark read for one account only */
export function markRead(userId: string, ids: string[] | "all") {
  const db = getDb();
  const rows =
    ids === "all"
      ? db.select({ id: schema.notifications.id }).from(schema.notifications).where(visibleTo(userId)).all()
      : ids.length
        ? db
            .select({ id: schema.notifications.id })
            .from(schema.notifications)
            .where(and(visibleTo(userId), inArray(schema.notifications.id, ids)))
            .all()
        : [];
  const ts = now();
  for (const r of rows) db.insert(schema.notificationReads).values({ notificationId: r.id, userId, readAt: ts }).onConflictDoNothing().run();
  changed(userId);
}

/**
 * Delete as a user: admins delete anything they can see, members delete their own and merely
 * dismiss (= mark read) shared ones. Returns null when the notification is not visible to the user.
 */
export function remove(id: string, user: AuthUser): { deleted: boolean } | null {
  const r = getRow(id);
  if (!r || (r.userId !== null && r.userId !== user.id)) return null;
  if (r.userId === user.id || isAdminRole(user.role)) {
    removeRow(id);
    changed(r.userId);
    return { deleted: true };
  }
  markRead(user.id, [id]);
  return { deleted: false };
}

/** "clear": drop what this user has read — own notifications always, shared ones only for admins */
export function clearRead(user: AuthUser) {
  const db = getDb();
  const read = db
    .select({ id: schema.notificationReads.notificationId, owner: schema.notifications.userId })
    .from(schema.notificationReads)
    .innerJoin(schema.notifications, eq(schema.notifications.id, schema.notificationReads.notificationId))
    .where(eq(schema.notificationReads.userId, user.id))
    .all();
  for (const r of read) if (r.owner === user.id || (r.owner === null && isAdminRole(user.role))) removeRow(r.id);
  changed(user.id);
}

/** when an account goes away its private notifications and read marks go with it */
export function forgetUser(userId: string) {
  const db = getDb();
  for (const r of db.select({ id: schema.notifications.id }).from(schema.notifications).where(eq(schema.notifications.userId, userId)).all()) removeRow(r.id);
  db.delete(schema.notificationReads).where(eq(schema.notificationReads.userId, userId)).run();
}

/* ---------- delivery: websocket always, ntfy / telegram when configured ---------- */

function deliver(n: Notification) {
  // every client gets the event; the web app drops ones addressed to somebody else (notification.userId)
  broadcast({ type: "notification", notification: n, unread: unreadCount(n.userId) } as never);
  const s = getAllSettings();
  const ch = s.notifyChannels ?? {};
  if (ch.ntfy?.topic) void sendNtfy(ch.ntfy, n);
  if (ch.telegram?.botToken && ch.telegram.chatId) void sendTelegram(ch.telegram, n);
}

async function sendNtfy(cfg: { server?: string; topic: string; token?: string; minLevel?: string }, n: Notification) {
  if (!passes(cfg.minLevel, n.level)) return;
  try {
    const res = await fetch(`${(cfg.server || "https://ntfy.sh").replace(/\/+$/, "")}/${encodeURIComponent(cfg.topic)}`, {
      method: "POST",
      headers: {
        title: n.title,
        priority: n.level === "urgent" ? "5" : n.level === "warning" ? "4" : "3",
        tags: n.level === "urgent" ? "rotating_light" : n.level === "warning" ? "warning" : "bell",
        ...(n.url ? { click: n.url } : {}),
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: n.body ?? "",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn({ status: res.status }, "ntfy rejected");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "ntfy failed");
  }
}

async function sendTelegram(cfg: { botToken: string; chatId: string; minLevel?: string }, n: Notification) {
  if (!passes(cfg.minLevel, n.level)) return;
  try {
    const text = `${n.level === "urgent" ? "🚨 " : n.level === "warning" ? "⚠️ " : ""}*${escapeMd(n.title)}*${n.body ? `\n${escapeMd(n.body)}` : ""}${n.url ? `\n${n.url}` : ""}`;
    const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn({ status: res.status, body: await res.text() }, "telegram rejected");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "telegram failed");
  }
}

const LEVELS = ["info", "warning", "urgent"];
function passes(min: string | undefined, level: string) {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(min ?? "info");
}
function escapeMd(s: string) {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

/** Admin "send a test" from the settings page (shared, so the whole household sees the channel works). */
export function sendTest() {
  return notify("hub", { title: "test notification", body: "if you read this on your phone, the channel works.", level: "info", icon: "bell", key: "hub:test" });
}
