import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { config } from "../config";
import { childLog } from "../log";
import * as schema from "./schema";

const log = childLog("db");

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let sqlite: Database.Database | null = null;
let db: Db | null = null;

export function openDb(path = config.dbPath): { db: Db; sqlite: Database.Database } {
  if (db && sqlite) return { db, sqlite };
  sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  db = drizzle(sqlite, { schema });
  migrate(sqlite);
  log.info({ path }, "database ready");
  return { db, sqlite };
}

function migrate(s: Database.Database) {
  s.exec(`CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set((s.prepare(`SELECT idx FROM _migrations`).all() as { idx: number }[]).map((r) => r.idx));
  const insert = s.prepare(`INSERT INTO _migrations (idx, applied_at) VALUES (?, ?)`);
  const run = s.transaction(() => {
    schema.migrations.forEach((sql, i) => {
      if (applied.has(i)) return;
      s.exec(sql);
      insert.run(i, new Date().toISOString());
    });
  });
  run();
}

export function getDb(): Db {
  if (!db) throw new Error("db not opened");
  return db;
}

export function getSqlite(): Database.Database {
  if (!sqlite) throw new Error("db not opened");
  return sqlite;
}

export function closeDb() {
  sqlite?.close();
  sqlite = null;
  db = null;
}

export const now = () => new Date().toISOString();
export { schema };
