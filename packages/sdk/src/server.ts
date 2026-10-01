import type { Hono } from "hono";
import type { Device, ModuleManifest, ModuleStatus } from "./index";

export type Logger = {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
};

/** Key/value store scoped to the module. Values are JSON-serialised. */
export type ModuleStorage = {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(prefix?: string): string[];
  /**
   * Run raw SQL against the module's own table namespace. Table names are
   * prefixed automatically with `m_<moduleId>_` when you use the `{{t:name}}` placeholder.
   * Example: storage.sql("CREATE TABLE IF NOT EXISTS {{t:items}} (id TEXT PRIMARY KEY, title TEXT)")
   */
  sql<T = unknown>(query: string, params?: unknown[]): T[];
  run(query: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
};

export type ModuleScheduler = {
  /** Run `fn` every `everyMs` milliseconds (first run after `everyMs` unless `immediate`). */
  every(name: string, everyMs: number, fn: () => void | Promise<void>, opts?: { immediate?: boolean }): void;
  /** Run `fn` once after `delayMs`. */
  once(name: string, delayMs: number, fn: () => void | Promise<void>): void;
  cancel(name: string): void;
};

export type ModuleEvents = {
  /** Broadcast to all connected clients; received via `useModuleEvents` in the module's client code. */
  publish(name: string, payload?: unknown): void;
};

export type ModuleDevices = {
  list(): Device[];
  /** Devices nobody has claimed that match this module's discovery matcher. */
  suggested(): Device[];
  claimed(): Device[];
  claim(deviceId: string): Device | null;
  release(deviceId: string): void;
  onChange(cb: (devices: Device[]) => void): () => void;
};

export type ModuleSettings<T = Record<string, unknown>> = {
  get(): T;
  set(patch: Partial<T>): void;
  onChange(cb: (settings: T) => void): () => void;
};

/** Other modules on this hub: check soft dependencies and talk to them. */
export type ModuleModules = {
  /** ids of modules that are installed, enabled and loaded */
  list(): Array<{ id: string; version: string; name: string }>;
  has(id: string): boolean;
  /**
   * Call another module's http api (same as a client would, but in-process and without auth).
   * `ctx.modules.call("home-assistant", "/entities?domain=media_player")`
   */
  call<T = unknown>(id: string, path: string, init?: RequestInit & { json?: unknown }): Promise<T>;
  /** fires when a module loads or unloads */
  onChange(cb: (loaded: string[]) => void): () => void;
};

export type ModuleServerContext<TSettings = Record<string, unknown>> = {
  manifest: ModuleManifest;
  /** Absolute path to the module's installed directory. */
  dir: string;
  /** Absolute path to a writable data directory for this module. */
  dataDir: string;
  hubVersion: string;
  logger: Logger;
  storage: ModuleStorage;
  scheduler: ModuleScheduler;
  events: ModuleEvents;
  devices: ModuleDevices;
  settings: ModuleSettings<TSettings>;
  /** Report setup state: `ctx.status.set({ state: "needs-setup", message: "add an account", action: { label: "open calendar", page: "calendar" } })`. */
  status: { set(status: ModuleStatus | null): void; get(): ModuleStatus | null };
  modules: ModuleModules;
  /**
   * Hono router mounted at `/api/m/<moduleId>`. Requests are already authenticated.
   * Example: ctx.http.get("/items", (c) => c.json(items))
   */
  http: Hono;
  fetch: typeof fetch;
};

export type ModuleServer<TSettings = Record<string, unknown>> = {
  setup(ctx: ModuleServerContext<TSettings>): void | Promise<void>;
  /** Called when the module is disabled, uninstalled or the hub shuts down. */
  teardown?(): void | Promise<void>;
  /**
   * Optional e-ink renderer: return a simple layout tree the hub rasterises.
   * Reserved for a later phase; typed now so modules can opt in early.
   */
  eink?(ctx: ModuleServerContext<TSettings>, req: EinkRequest): Promise<EinkTree> | EinkTree;
};

export type EinkRequest = { displayId: string; width: number; height: number; widget: string; config: Record<string, unknown> };
export type EinkTree =
  | { type: "text"; text: string; size?: "xs" | "sm" | "md" | "lg" | "xl"; bold?: boolean; align?: "left" | "center" | "right" }
  | { type: "row" | "col"; gap?: number; children: EinkTree[] }
  | { type: "rule" }
  | { type: "icon"; name: string; size?: number };

export function defineModule<TSettings = Record<string, unknown>>(mod: ModuleServer<TSettings>): ModuleServer<TSettings> {
  return mod;
}
