import { isIP } from "node:net";
import { Hono } from "hono";
import { z } from "zod";
import { isAdminRole, requireAuth, requireRole } from "../auth";
import { errorStatus } from "../errors";
import * as runtime from "../modules/runtime";
import * as dash from "../services/dashboards";
import * as devices from "../services/devices";
import { scanNetwork, scanStatus } from "../services/scanner";
import { getSettingsFor, patchSettings } from "../services/settings";

/* ---------- dashboards validation (#37) ---------- */

/** grid bounds: 12 columns, rows up to 1000, a widget at most 12 wide and 24 high */
export const GRID = { cols: 12, maxY: 1000, maxH: 24 } as const;
const gridX = z.number().int().min(0).max(GRID.cols - 1);
const gridY = z.number().int().min(0).max(GRID.maxY);
const gridW = z.number().int().min(1).max(GRID.cols);
const gridH = z.number().int().min(1).max(GRID.maxH);
/** icon names are short identifiers ("home", "heart") */
const icon = z.string().max(32);

const widgetInput = z.object({
  module: z.string().min(1).max(64),
  widget: z.string().min(1).max(64),
  x: gridX.default(0),
  y: gridY.default(0),
  w: gridW.default(3),
  h: gridH.default(2),
  config: z.record(z.string(), z.unknown()).default({}),
});

const layoutInput = z.array(z.object({ id: z.string(), x: gridX, y: gridY, w: gridW, h: gridH })).max(500);

/** the widget must come from an installed, enabled module and be declared in its manifest */
export function widgetLookupError(moduleId: string, widgetId: string): { status: 404 | 400; error: string } | null {
  const s = runtime.get(moduleId);
  if (!s) return { status: 404, error: `module "${moduleId}" is not installed` };
  if (!s.enabled) return { status: 400, error: `module "${moduleId}" is disabled` };
  if (!s.manifest.widgets.some((w) => w.id === widgetId)) return { status: 404, error: `module "${moduleId}" has no widget "${widgetId}"` };
  return null;
}

/* ---------- hub settings validation (#42) ---------- */

/** a locale the runtime actually has data for ("xx" canonicalises fine but is not supported) */
export function isValidLocale(v: string) {
  try {
    const [canonical] = Intl.getCanonicalLocales(v);
    return !!canonical && Intl.DateTimeFormat.supportedLocalesOf([canonical]).length > 0;
  } catch {
    return false;
  }
}

let tzSet: Set<string> | null = null;
export function isValidTimezone(v: string) {
  if (!v) return false;
  try {
    tzSet ??= new Set(Intl.supportedValuesOf("timeZone"));
    if (tzSet.has(v)) return true;
  } catch {
    /* older runtime without supportedValuesOf */
  }
  // aliases like "UTC" or "Etc/GMT+1" are not in the list but still valid
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

export function isHttpUrl(v: string) {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

const httpUrl = (what: string) => z.string().max(2048).refine(isHttpUrl, `${what} must be an http(s) url`);
const minLevel = z.enum(["info", "warning", "urgent"]).optional();

export const settingsPatch = z
  .strictObject({
    hubName: z.string().min(1).max(64),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "bcp-47 language tag"),
    locale: z.string().max(35).refine(isValidLocale, "unknown locale (use a bcp-47 tag like de-DE or en-US)"),
    timezone: z.string().max(64).refine(isValidTimezone, "unknown time zone (use an IANA name like Europe/Berlin)"),
    theme: z.enum(["system", "light", "dark"]),
    registries: z.array(httpUrl("registry")).max(20),
    location: z
      .strictObject({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        name: z.string().max(128),
      })
      .nullable(),
    units: z.enum(["metric", "imperial"]),
    mutedModules: z.array(z.string().max(64)).max(200),
    notifyChannels: z.strictObject({
      ntfy: z
        .strictObject({
          // "" = default server (ntfy.sh)
          server: z.union([z.literal(""), httpUrl("ntfy server")]).optional(),
          topic: z.string().min(1).max(128),
          token: z.string().max(256).optional(),
          minLevel,
        })
        .optional(),
      telegram: z.strictObject({ botToken: z.string().min(1).max(256), chatId: z.string().min(1).max(64), minLevel }).optional(),
    }),
  })
  .partial();

/** one readable line per zod issue, unknown keys listed by name */
export function describeIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.map(String).join(".");
      if (i.code === "unrecognized_keys") return `unknown keys${path ? ` in ${path}` : ""}: ${(i as { keys: string[] }).keys.join(", ")}`;
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join("; ");
}

