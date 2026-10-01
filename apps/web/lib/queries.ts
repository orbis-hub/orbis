"use client";

import type { Dashboard, Device, HubEvent, InstalledModule, RegistryEntry, WidgetInstance } from "@orbis/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { hubFetch, subscribeHub } from "./hub";

export type AuthStatus = { setup: boolean; authenticated: boolean; user: { id: string; name: string; role: string } | null; hubVersion: string };
export type HubSettings = {
  hubName: string;
  locale: string;
  timezone: string;
  theme: "system" | "light" | "dark";
  registries: string[];
  location: { lat: number; lon: number; name: string } | null;
  units: "metric" | "imperial";
};
export type RegistryModule = RegistryEntry & { registry: string; installedVersion: string | null; deps?: string[]; softDeps?: string[] };
export type RegistryResponse = { registries: string[]; errors: Array<{ url: string; error: string }>; modules: RegistryModule[] };

export const qk = {
  auth: ["auth"] as const,
  settings: ["settings"] as const,
  dashboards: ["dashboards"] as const,
  modules: ["modules"] as const,
  module: (id: string) => ["modules", id] as const,
  registry: ["registry"] as const,
  devices: ["devices"] as const,
  users: ["users"] as const,
};

export function useAuthStatus(enabled = true) {
  return useQuery({ queryKey: qk.auth, queryFn: () => hubFetch<AuthStatus>("/api/auth/status"), enabled, retry: false, staleTime: 30_000 });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: () => hubFetch<HubSettings>("/api/settings"), staleTime: 60_000 });
}

export function useDashboards() {
  return useQuery({ queryKey: qk.dashboards, queryFn: () => hubFetch<Dashboard[]>("/api/dashboards"), staleTime: 30_000 });
}

export function useModules() {
  return useQuery({ queryKey: qk.modules, queryFn: () => hubFetch<InstalledModule[]>("/api/modules"), staleTime: 60_000 });
}

export function useModuleDetail(id: string | null) {
  return useQuery({
    queryKey: qk.module(id ?? "-"),
    queryFn: () => hubFetch<InstalledModule & { settings: Record<string, unknown> }>(`/api/modules/${id}`),
    enabled: !!id,
  });
}

export function useRegistry(refresh = false) {
  return useQuery({ queryKey: [...qk.registry, refresh], queryFn: () => hubFetch<RegistryResponse>(`/api/modules/registry${refresh ? "?refresh=1" : ""}`), staleTime: 5 * 60_000 });
}

export function useDevices() {
  return useQuery({ queryKey: qk.devices, queryFn: () => hubFetch<Device[]>("/api/devices"), staleTime: 30_000 });
}

/** Invalidate react-query caches when the hub pushes change events. Mount once in the shell. */
export function useHubEventsSync() {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeHub((ev: HubEvent) => {
      switch (ev.type) {
        case "dashboards:changed":
          void qc.invalidateQueries({ queryKey: qk.dashboards });
          break;
        case "modules:changed":
          void qc.invalidateQueries({ queryKey: qk.modules });
          void qc.invalidateQueries({ queryKey: qk.registry });
          break;
        case "devices:changed":
          void qc.invalidateQueries({ queryKey: qk.devices });
          break;
        case "settings:changed":
          void qc.invalidateQueries({ queryKey: qk.settings });
          break;
        case "users:changed":
          void qc.invalidateQueries({ queryKey: qk.users });
          void qc.invalidateQueries({ queryKey: qk.dashboards });
          break;
        case "module:event":
          if (ev.name === "$settings") void qc.invalidateQueries({ queryKey: qk.module(ev.module) });
          break;
      }
    });
  }, [qc]);
}

/* ---------- mutations ---------- */

export function useInvalidate() {
  const qc = useQueryClient();
  return (key: readonly unknown[]) => qc.invalidateQueries({ queryKey: key });
}

export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<HubSettings>) => hubFetch<HubSettings>("/api/settings", { method: "PATCH", json: patch }),
    onSuccess: (data) => qc.setQueryData(qk.settings, data),
  });
}

