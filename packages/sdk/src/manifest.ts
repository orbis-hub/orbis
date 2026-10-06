import { z } from "zod";

/** Grid units: the dashboard is 12 columns wide, one row is ~60px. */
export const sizeSchema = z.object({
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
});

export const widgetDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  defaultSize: sizeSchema.default({ w: 3, h: 2 }),
  minSize: sizeSchema.default({ w: 1, h: 1 }),
  maxSize: sizeSchema.optional(),
  /** JSON schema for per-widget-instance config (rendered by the host as a form). */
  configSchema: z.record(z.string(), z.unknown()).optional(),
  /** Hide the window chrome (title bar) around this widget. */
  chromeless: z.boolean().default(false),
});

export const pageDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  icon: z.string().optional(),
});

/** How the hub matches discovered network devices to this module. */
export const discoveryMatcherSchema = z.object({
  mdns: z.array(z.string()).optional(),
  ssdp: z.array(z.string()).optional(),
  /** OUI vendor substrings, e.g. "Shelly", "Philips". */
  vendor: z.array(z.string()).optional(),
  /** Hostname regex. */
  hostname: z.string().optional(),
});

/**
 * `network:fetch` – outbound http(s) via `ctx.fetch` to public hosts; loopback, link-local, private (rfc1918/ula) and
 * cloud-metadata addresses are refused. `network:lan` – additionally allows those local ranges (home-assistant, shelly…).
 */
export const permissionSchema = z.enum([
  "network:fetch",
  "network:lan",
  "network:scan",
  "devices:read",
  "devices:claim",
  "storage",
  "scheduler",
  "settings:read",
  "notifications",
]);

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  description: z.string().default(""),
  author: z.string().optional(),
  repo: z.string().optional(),
  homepage: z.string().optional(),
  minHub: z.string().default("0.1.0"),
  icon: z.string().optional(),
  entry: z.object({
    server: z.string().optional(),
    client: z.string().optional(),
  }),
  widgets: z.array(widgetDefSchema).default([]),
  pages: z.array(pageDefSchema).default([]),
  settingsSchema: z.record(z.string(), z.unknown()).optional(),
  permissions: z.array(permissionSchema).default([]),
  discovery: discoveryMatcherSchema.optional(),
  /** Modules that must be installed and enabled for this one to load (hard dependency). The store installs them along. */
  deps: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
  /** Modules this one can use when present (optional feature), e.g. "home-assistant" for media players. Shown in the store, never required. */
  softDeps: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
  /** Module http paths (prefix match, relative to /api/m/<id>) that need no session, e.g. oauth callbacks. */
  publicPaths: z.array(z.string().regex(/^\//)).default([]),
  eink: z.boolean().default(false),
  /**
   * Languages this module ships translations for (bcp-47 tags like "en", "de", "pt-BR"). Each needs a
   * `locales/<lang>.json` next to module.json; `orbis-module build` copies them to `dist/locales/`.
   * English is the fallback and should be present whenever the list is non-empty.
   */
  languages: z.array(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)).default([]),
});

export type ModuleManifest = z.infer<typeof manifestSchema>;
export type ModuleManifestInput = z.input<typeof manifestSchema>;
export type WidgetDef = z.infer<typeof widgetDefSchema>;
export type PageDef = z.infer<typeof pageDefSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type DiscoveryMatcher = z.infer<typeof discoveryMatcherSchema>;

export function parseManifest(input: unknown): ModuleManifest {
  return manifestSchema.parse(input);
}

export function safeParseManifest(input: unknown) {
  return manifestSchema.safeParse(input);
}