async function json<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T> | null> {
  const body = await c.req.json().catch(() => null);
  const r = schema.safeParse(body);
  return r.success ? r.data : null;
}

/* ---------- devices validation (#42) ---------- */

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.?$/i;
/** IPv4, IPv6 or a DNS hostname (RFC 1123 labels); anything else — including "999.999.999.999" — is rejected */
export function isValidHost(v: string) {
  if (isIP(v)) return true;
  if (/^\d+(\.\d+){3}$/.test(v)) return false; // looks like an ipv4 but isn't one
  return HOSTNAME_RE.test(v);
}

const deviceCreate = z.strictObject({
  ip: z.string().trim().min(1).max(253).refine(isValidHost, "ip must be an IPv4/IPv6 address or a hostname"),
  label: z.string().max(64).optional(),
});
const devicePatch = z.strictObject({
  label: z.string().max(64).nullable().optional(),
  claimedBy: z.string().max(64).nullable().optional(),
});

function fail(c: { json: (b: unknown, s: 400 | 401 | 403 | 404 | 409 | 429) => Response }, err: unknown) {
  return c.json({ error: (err as Error).message ?? "error" }, errorStatus(err));
}

/** GET: admins see everything, members the safe subset (no notification tokens, no registries). PATCH: admins only. */
export const settingsRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(getSettingsFor(c.var.user.role)))
  .patch("/", requireRole("admin"), async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error: "invalid input: expected a json object" }, 400);
    const r = settingsPatch.safeParse(raw);
    if (!r.success) return c.json({ error: `invalid settings: ${describeIssues(r.error)}` }, 400);
    return c.json(patchSettings(r.data));
  });

