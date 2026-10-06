import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: text("created_at").notNull(),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(), // sha256 of the token
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  userAgent: text("user_agent"),
  label: text("label"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // json
  updatedAt: text("updated_at").notNull(),
});

export const dashboards = sqliteTable("dashboards", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon"),
  sort: integer("sort").notNull().default(0),
  createdAt: text("created_at").notNull(),
  ownerId: text("owner_id"),
  shared: integer("shared", { mode: "boolean" }).notNull().default(true),
  accent: text("accent"),
});

export const dashboardWidgets = sqliteTable("dashboard_widgets", {
  id: text("id").primaryKey(),
  dashboardId: text("dashboard_id").notNull(),
  module: text("module").notNull(),
  widget: text("widget").notNull(),
  x: integer("x").notNull().default(0),
  y: integer("y").notNull().default(0),
  w: integer("w").notNull().default(3),
  h: integer("h").notNull().default(2),
  config: text("config").notNull().default("{}"),
});

export const installedModules = sqliteTable("installed_modules", {
  id: text("id").primaryKey(),
  version: text("version").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  source: text("source").notNull(), // builtin | registry | dev | url
  sourceRef: text("source_ref"), // registry url / tarball url / path
  manifest: text("manifest").notNull(), // json
  settings: text("settings").notNull().default("{}"),
  installedAt: text("installed_at").notNull(),
});

export const moduleKv = sqliteTable("module_kv", {
  module: text("module").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  ip: text("ip").notNull(),
  mac: text("mac"),
  hostname: text("hostname"),
  vendor: text("vendor"),
  services: text("services").notNull().default("[]"),
  firstSeen: text("first_seen").notNull(),
  lastSeen: text("last_seen").notNull(),
  online: integer("online", { mode: "boolean" }).notNull().default(true),
  claimedBy: text("claimed_by"),
  label: text("label"),
});

/** Hand-written DDL, applied at startup in order. Append new statements, never edit old ones. */
export const migrations: string[] = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT, label TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dashboards (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dashboard_widgets (id TEXT PRIMARY KEY, dashboard_id TEXT NOT NULL, module TEXT NOT NULL, widget TEXT NOT NULL, x INTEGER NOT NULL DEFAULT 0, y INTEGER NOT NULL DEFAULT 0, w INTEGER NOT NULL DEFAULT 3, h INTEGER NOT NULL DEFAULT 2, config TEXT NOT NULL DEFAULT '{}')`,
  `CREATE INDEX IF NOT EXISTS dashboard_widgets_dash ON dashboard_widgets(dashboard_id)`,
  `CREATE TABLE IF NOT EXISTS installed_modules (id TEXT PRIMARY KEY, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, source_ref TEXT, manifest TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', installed_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS module_kv (module TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (module, key))`,
  `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, ip TEXT NOT NULL, mac TEXT, hostname TEXT, vendor TEXT, services TEXT NOT NULL DEFAULT '[]', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 1, claimed_by TEXT, label TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS devices_mac ON devices(mac) WHERE mac IS NOT NULL`,
];

export const dashboardAccess = sqliteTable("dashboard_access", {
  dashboardId: text("dashboard_id").notNull(),
  userId: text("user_id").notNull(),
});

// v2: multi-user. dashboards get an owner and a shared flag; explicit grants live in dashboard_access.
migrations.push(
  `ALTER TABLE dashboards ADD COLUMN owner_id TEXT`,
  `ALTER TABLE dashboards ADD COLUMN shared INTEGER NOT NULL DEFAULT 1`,
  `CREATE TABLE IF NOT EXISTS dashboard_access (dashboard_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (dashboard_id, user_id))`,
  `ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`,
);

export const einkDisplays = sqliteTable("eink_displays", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  token: text("token").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  dashboardId: text("dashboard_id"),
  rotate: integer("rotate").notNull().default(0),
  invert: integer("invert", { mode: "boolean" }).notNull().default(false),
  grayscale: integer("grayscale").notNull().default(1), // bits per pixel the panel can show: 1 or 4 (inkplate 3-bit → 8 levels, lilygo 4-bit → 16)
  refreshMinutes: integer("refresh_minutes").notNull().default(10),
  board: text("board"),
  lastSeen: text("last_seen"),
  battery: integer("battery"),
  createdAt: text("created_at").notNull(),
});

migrations.push(
  `CREATE TABLE IF NOT EXISTS eink_displays (id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, dashboard_id TEXT, rotate INTEGER NOT NULL DEFAULT 0, invert INTEGER NOT NULL DEFAULT 0, grayscale INTEGER NOT NULL DEFAULT 1, refresh_minutes INTEGER NOT NULL DEFAULT 10, board TEXT, last_seen TEXT, battery INTEGER, created_at TEXT NOT NULL)`,
);

migrations.push(`ALTER TABLE dashboards ADD COLUMN accent TEXT`);

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  module: text("module").notNull(),
  key: text("key"),
  title: text("title").notNull(),
  body: text("body"),
  url: text("url"),
  level: text("level").notNull().default("info"),
  icon: text("icon"),
  createdAt: text("created_at").notNull(),
  /** legacy hub-wide read flag; since the per-user migration the read state lives in notification_reads */
  readAt: text("read_at"),
  /** null = everyone on the hub */
  userId: text("user_id"),
});

migrations.push(
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, module TEXT NOT NULL, key TEXT, title TEXT NOT NULL, body TEXT, url TEXT, level TEXT NOT NULL DEFAULT 'info', icon TEXT, created_at TEXT NOT NULL, read_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS notifications_key ON notifications(module, key)`,
);

/** per-user read state: a shared notification (user_id null) read by mia stays unread for everyone else */
export const notificationReads = sqliteTable("notification_reads", {
  notificationId: text("notification_id").notNull(),
  userId: text("user_id").notNull(),
  readAt: text("read_at").notNull(),
});

// v3: notifications per user (#41). rows that were read hub-wide count as read for every existing account.
migrations.push(
  `ALTER TABLE notifications ADD COLUMN user_id TEXT`,
  `CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id)`,
  `CREATE TABLE IF NOT EXISTS notification_reads (notification_id TEXT NOT NULL, user_id TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY (notification_id, user_id))`,
  `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) SELECT n.id, u.id, n.read_at FROM notifications n, users u WHERE n.read_at IS NOT NULL`,
);
