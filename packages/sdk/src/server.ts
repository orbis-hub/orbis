import type { Hono } from "hono";
import type { Device, ModuleManifest, ModuleStatus, Notification, NotificationInput } from "./index";
import type { Translator } from "./i18n";

export type { Messages, Translator, TranslateVars } from "./i18n";
export { createTranslator, localizeManifest, languageChain, pickLanguage } from "./i18n";

/** Translations for the hub's current language (see `locales/<lang>.json` and `manifest.languages`). */
export type ModuleI18n = {
  /** the hub's ui language, e.g. "de" */
  readonly language: string;
  /** translate a key from the module's locale files; falls back to english, then to the key itself */
  t: Translator;
  /** fires when the hub language changes */
  onChange(cb: (language: string) => void): () => void;
};

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
   * Tell the user something: bell in the app, toast for urgent ones, and whatever channels they configured (ntfy, telegram).
   * Users can mute a module. Use `key` for things that update (replace) and `dismiss(key)` when they resolve.
   */
  notify(input: NotificationInput): Notification | null;
  dismissNotification(key: string): void;
  /**
   * Hono router mounted at `/api/m/<moduleId>`. Requests are already authenticated.
   * Example: ctx.http.get("/items", (c) => c.json(items))
   */
  http: Hono;
  fetch: typeof fetch;
  /** `ctx.i18n.t("notify.due", { title })` for notifications and e-ink text in the user's language. */
  i18n: ModuleI18n;
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
  /**
   * Optional: a touch display was tapped inside this widget. `x`/`y` are pixels inside the widget's
   * content area (same box `eink()` rendered into). Return `{ refresh: true }` to redraw right away.
   * Without this hook a tap just refreshes the display.
   */
  einkTap?(ctx: ModuleServerContext<TSettings>, req: EinkTapRequest): Promise<EinkTapResult | void> | EinkTapResult | void;
};

export type EinkTapRequest = EinkRequest & { x: number; y: number };
export type EinkTapResult = { refresh?: boolean; toast?: string };

export type EinkRequest = {
  displayId: string;
  /** pixel size of the area this widget gets */
  width: number;
  height: number;
  /** 1 = black/white, 4 = 16 grays, 8 = 256 grays (what the panel can show) */
  grayLevelsBits: number;
  widget: string;
  config: Record<string, unknown>;
  locale: string;
  timezone: string;
  /** ui language of the hub, e.g. "de" (same as ctx.i18n.language) */
  language?: string;
  now: Date;
};

/**
 * Tiny layout language for e-ink: the hub lays it out with flexbox (satori) and rasterises it.
 * Sizes are in pixels. Keep it simple – no colors, only black, grays and white.
 */
export type EinkTree =
  | { type: "text"; text: string; size?: number; bold?: boolean; pixel?: boolean; align?: "left" | "center" | "right"; gray?: number; wrap?: boolean; grow?: number }
  | { type: "row" | "col"; gap?: number; pad?: number; align?: "start" | "center" | "end" | "stretch"; justify?: "start" | "center" | "end" | "between"; grow?: number; width?: number | string; height?: number | string; children: EinkTree[] }
  | { type: "box"; border?: number; pad?: number; fill?: number; grow?: number; width?: number | string; height?: number | string; children: EinkTree[] }
  | { type: "rule"; dashed?: boolean; vertical?: boolean }
  | { type: "spacer"; size?: number; grow?: number }
  | { type: "icon"; name: string; size?: number; gray?: number }
  | { type: "weather-icon"; name: string; size?: number }
  | { type: "bar"; value: number; max?: number; height?: number }
  | { type: "dots"; count: number; filled: number; size?: number };

export function defineModule<TSettings = Record<string, unknown>>(mod: ModuleServer<TSettings>): ModuleServer<TSettings> {
  return mod;
}
