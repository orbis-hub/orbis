import type { Notification, NotificationInput } from "@orbis/sdk";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb, now, schema } from "../db";
import { childLog } from "../log";
import { broadcast } from "../ws";
import { getAllSettings } from "./settings";

const log = childLog("notify");

function toPublic(r: typeof schema.notifications.$inferSelect): Notification {
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
    readAt: r.readAt,
  };
}

export function listNotifications(opts: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
  const db = getDb();
  const q = db.select().from(schema.notifications);
  const rows = (opts.unreadOnly ? q.where(isNull(schema.notifications.readAt)) : q).orderBy(desc(schema.notifications.createdAt)).limit(opts.limit ?? 100).all();
  return rows.map(toPublic);
}

export function unreadCount() {
  return getDb().select({ id: schema.notifications.id }).from(schema.notifications).where(isNull(schema.notifications.readAt)).all().length;
}

/** Per-module mute list lives in hub settings (`mutedModules`). */
function isMuted(module: string) {
  return (getAllSettings().mutedModules ?? []).includes(module);
}

export function notify(module: string, input: NotificationInput): Notification | null {
  if (isMuted(module)) return null;
  const db = getDb();
  const level = input.level ?? "info";
  // `key` makes a notification replaceable: same module + key → update instead of a new row (e.g. "task-due:<id>")
  if (input.key) {
    const existing = db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.module, module), eq(schema.notifications.key, input.key)))
      .get();
    if (existing) {
      db.update(schema.notifications)
        .set({ title: input.title, body: input.body ?? null, url: input.url ?? null, level, icon: input.icon ?? null, createdAt: now(), readAt: null })
        .where(eq(schema.notifications.id, existing.id))
        .run();
      const n = toPublic(db.select().from(schema.notifications).where(eq(schema.notifications.id, existing.id)).get()!);
      deliver(n);
      return n;
    }
  }
  const id = nanoid(10);
  db.insert(schema.notifications)
    .values({ id, module, key: input.key ?? null, title: input.title, body: input.body ?? null, url: input.url ?? null, level, icon: input.icon ?? null, createdAt: now(), readAt: null })
    .run();
  const n = toPublic(db.select().from(schema.notifications).where(eq(schema.notifications.id, id)).get()!);
  deliver(n);
  // keep the table small
  const old = db.select({ id: schema.notifications.id }).from(schema.notifications).orderBy(desc(schema.notifications.createdAt)).all();
  if (old.length > 500) for (const r of old.slice(500)) db.delete(schema.notifications).where(eq(schema.notifications.id, r.id)).run();
  return n;
}

export function dismiss(module: string, key: string) {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.module, module), eq(schema.notifications.key, key)))
    .get();
  if (!existing) return;
  db.delete(schema.notifications).where(eq(schema.notifications.id, existing.id)).run();
  broadcast({ type: "notifications:changed", unread: unreadCount() } as never);
}

export function markRead(ids: string[] | "all") {
  const db = getDb();
  if (ids === "all") db.update(schema.notifications).set({ readAt: now() }).where(isNull(schema.notifications.readAt)).run();
  else for (const id of ids) db.update(schema.notifications).set({ readAt: now() }).where(eq(schema.notifications.id, id)).run();
  broadcast({ type: "notifications:changed", unread: unreadCount() } as never);
}

export function remove(id: string) {
  getDb().delete(schema.notifications).where(eq(schema.notifications.id, id)).run();
  broadcast({ type: "notifications:changed", unread: unreadCount() } as never);
}

export function clearRead() {
  getDb().delete(schema.notifications).where(lt(schema.notifications.readAt, now())).run();
  broadcast({ type: "notifications:changed", unread: unreadCount() } as never);
}

/* ---------- delivery: websocket always, ntfy / telegram when configured ---------- */

function deliver(n: Notification) {
  broadcast({ type: "notification", notification: n, unread: unreadCount() } as never);
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

/** Admin "send a test" from the settings page. */
export function sendTest() {
  return notify("hub", { title: "test notification", body: "if you read this on your phone, the channel works.", level: "info", icon: "bell", key: "hub:test" });
}