export const dashboardRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(dash.listDashboards(c.var.user)))
  .post("/", async (c) => {
    const body = await json(c, z.object({ name: z.string().min(1).max(64), icon: icon.optional(), shared: z.boolean().optional(), accent: z.string().max(32).nullable().optional() }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    // members create private dashboards by default, admins shared ones
    const shared = body.shared ?? isAdminRole(c.var.user.role);
    const created = dash.createDashboard(body.name, body.icon ?? null, c.var.user, shared);
    if (body.accent) dash.updateDashboard(created.id, { accent: body.accent }, c.var.user);
    return c.json(dash.getDashboard(created.id, c.var.user) ?? created, 201);
  })
  .post("/reorder", async (c) => {
    const body = await json(c, z.object({ ids: z.array(z.string()) }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    const editable = new Set(dash.listDashboards(c.var.user).filter((d) => d.canEdit).map((d) => d.id));
    dash.reorderDashboards(body.ids.filter((id) => editable.has(id)));
    return c.json({ ok: true });
  })
  .get("/:id", (c) => {
    const d = dash.getDashboard(c.req.param("id"), c.var.user);
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .patch("/:id", async (c) => {
    const body = await json(c, z.object({ name: z.string().min(1).max(64).optional(), icon: icon.nullable().optional(), shared: z.boolean().optional(), ownerId: z.string().nullable().optional(), access: z.array(z.string()).max(500).optional(), accent: z.string().max(32).nullable().optional() }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    try {
      dash.assertEdit(c.req.param("id"), c.var.user);
      if (body.ownerId !== undefined && !isAdminRole(c.var.user.role)) return c.json({ error: "only admins can transfer dashboards" }, 403);
      const { access, ...patch } = body;
      // updateDashboard is a no-op for an empty patch, so {access:[...]} alone works
      let d = dash.updateDashboard(c.req.param("id"), patch, c.var.user);
      if (access) d = dash.setAccess(c.req.param("id"), access, c.var.user);
      return c.json(d);
    } catch (err) {
      return fail(c, err);
    }
  })
  .delete("/:id", (c) => {
    try {
      dash.assertEdit(c.req.param("id"), c.var.user);
      if (dash.listDashboards().length <= 1) return c.json({ error: "cannot delete the last dashboard" }, 400);
      dash.deleteDashboard(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  })
  .post("/:id/widgets", async (c) => {
    const body = await json(c, widgetInput);
    if (!body) return c.json({ error: "invalid input" }, 400);
    try {
      dash.assertEdit(c.req.param("id"), c.var.user);
      const bad = widgetLookupError(body.module, body.widget);
      if (bad) return c.json({ error: bad.error }, bad.status);
      return c.json(dash.addWidget(c.req.param("id"), body), 201);
    } catch (err) {
      return fail(c, err);
    }
  })
  .put("/:id/layout", async (c) => {
    const body = await json(c, layoutInput);
    if (!body) return c.json({ error: "invalid input" }, 400);
    try {
      dash.assertEdit(c.req.param("id"), c.var.user);
      dash.saveLayout(c.req.param("id"), body);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  })
  .patch("/:id/widgets/:wid", async (c) => {
    const body = await json(c, widgetInput.pick({ x: true, y: true, w: true, h: true, config: true }).partial());
    if (!body) return c.json({ error: "invalid input" }, 400);
    try {
      dash.assertEdit(c.req.param("id"), c.var.user);
      if (dash.widgetDashboard(c.req.param("wid")) !== c.req.param("id")) return c.json({ error: "not found" }, 404);
      const w = dash.updateWidget(c.req.param("wid"), body);
      return w ? c.json(w) : c.json({ error: "not found" }, 404);
    } catch (err) {
      return fail(c, err);
    }
  })
  .delete("/:id/widgets/:wid", (c) => {
    try {
      dash.assertEdit(c.req.param("id"), c.var.user);
      if (dash.widgetDashboard(c.req.param("wid")) !== c.req.param("id")) return c.json({ error: "not found" }, 404);
      dash.removeWidget(c.req.param("wid"));
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });

export const deviceRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(devices.listDevices()))
  .get("/scan", (c) => c.json(scanStatus()))
  .post("/scan", requireRole("admin"), (c) => {
    void scanNetwork();
    return c.json({ ok: true, ...scanStatus() }, 202);
  })
  .post("/", requireRole("admin"), async (c) => {
    const r = deviceCreate.safeParse(await c.req.json().catch(() => null));
    if (!r.success) return c.json({ error: `invalid input: ${describeIssues(r.error)}` }, 400);
    const ip = isIP(r.data.ip) ? r.data.ip : r.data.ip.toLowerCase();
    // a second POST with the same ip used to merge into (and relabel) the existing device silently
    const dup = devices.listDevices().find((d) => d.ip === ip);
    if (dup) return c.json({ error: `a device with ip ${ip} already exists`, id: dup.id }, 409);
    return c.json(devices.addManualDevice(ip, r.data.label ?? null), 201);
  })
  .patch("/:id", requireRole("admin"), async (c) => {
    const r = devicePatch.safeParse(await c.req.json().catch(() => null));
    if (!r.success) return c.json({ error: `invalid input: ${describeIssues(r.error)}` }, 400);
    const body = r.data;
    const id = c.req.param("id");
    if (!devices.getDevice(id)) return c.json({ error: "not found" }, 404);
    if (body.claimedBy) {
      const mod = runtime.get(body.claimedBy);
      if (!mod?.loaded) return c.json({ error: `claimedBy: "${body.claimedBy}" is not a loaded module` }, 400);
    }
    if (body.label !== undefined) devices.labelDevice(id, body.label);
    if (body.claimedBy !== undefined) {
      if (body.claimedBy === null) devices.releaseDevice(id);
      else {
        devices.releaseDevice(id);
        devices.claimDevice(id, body.claimedBy);
      }
    }
    const d = devices.getDevice(id);
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .delete("/:id", requireRole("admin"), (c) => {
    if (!devices.getDevice(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    devices.deleteDevice(c.req.param("id"));
    return c.json({ ok: true });
  });
