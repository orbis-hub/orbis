import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { localizeManifest, type InstalledModule, type ModuleManifest, type ModuleStatus } from "@orbis/sdk";
import type { ModuleServer } from "@orbis/sdk/server";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { getDb, now, schema } from "../db";
import { childLog } from "../log";
import { removeWidgetsOfModule } from "../services/dashboards";
import { releaseAllOfModule } from "../services/devices";
import { broadcast } from "../ws";
import { buildContext, type BuiltContext } from "./context";
import { evictLocales, translatorFor } from "./locales";
import { shouldIsolate, startWorkerServer } from "./worker/host";
import { stripSecretSettings } from "./secrets";
import { applySettingsPatch, type SettingsSchema } from "./settings-schema";
import { type DiscoveredModule, discoverBuiltin, discoverDev, discoverInstalled, installFromUrl, type ModuleSource, removeInstalledFiles } from "./installer";

const log = childLog("modules");

export type ModuleState = {
  id: string;
  manifest: ModuleManifest;
  version: string;
  dir: string | null;
  source: ModuleSource;
  sourceRef: string | null;
  enabled: boolean;
  settings: Record<string, unknown>;
  installedAt: string;
  loaded: boolean;
  loadedAt: string | null;
  error: string | null;
  status: ModuleStatus | null;
  server?: ModuleServer;
  built?: BuiltContext;
  /** server code runs in a worker_thread (store modules) */
  isolated?: boolean;
};

const states = new Map<string, ModuleState>();
const moduleChangeListeners = new Set<(loaded: string[]) => void>();

function loadedIds() {
  return [...states.values()].filter((s) => s.loaded && s.enabled).map((s) => s.id);
}
function notifyModulesChanged() {
  const ids = loadedIds();
  for (const cb of moduleChangeListeners) {
    try {
      cb(ids);
    } catch {
      /* ignore */
    }
  }
}

