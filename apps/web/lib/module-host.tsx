"use client";

import { createTranslator, languageChain, type Device, type HubEvent, type InstalledModule, type Messages, type Translator } from "@orbis/sdk";
import type { ClientSdk, HostBridge, ModuleClient, ModuleClientContext } from "@orbis/sdk/client";
import { defineClient, host, localizeManifest, pickLanguage } from "@orbis/sdk/client";
import * as ui from "@orbis/ui";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getHubUrl, getToken, hubAbs, hubFetch, subscribeHub } from "./hub";
import { useLanguage, useLocale } from "./i18n";
import { useDevices, useModuleDetail, useModuleMutations, useSettings } from "./queries";

/* ---------- the SDK implementation the host provides to module bundles ---------- */

const ModuleContext = createContext<ModuleClientContext | null>(null);

function useModule(): ModuleClientContext {
  const ctx = useContext(ModuleContext);
  if (!ctx) throw new Error("useModule() outside of a module context");
  return ctx;
}

function useModuleApi() {
  return useModule().api;
}

function useModuleEvents(name: string | null, cb: (payload: unknown) => void) {
  const { subscribe } = useModule();
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (name === null) return;
    return subscribe((ev) => {
      if (ev.type === "module:event" && ev.name === name) ref.current(ev.payload);
    });
  }, [name, subscribe]);
}

function useModuleSettings<T = Record<string, unknown>>(): [T, (patch: Partial<T>) => Promise<void>] {
  const { settings, setSettings } = useModule();
  return [settings as T, (patch) => setSettings(patch as Record<string, unknown>)];
}

function useModuleDevices(): Device[] {
  return useModule().devices;
}

function useT(): Translator {
  return useModule().t;
}

function useModuleQuery<T>(path: string, opts: { refetchOn?: string[]; intervalMs?: number; enabled?: boolean } = {}) {
  const { api, subscribe } = useModule();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const enabled = opts.enabled ?? true;
  const refetch = useCallback(async () => {
    if (!enabled) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [api, path, enabled]);
  useEffect(() => {
    void refetch();
  }, [refetch]);
  useEffect(() => {
    if (!opts.intervalMs) return;
    const t = setInterval(() => void refetch(), opts.intervalMs);
    return () => clearInterval(t);
  }, [opts.intervalMs, refetch]);
  const on = opts.refetchOn?.join("|") ?? "";
  useEffect(() => {
    if (!on) return;
    const names = new Set(on.split("|"));
    return subscribe((ev) => {
      if (ev.type === "module:event" && names.has(ev.name)) void refetch();
    });
  }, [on, subscribe, refetch]);
  return { data, error, loading, refetch };
}

const sdk: ClientSdk = { ModuleContext, useModule, useModuleApi, useModuleEvents, useModuleSettings, useModuleDevices, useModuleQuery, useT };

/* ---------- module translations: /modules/<id>/locales/<lang>.json, cached per module version ---------- */

const localeCache = new Map<string, Promise<Messages>>();

function fetchLocale(mod: InstalledModule, lang: string): Promise<Messages> {
  const key = `${mod.id}@${mod.version}@${mod.loadedAt ?? ""}:${lang}`;
  let p = localeCache.get(key);
  if (!p) {
    p = fetch(hubAbs(`/modules/${mod.id}/locales/${lang}.json?v=${encodeURIComponent(mod.version)}`))
      .then((r) => (r.ok ? (r.json() as Promise<Messages>) : {}))
      .catch(() => ({}));
    localeCache.set(key, p);
  }
  return p;
}

/** translator for a module in the given language (bundles for the fallback chain are loaded once per module version) */
export function useModuleTranslator(mod: InstalledModule | undefined, language: string): Translator & { language: string } {
  // which of the chain's languages the module actually ships, as a stable string so effects don't re-run per render
  const wantedKey = mod ? languageChain(language).filter((l) => (mod.manifest.languages ?? []).includes(l)).join(",") : "";
  const key = mod ? `${mod.id}@${mod.version}@${mod.loadedAt ?? ""}:${wantedKey}` : "";
  const [loaded, setLoaded] = useState<{ key: string; bundles: Record<string, Messages> }>({ key: "", bundles: {} });
  useEffect(() => {
    if (!mod || !wantedKey) return;
    let alive = true;
    Promise.all(wantedKey.split(",").map((l) => fetchLocale(mod, l).then((m) => [l, m] as const))).then((pairs) => {
      if (alive) setLoaded((prev) => (prev.key === key ? prev : { key, bundles: Object.fromEntries(pairs) }));
    });
    return () => {
      alive = false;
    };
  }, [mod, key, wantedKey]);
  const bundles = loaded.key === key ? loaded.bundles : undefined;
  return useMemo(() => createTranslator(language, bundles ?? {}), [language, bundles]);
}

export { localizeManifest, pickLanguage };

export function installHostBridge() {
  if (typeof window === "undefined") return;
  const bridge: HostBridge = {
    React,
    ReactDOM: ReactDOM as unknown as Record<string, unknown>,
    jsxRuntime,
    sdk: { ...sdk, host, defineClient } as ClientSdk,
    ui: ui as unknown as Record<string, unknown>,
  };
  window.__ORBIS__ = bridge;
}

/* ---------- loading module client bundles ---------- */

const bundleCache = new Map<string, Promise<ModuleClient>>();

export function loadModuleClient(mod: InstalledModule): Promise<ModuleClient> {
  const entry = mod.manifest.entry.client;
  if (!entry) return Promise.resolve({});
  const key = `${mod.id}@${mod.version}@${mod.loadedAt ?? ""}`;
  let p = bundleCache.get(key);
  if (!p) {
    installHostBridge();
    const url = hubAbs(`/modules/${mod.id}/${entry}?v=${encodeURIComponent(mod.version)}&l=${encodeURIComponent(mod.loadedAt ?? "")}`);
    p = import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)
      .then((m) => (m.default ?? m) as ModuleClient)
      .catch((err) => {
        bundleCache.delete(key);
        throw err;
      });
    bundleCache.set(key, p);
  }
  return p;
}

