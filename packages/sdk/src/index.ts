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
  | { type: "notification"; notification: Notification; unread: number }
  | { type: "notifications:changed"; unread: number }
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
  /** accent preset id (see ACCENTS in @orbis/ui) or null for the hub default */
  accent: string | null;
};

/** What a module reports about itself: shown on the module card and counted in the sidebar. */
export type ModuleStatus = {
  state: "ok" | "needs-setup" | "warning" | "error";
  message?: string;
  /** where the user should go to fix it */
  action?: { label: string; page?: string; settings?: boolean };
};

export type InstalledModule = {
  id: string;
  version: string;
  enabled: boolean;
  source: "builtin" | "registry" | "dev" | "url";
  manifest: import("./manifest").ModuleManifest;
  error: string | null;
  installedAt: string;
  /** changes on every (re)load; clients use it to bust their bundle cache */
  loadedAt: string | null;
  status: ModuleStatus | null;
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
  /** mirror of the manifest's deps / softDeps so the store can show them before installing */
  deps?: string[];
  softDeps?: string[];
};

export type RegistryIndex = {
  name: string;
  modules: RegistryEntry[];
};

export type EinkDisplay = {
  id: string;
  name: string;
  width: number;
  height: number;
  dashboardId: string | null;
  rotate: 0 | 90 | 180 | 270;
  invert: boolean;
  grayscale: number;
  refreshMinutes: number;
  board: string | null;
  lastSeen: string | null;
  battery: number | null;
  createdAt: string;
  /** only returned to admins on create / token rotate */
  token?: string;
};

export type NotificationLevel = "info" | "warning" | "urgent";

export type NotificationInput = {
  title: string;
  body?: string;
  /** where a click should go: an app route like "/m/?id=todo&page=tasks" or an external url */
  url?: string;
  level?: NotificationLevel;
  /** pixel icon name */
  icon?: string;
  /** same module + key replaces the previous notification instead of adding one (e.g. "task-due:<id>") */
  key?: string;
};

export type Notification = {
  id: string;
  module: string;
  key: string | null;
  title: string;
  body: string | null;
  url: string | null;
  level: NotificationLevel;
  icon: string | null;
  createdAt: string;
  readAt: string | null;
};
