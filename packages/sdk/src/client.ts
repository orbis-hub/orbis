import type { ComponentType, Context } from "react";
import type { Device, HubEvent, ModuleManifest, WidgetInstance } from "./index";
import type { Translator } from "./i18n";

export type { Messages, Translator, TranslateVars } from "./i18n";
export { createTranslator, localizeManifest, languageChain, pickLanguage } from "./i18n";

/** What the host (web app) exposes to module bundles at runtime via `window.__ORBIS__`. */
export type HostBridge = {
  React: typeof import("react");
  ReactDOM: Record<string, unknown>;
  jsxRuntime: typeof import("react/jsx-runtime");
  sdk: ClientSdk;
  ui: Record<string, unknown>;
};

export type WidgetProps<TConfig = Record<string, unknown>> = {
  instance: WidgetInstance;
  config: TConfig;
  /** Current rendered size in pixels (for responsive widget content). */
  size: { width: number; height: number };
  editing: boolean;
};

export type PageProps = {
  pageId: string;
  params: URLSearchParams;
};

export type SettingsProps<T = Record<string, unknown>> = {
  value: T;
  onChange(next: T): void;
};

export type ModuleClient = {
  widgets?: Record<string, ComponentType<WidgetProps<never>> | ComponentType<WidgetProps>>;
  pages?: Record<string, ComponentType<PageProps>>;
  /** Custom module settings UI; if absent the host renders a form from `settingsSchema`. */
  settings?: ComponentType<SettingsProps>;
  /** Custom per-widget config UI; if absent the host renders a form from `widget.configSchema`. */
  widgetConfig?: Record<string, ComponentType<SettingsProps>>;
};

export function defineClient(mod: ModuleClient): ModuleClient {
  return mod;
}

/** Context value provided by the host around every widget and page of a module. */
export type ModuleClientContext = {
  moduleId: string;
  manifest: ModuleManifest;
  /** Hub origin without trailing slash, e.g. http://192.168.1.20:3001 */
  hubUrl: string;
  /** Bearer token of the current session (null when the cookie is used). Append as ?token= for top-level navigations to the hub. */
  token: string | null;
  /** fetch against `/api/m/<moduleId>` with auth; path like "/items". */
  api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>;
  subscribe(cb: (ev: HubEvent) => void): () => void;
  settings: Record<string, unknown>;
  setSettings(patch: Record<string, unknown>): Promise<void>;
  devices: Device[];
  /** ui language of the hub, e.g. "de" */
  language: string;
  /** formatting locale (dates, numbers), e.g. "de-DE" */
  locale: string;
  /** hub timezone, e.g. "Europe/Berlin" */
  timezone: string;
  /** translate a key from this module's `locales/<lang>.json`; falls back to english, then the key */
  t: Translator;
};

export type ClientSdk = {
  ModuleContext: Context<ModuleClientContext | null>;
  useModule(): ModuleClientContext;
  useModuleApi(): ModuleClientContext["api"];
  useModuleEvents(name: string | null, cb: (payload: unknown) => void): void;
  useModuleSettings<T = Record<string, unknown>>(): [T, (patch: Partial<T>) => Promise<void>];
  useModuleDevices(): Device[];
  /** `const t = useT(); t("widget.today.empty")` */
  useT(): Translator;
  /** Polls/fetches module API data and refetches on the given module events. */
  useModuleQuery<T>(path: string, opts?: { refetchOn?: string[]; intervalMs?: number; enabled?: boolean }): {
    data: T | undefined;
    error: Error | null;
    loading: boolean;
    refetch: () => Promise<void>;
  };
};

declare global {
  interface Window {
    __ORBIS__?: HostBridge;
  }
}

/** Inside a module bundle: grab the host's React so there is exactly one React instance. */
export function host(): HostBridge {
  if (typeof window === "undefined" || !window.__ORBIS__) {
    throw new Error("@orbis/sdk/client: host bridge not found. Module client code must run inside the Orbis web app.");
  }
  return window.__ORBIS__;
}

/* ---------- hooks: thin delegates to the host's implementation (same React instance) ---------- */

export function useModule(): ModuleClientContext {
  return host().sdk.useModule();
}
export function useModuleApi(): ModuleClientContext["api"] {
  return host().sdk.useModuleApi();
}
export function useModuleEvents(name: string | null, cb: (payload: unknown) => void): void {
  return host().sdk.useModuleEvents(name, cb);
}
export function useModuleSettings<T = Record<string, unknown>>(): [T, (patch: Partial<T>) => Promise<void>] {
  return host().sdk.useModuleSettings<T>();
}
export function useModuleDevices(): Device[] {
  return host().sdk.useModuleDevices();
}
export function useT(): Translator {
  return host().sdk.useT();
}
export function useModuleQuery<T>(path: string, opts?: { refetchOn?: string[]; intervalMs?: number; enabled?: boolean }) {
  return host().sdk.useModuleQuery<T>(path, opts);
}
export function getModuleContext(): Context<ModuleClientContext | null> {
  return host().sdk.ModuleContext;
}