export function useDashboardMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: qk.dashboards });
  return {
    create: useMutation({ mutationFn: (input: { name: string; icon?: string; shared?: boolean }) => hubFetch<Dashboard>("/api/dashboards", { method: "POST", json: input }), onSuccess: inv }),
    update: useMutation({
      mutationFn: ({ id, ...patch }: { id: string; name?: string; icon?: string | null; shared?: boolean; ownerId?: string | null; access?: string[] }) => hubFetch<Dashboard>(`/api/dashboards/${id}`, { method: "PATCH", json: patch }),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => hubFetch(`/api/dashboards/${id}`, { method: "DELETE" }), onSuccess: inv }),
    reorder: useMutation({ mutationFn: (ids: string[]) => hubFetch("/api/dashboards/reorder", { method: "POST", json: { ids } }), onSuccess: inv }),
    addWidget: useMutation({
      mutationFn: ({ dashboardId, ...w }: { dashboardId: string } & Omit<WidgetInstance, "id">) => hubFetch<WidgetInstance>(`/api/dashboards/${dashboardId}/widgets`, { method: "POST", json: w }),
      onSuccess: inv,
    }),
    updateWidget: useMutation({
      mutationFn: ({ dashboardId, id, ...patch }: { dashboardId: string; id: string } & Partial<Pick<WidgetInstance, "x" | "y" | "w" | "h" | "config">>) =>
        hubFetch<WidgetInstance>(`/api/dashboards/${dashboardId}/widgets/${id}`, { method: "PATCH", json: patch }),
      onSuccess: inv,
    }),
    removeWidget: useMutation({ mutationFn: ({ dashboardId, id }: { dashboardId: string; id: string }) => hubFetch(`/api/dashboards/${dashboardId}/widgets/${id}`, { method: "DELETE" }), onSuccess: inv }),
    saveLayout: useMutation({
      mutationFn: ({ dashboardId, layout }: { dashboardId: string; layout: Array<{ id: string; x: number; y: number; w: number; h: number }> }) =>
        hubFetch(`/api/dashboards/${dashboardId}/layout`, { method: "PUT", json: layout }),
      // layout saves are frequent; the WS event will refresh
    }),
  };
}

export function useModuleMutations() {
  const qc = useQueryClient();
  const inv = () => {
    void qc.invalidateQueries({ queryKey: qk.modules });
    void qc.invalidateQueries({ queryKey: qk.registry });
  };
  return {
    install: useMutation({ mutationFn: (input: { id?: string; url?: string; version?: string }) => hubFetch<InstalledModule & { installedDeps?: string[] }>("/api/modules/install", { method: "POST", json: input }), onSuccess: inv }),
    setEnabled: useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => hubFetch<InstalledModule>(`/api/modules/${id}`, { method: "PATCH", json: { enabled } }), onSuccess: inv }),
    reload: useMutation({ mutationFn: (id: string) => hubFetch<InstalledModule>(`/api/modules/${id}/reload`, { method: "POST" }), onSuccess: inv }),
    uninstall: useMutation({ mutationFn: (id: string) => hubFetch(`/api/modules/${id}`, { method: "DELETE" }), onSuccess: inv }),
    patchSettings: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => hubFetch<Record<string, unknown>>(`/api/modules/${id}/settings`, { method: "PATCH", json: patch }),
      onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: qk.module(v.id) }),
    }),
  };
}

export function useDeviceMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: qk.devices });
  return {
    add: useMutation({ mutationFn: (input: { ip: string; label?: string }) => hubFetch<Device>("/api/devices", { method: "POST", json: input }), onSuccess: inv }),
    update: useMutation({ mutationFn: ({ id, ...patch }: { id: string; label?: string | null; claimedBy?: string | null }) => hubFetch<Device>(`/api/devices/${id}`, { method: "PATCH", json: patch }), onSuccess: inv }),
    remove: useMutation({ mutationFn: (id: string) => hubFetch(`/api/devices/${id}`, { method: "DELETE" }), onSuccess: inv }),
    scan: useMutation({ mutationFn: () => hubFetch<{ ok: boolean }>("/api/devices/scan", { method: "POST" }), onSuccess: inv }),
  };
}

/* ---------- users / accounts ---------- */

export type Role = "owner" | "admin" | "member";
export type PublicUser = { id: string; name: string; role: Role; disabled: boolean; createdAt: string; sessions: number };
export const isAdminRole = (role: string | undefined) => role === "owner" || role === "admin";

export function useUsers(enabled = true) {
  return useQuery({ queryKey: qk.users, queryFn: () => hubFetch<PublicUser[]>("/api/users"), enabled, staleTime: 30_000 });
}

export function useUserMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: qk.users });
  return {
    create: useMutation({ mutationFn: (input: { name: string; password: string; role?: Role }) => hubFetch<PublicUser>("/api/users", { method: "POST", json: input }), onSuccess: inv }),
    update: useMutation({ mutationFn: ({ id, ...patch }: { id: string; name?: string; role?: Role; disabled?: boolean }) => hubFetch<PublicUser>(`/api/users/${id}`, { method: "PATCH", json: patch }), onSuccess: inv }),
    resetPassword: useMutation({ mutationFn: ({ id, password }: { id: string; password: string }) => hubFetch(`/api/users/${id}/password`, { method: "POST", json: { password } }), onSuccess: inv }),
    logoutAll: useMutation({ mutationFn: (id: string) => hubFetch(`/api/users/${id}/logout`, { method: "POST" }), onSuccess: inv }),
    remove: useMutation({ mutationFn: (id: string) => hubFetch(`/api/users/${id}`, { method: "DELETE" }), onSuccess: inv }),
    updateMe: useMutation({ mutationFn: (input: { name: string }) => hubFetch<PublicUser>("/api/users/me", { method: "PATCH", json: input }), onSuccess: () => { inv(); void qc.invalidateQueries({ queryKey: qk.auth }); } }),
    changePassword: useMutation({ mutationFn: (input: { current: string; password: string }) => hubFetch<{ ok: boolean; reauth: boolean }>("/api/users/me/password", { method: "POST", json: input }) }),
  };
}