export function evictModuleClient(id: string) {
  for (const k of bundleCache.keys()) if (k.startsWith(`${id}@`)) bundleCache.delete(k);
}

export function useModuleClient(mod: InstalledModule | undefined) {
  const [state, setState] = useState<{ client?: ModuleClient; error?: Error; key?: string }>({});
  const key = mod ? `${mod.id}@${mod.version}@${mod.loadedAt ?? ""}:${mod.enabled}` : undefined;
  useEffect(() => {
    if (!mod || !mod.enabled) return;
    let alive = true;
    loadModuleClient(mod)
      .then((client) => alive && setState({ client, key }))
      .catch((error) => alive && setState({ error, key }));
    return () => {
      alive = false;
    };
  }, [mod, key]);
  return state.key === key ? state : {};
}

/* ---------- context provider around widgets/pages ---------- */

export function ModuleProvider({ mod, children }: { mod: InstalledModule; children: ReactNode }) {
  const detail = useModuleDetail(mod.id);
  const { patchSettings } = useModuleMutations();
  const devicesQ = useDevices();
  const hubSettings = useSettings();
  const language = useLanguage();
  const locale = useLocale();
  const timezone = hubSettings.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const t = useModuleTranslator(mod, language);
  const settings = detail.data?.settings ?? {};
  const devices = devicesQ.data ?? [];

  const value = useMemo<ModuleClientContext>(
    () => ({
      moduleId: mod.id,
      manifest: mod.manifest,
      hubUrl: (getHubUrl() ?? "").replace(/\/+$/, ""),
      token: getToken(),
      api: (path, init) => hubFetch(`/api/m/${mod.id}${path.startsWith("/") ? path : `/${path}`}`, init),
      subscribe: (cb) => subscribeHub((ev: HubEvent) => (ev.type !== "module:event" || ev.module === mod.id) && cb(ev)),
      settings,
      setSettings: async (patch) => {
        await patchSettings.mutateAsync({ id: mod.id, patch });
      },
      devices,
      language,
      locale,
      timezone,
      t,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.id, mod.manifest, settings, devices, patchSettings.mutateAsync, language, locale, timezone, t],
  );
  return <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>;
}
