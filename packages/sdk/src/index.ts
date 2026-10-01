export * from "./manifest";

/** A device the hub found on the local network. */
export type Device = {
  id: string;
  ip: string;
  mac: string | null;
  hostname: string | null;
  vendor: string | null;
  services: DeviceService[];
  firstSeen: string;
  lastSeen: string;
  online: boolean;
  /** Module id that claimed this device, if any. */
  claimedBy: string | null;
  label: string | null;
};

export type DeviceService = {
  kind: "mdns" | "ssdp" | "port";
  name: string;
  port?: number;
  txt?: Record<string, string>;
};

/** Events flow hub → clients over the websocket. */
export type HubEvent =
  | { type: "module:event"; module: string; name: string; payload: unknown }
  | { type: "modules:changed" }
  | { type: "devices:changed" }
  | { type: "dashboards:changed"; dashboardId?: string }
  | { type: "settings:changed"; key?: string }
  | { type: "users:changed" }
  | { type: "hello"; hubVersion: string };

export type WidgetInstance = {
  id: string;
  module: string;
  widget: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
};

export type Dashboard = {
  id: string;
  name: string;
  icon: string | null;
  sort: number;
  widgets: WidgetInstance[];
  /** user id of the creator; null for hub-level dashboards */
  ownerId: string | null;
  /** visible to every account */
  shared: boolean;
  /** explicit grants when not shared */
  access: string[];
  /** can the requesting user edit it */
  canEdit: boolean;
};

export type InstalledModule = {
  id: string;
  version: string;
  enabled: boolean;
  source: "builtin" | "registry" | "dev" | "url";
  manifest: import("./manifest").ModuleManifest;
  error: string | null;
  installedAt: string;
};

export type RegistryEntry = {
  id: string;
  name: string;
  description: string;
  repo: string;
  latest: string;
  tags?: string[];
  author?: string;
  icon?: string;
  /** Direct tarball URL. If omitted the hub derives it from repo + latest. */
  tarball?: string;
};

export type RegistryIndex = {
  name: string;
  modules: RegistryEntry[];
};