/** The modules api handed to every module context. */
function modulesApiFor(selfId: string) {
  return {
    list: () => [...states.values()].filter((s) => s.loaded && s.enabled && s.id !== selfId).map((s) => ({ id: s.id, version: s.version, name: s.manifest.name })),
    has: (id: string) => !!states.get(id)?.loaded && !!states.get(id)?.enabled,
    async call<T = unknown>(id: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
      const t = states.get(id);
      if (!t || !t.enabled || !t.loaded || !t.built) throw new Error(`module ${id} is not available`);
      const headers = new Headers(init.headers);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(init.json);
      }
      // in-process calls carry only the calling module's id; a caller cannot pose as a user or another module
      headers.delete("x-orbis-user");
      headers.delete("x-orbis-role");
      headers.set("x-orbis-caller", selfId);
      const res = await t.built.ctx.http.fetch(new Request(`http://modules.local${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers, body }));
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* non-json */
      }
      if (!res.ok) throw Object.assign(new Error((data as { error?: string })?.error ?? `${id} answered HTTP ${res.status}`), { status: res.status });
      return data as T;
    },
    onChange(cb: (loaded: string[]) => void) {
      moduleChangeListeners.add(cb);
      return () => moduleChangeListeners.delete(cb);
    },
  };
}

/** Hard dependencies that are not installed, disabled or not loaded. */
export function missingDeps(s: ModuleState): string[] {
  return s.manifest.deps.filter((d) => {
    const t = states.get(d);
    return !t || !t.enabled || !t.loaded;
  });
}

/** Enabled modules that hard-depend on `id`. */
export function dependentsOf(id: string): ModuleState[] {
  return [...states.values()].filter((s) => s.enabled && s.manifest.deps.includes(id));
}

export function list(): ModuleState[] {
  return [...states.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/** manifest with name/description/widget/page names in the hub's language (keys `manifest.*`, `widget.<id>.*`, `page.<id>.*` in the module's locales) */
export function localizedManifest(s: ModuleState): ModuleManifest {
  return localizeManifest(s.manifest, translatorFor(s.dir));
}

export function get(id: string) {
  return states.get(id) ?? null;
}

export function toPublic(s: ModuleState): InstalledModule {
  return { id: s.id, version: s.version, enabled: s.enabled, source: s.source, manifest: localizedManifest(s), error: s.error, installedAt: s.installedAt, loadedAt: s.loadedAt, status: s.status, isolated: !!s.isolated };
}

/* ---------- persistence ---------- */

function persist(s: ModuleState) {
  getDb()
    .insert(schema.installedModules)
    .values({
      id: s.id,
      version: s.version,
      enabled: s.enabled,
      source: s.source,
      sourceRef: s.sourceRef,
      manifest: JSON.stringify(s.manifest),
      settings: JSON.stringify(s.settings),
      installedAt: s.installedAt,
    })
    .onConflictDoUpdate({
      target: schema.installedModules.id,
      set: { version: s.version, enabled: s.enabled, source: s.source, sourceRef: s.sourceRef, manifest: JSON.stringify(s.manifest), settings: JSON.stringify(s.settings) },
    })
    .run();
}

function upsertFromDisk(d: DiscoveredModule): ModuleState {
  const row = getDb().select().from(schema.installedModules).where(eq(schema.installedModules.id, d.manifest.id)).get();
  let settings: Record<string, unknown> = {};
  try {
    settings = row ? JSON.parse(row.settings) : {};
  } catch {
    /* ignore */
  }
  const prev = states.get(d.manifest.id);
  const s: ModuleState = {
    id: d.manifest.id,
    manifest: d.manifest,
    version: d.manifest.version,
    dir: d.dir,
    source: d.source,
    sourceRef: d.sourceRef,
    enabled: row ? row.enabled : true,
    settings,
    installedAt: row?.installedAt ?? now(),
    loaded: prev?.loaded ?? false,
    loadedAt: prev?.loadedAt ?? null,
    error: null,
    status: prev?.status ?? null,
    server: prev?.server,
    built: prev?.built,
  };
  states.set(s.id, s);
  persist(s);
  return s;
}

/* ---------- lifecycle ---------- */

async function importFresh(file: string) {
  const mtime = statSync(file).mtimeMs;
  return import(`${pathToFileURL(file).href}?v=${mtime}`);
}

export async function load(id: string): Promise<ModuleState> {
  const s = states.get(id);
  if (!s) throw new Error(`unknown module ${id}`);
  if (s.loaded) return s;
  if (!s.dir) {
    s.error = "module files missing";
    return s;
  }
  const missing = missingDeps(s);
  if (missing.length) {
    s.error = `needs ${missing.map((m) => `"${m}"`).join(", ")} – install and enable ${missing.length > 1 ? "them" : "it"} first`;
    s.loaded = false;
    log.warn({ id, missing }, "module waits for dependencies");
    return s;
  }
  if (!s.manifest.entry.server) {
    s.loaded = true; // client-only module
    s.loadedAt = now();
    s.error = null;
    notifyModulesChanged();
    await loadDependents(id);
    return s;
  }
  const file = join(s.dir, s.manifest.entry.server);
  try {
    const built = buildContext(
      s.manifest,
      s.dir,
      () => s.settings,
      (patch) => void updateSettings(id, patch),
      (status) => {
        s.status = status;
        broadcast({ type: "modules:changed" });
      },
      modulesApiFor(id),
    );
    let server: ModuleServer;
    if (shouldIsolate(s.source)) {
      server = await startWorkerServer(s.manifest, file, built.ctx);
    } else {
      const mod = await importFresh(file);
      server = mod.default ?? mod;
      if (typeof server?.setup !== "function") throw new Error("server entry has no default export with setup()");
      await server.setup(built.ctx);
    }
    s.server = server;
    s.built = built;
    s.isolated = shouldIsolate(s.source);
    s.loaded = true;
    s.loadedAt = now();
    s.error = null;
    log.info({ id, version: s.version, source: s.source }, "module loaded");
    notifyModulesChanged();
    await loadDependents(id);
  } catch (err) {
    s.error = (err as Error).message ?? String(err);
    s.loaded = false;
    log.error({ id, err: s.error }, "module failed to load");
  }
  return s;
}

/** After `id` loaded: retry enabled modules that were waiting for it. */
async function loadDependents(id: string) {
  for (const d of dependentsOf(id)) if (!d.loaded && missingDeps(d).length === 0) await load(d.id);
}

export async function unload(id: string) {
  const s = states.get(id);
  if (!s || !s.loaded) return;
  // dependents go down first and remember why
  for (const d of dependentsOf(id)) {
    if (d.loaded) {
      await unload(d.id);
      d.error = `needs "${id}" – it was disabled or removed`;
    }
  }
  try {
    await s.server?.teardown?.();
  } catch (err) {
    log.warn({ id, err }, "teardown failed");
  }
  s.built?.dispose();
  evictLocales(s.dir);
  s.server = undefined;
  s.built = undefined;
  s.loaded = false;
  s.status = null;
  log.info({ id }, "module unloaded");
  notifyModulesChanged();
}

export async function reload(id: string) {
  await unload(id);
  // re-read manifest from disk in case it changed (also picks up builtins added while running)
  const fresh = [...discoverDev(), ...discoverInstalled(), ...discoverBuiltin()].find((d) => d.manifest.id === id);
  if (fresh) upsertFromDisk(fresh);
  const out = await load(id);
  broadcast({ type: "modules:changed" });
  return out;
}

export async function setEnabled(id: string, enabled: boolean) {
  const s = states.get(id);
  if (!s) throw new Error(`unknown module ${id}`);
  s.enabled = enabled;
  persist(s);
  if (enabled) await load(id);
  else await unload(id);
  broadcast({ type: "modules:changed" });
  return s;
}

export async function updateSettings(id: string, patch: Record<string, unknown>) {
  const s = states.get(id);
  if (!s) throw new Error(`unknown module ${id}`);
  // `null` removes a key; the merged result must pass the module's settingsSchema (unknown keys are rejected when the schema lists properties)
  s.settings = applySettingsPatch(s.manifest.settingsSchema as SettingsSchema | undefined, s.settings, patch);
  persist(s);
  s.built?.emitSettings(s.settings);
  // every websocket client (members too) receives this event: never ship secrets over it (#38)
  broadcast({ type: "module:event", module: id, name: "$settings", payload: stripSecretSettings(s.manifest, s.settings) });
  return s.settings;
}

export async function install(url: string, expectedId?: string) {
  const d = await installFromUrl(url, expectedId);
  const existed = states.get(d.manifest.id);
  if (existed) await unload(existed.id);
  const s = upsertFromDisk(d);
  s.source = "registry";
  s.sourceRef = url;
  persist(s);
  await load(s.id);
  broadcast({ type: "modules:changed" });
  return s;
}

export async function uninstall(id: string) {
  const s = states.get(id);
  if (!s) throw new Error(`unknown module ${id}`);
  if (s.source === "builtin") throw new Error("built-in modules cannot be uninstalled, disable them instead");
  const deps = dependentsOf(id);
  if (deps.length) throw new Error(`${deps.map((d) => d.manifest.name).join(", ")} depend${deps.length > 1 ? "" : "s"} on this module – remove or disable ${deps.length > 1 ? "them" : "it"} first`);
  await unload(id);
  if (s.source === "registry" || s.source === "url") removeInstalledFiles(id);
  removeWidgetsOfModule(id);
  releaseAllOfModule(id);
  getDb().delete(schema.installedModules).where(eq(schema.installedModules.id, id)).run();
  getDb().delete(schema.moduleKv).where(eq(schema.moduleKv.module, id)).run();
  states.delete(id);
  // a store copy may have shadowed a built-in module of the same id: bring the built-in back
  const builtin = discoverBuiltin().find((d) => d.manifest.id === id);
  if (builtin) {
    upsertFromDisk(builtin);
    await load(id);
  }
  broadcast({ type: "modules:changed" });
}

/* ---------- startup ---------- */

export async function bootstrap() {
  // precedence: dev > installed > builtin
  const seen = new Set<string>();
  for (const d of [...discoverDev(), ...discoverInstalled(), ...discoverBuiltin()]) {
    if (seen.has(d.manifest.id)) continue;
    seen.add(d.manifest.id);
    upsertFromDisk(d);
  }
  // rows whose files vanished
  for (const row of getDb().select().from(schema.installedModules).all()) {
    if (seen.has(row.id)) continue;
    if (row.source === "dev") {
      // dev modules are ephemeral: folder gone = module gone
      getDb().delete(schema.installedModules).where(eq(schema.installedModules.id, row.id)).run();
      continue;
    }
    let manifest: ModuleManifest;
    try {
      manifest = JSON.parse(row.manifest);
    } catch {
      continue;
    }
    states.set(row.id, {
      id: row.id,
      manifest,
      version: row.version,
      dir: null,
      source: row.source as ModuleSource,
      sourceRef: row.sourceRef,
      enabled: row.enabled,
      settings: safeJson(row.settings),
      installedAt: row.installedAt,
      loaded: false,
      loadedAt: null,
      status: null,
      error: "module files missing – reinstall or remove",
    });
  }
  // load in dependency order: modules without unmet deps first, then whoever got unblocked (load() retries dependents)
  for (const s of [...states.values()].sort((a, b) => a.manifest.deps.length - b.manifest.deps.length)) if (s.enabled && !s.loaded) await load(s.id);
  log.info({ count: states.size, loaded: [...states.values()].filter((s) => s.loaded).length }, "modules bootstrapped");
  watchDev();
}

export async function shutdown() {
  watcher?.close();
  for (const s of states.values()) await unload(s.id);
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/* ---------- dev watcher ---------- */

let watcher: FSWatcher | null = null;
const pending = new Map<string, NodeJS.Timeout>();

function watchDev() {
  if (!existsSync(config.devModulesDir)) return;
  try {
    watcher = watch(config.devModulesDir, { recursive: true }, (_ev, filename) => {
      if (!filename) return;
      const id = String(filename).split(/[\\/]/)[0];
      if (!id) return;
      clearTimeout(pending.get(id));
      pending.set(
        id,
        setTimeout(async () => {
          pending.delete(id);
          const dir = join(config.devModulesDir, id);
          if (!existsSync(join(dir, "module.json"))) {
            if (states.get(id)?.source === "dev") {
              await unload(id);
              states.delete(id);
              getDb().delete(schema.installedModules).where(eq(schema.installedModules.id, id)).run();
              broadcast({ type: "modules:changed" });
            }
            return;
          }
          log.info({ id }, "dev module changed, reloading");
          const d = discoverDev().find((x) => x.manifest.id === id);
          if (d) {
            await unload(id);
            upsertFromDisk(d);
            await load(id);
            broadcast({ type: "modules:changed" });
          }
        }, 400),
      );
    });
    log.info({ dir: config.devModulesDir }, "watching dev modules");
  } catch (err) {
    log.warn({ err }, "dev watcher unavailable");
  }
}
