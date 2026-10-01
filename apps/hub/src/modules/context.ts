import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ModuleManifest } from "@orbis/sdk";
import type { Logger, ModuleDevices, ModuleEvents, ModuleScheduler, ModuleServerContext, ModuleSettings, ModuleStorage } from "@orbis/sdk/server";
import { and, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { config } from "../config";
import { getDb, getSqlite, schema } from "../db";
import { childLog } from "../log";
import * as devices from "../services/devices";
import { broadcast } from "../ws";

export type BuiltContext = {
  ctx: ModuleServerContext;
  dispose: () => void;
  /** Push a settings change into the module (from the settings route). */
  emitSettings: (s: Record<string, unknown>) => void;
};

export function buildContext(manifest: ModuleManifest, dir: string, getSettings: () => Record<string, unknown>, setSettings: (patch: Record<string, unknown>) => void): BuiltContext {
  const id = manifest.id;
  const log = childLog(`mod:${id}`);
  const disposers: Array<() => void> = [];
  const dataDir = resolve(config.moduleDataDir, id);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const logger: Logger = {
    debug: (m, ...a) => log.debug(a.length ? { args: a } : {}, m),
    info: (m, ...a) => log.info(a.length ? { args: a } : {}, m),
    warn: (m, ...a) => log.warn(a.length ? { args: a } : {}, m),
    error: (m, ...a) => log.error(a.length ? { args: a } : {}, m),
  };

  const tablePrefix = `m_${id.replace(/-/g, "_")}_`;
  const rewrite = (q: string) => q.replace(/\{\{t:([a-zA-Z0-9_]+)\}\}/g, (_, t) => `"${tablePrefix}${t}"`);

  const storage: ModuleStorage = {
    get(key) {
      const row = getDb()
        .select()
        .from(schema.moduleKv)
        .where(and(eq(schema.moduleKv.module, id), eq(schema.moduleKv.key, key)))
        .get();
      if (!row) return undefined;
      try {
        return JSON.parse(row.value);
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      getSqlite()
        .prepare(`INSERT INTO module_kv (module, key, value) VALUES (?, ?, ?) ON CONFLICT(module, key) DO UPDATE SET value = excluded.value`)
        .run(id, key, JSON.stringify(value ?? null));
    },
    delete(key) {
      getDb()
        .delete(schema.moduleKv)
        .where(and(eq(schema.moduleKv.module, id), eq(schema.moduleKv.key, key)))
        .run();
    },
    keys(prefix) {
      const rows = getDb()
        .select({ key: schema.moduleKv.key })
        .from(schema.moduleKv)
        .where(prefix ? and(eq(schema.moduleKv.module, id), like(schema.moduleKv.key, `${prefix}%`)) : eq(schema.moduleKv.module, id))
        .all();
      return rows.map((r) => r.key);
    },
    sql(query, params = []) {
      return getSqlite().prepare(rewrite(query)).all(...(params as never[])) as never[];
    },
    run(query, params = []) {
      const r = getSqlite().prepare(rewrite(query)).run(...(params as never[]));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
  };

  const timers = new Map<string, NodeJS.Timeout>();
  const scheduler: ModuleScheduler = {
    every(name, everyMs, fn, opts) {
      scheduler.cancel(name);
      const tick = async () => {
        try {
          await fn();
        } catch (err) {
          log.error({ err, job: name }, "scheduled job failed");
        }
      };
      timers.set(name, setInterval(tick, Math.max(1000, everyMs)));
      if (opts?.immediate) void tick();
    },
    once(name, delayMs, fn) {
      scheduler.cancel(name);
      timers.set(
        name,
        setTimeout(async () => {
          timers.delete(name);
          try {
            await fn();
          } catch (err) {
            log.error({ err, job: name }, "scheduled job failed");
          }
        }, delayMs),
      );
    },
    cancel(name) {
      const t = timers.get(name);
      if (t) {
        clearInterval(t);
        clearTimeout(t);
        timers.delete(name);
      }
    },
  };
  disposers.push(() => {
    for (const t of timers.values()) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.clear();
  });

  const events: ModuleEvents = {
    publish(name, payload) {
      broadcast({ type: "module:event", module: id, name, payload });
    },
  };

  const deviceApi: ModuleDevices = {
    list: () => devices.listDevices(),
    suggested: () => devices.listDevices().filter((d) => !d.claimedBy && devices.matchesDiscovery(d, manifest.discovery)),
    claimed: () => devices.listDevices().filter((d) => d.claimedBy === id),
    claim: (deviceId) => devices.claimDevice(deviceId, id),
    release: (deviceId) => devices.releaseDevice(deviceId, id),
    onChange(cb) {
      const off = devices.onDevicesChange(cb);
      disposers.push(off);
      return off;
    },
  };

  const settingsListeners = new Set<(s: Record<string, unknown>) => void>();
  const settingsApi: ModuleSettings = {
    get: () => getSettings(),
    set: (patch) => setSettings(patch as Record<string, unknown>),
    onChange(cb) {
      settingsListeners.add(cb);
      return () => settingsListeners.delete(cb);
    },
  };

  const http = new Hono();

  const ctx: ModuleServerContext = {
    manifest,
    dir,
    dataDir,
    hubVersion: config.version,
    logger,
    storage,
    scheduler,
    events,
    devices: deviceApi,
    settings: settingsApi,
    http,
    fetch: globalThis.fetch.bind(globalThis),
  };

  return {
    ctx,
    dispose() {
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
      settingsListeners.clear();
    },
    emitSettings(s) {
      for (const cb of settingsListeners) {
        try {
          cb(s);
        } catch (err) {
          log.error({ err }, "settings listener failed");
        }
      }
    },
  };
}
