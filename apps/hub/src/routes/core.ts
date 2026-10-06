import { Hono } from "hono";
import { z } from "zod";
import { isAdminRole, requireAuth, requireRole } from "../auth";
import * as dash from "../services/dashboards";
import * as devices from "../services/devices";
import { scanNetwork, scanStatus } from "../services/scanner";
import { getAllSettings, patchSettings } from "../services/settings";

const widgetInput = z.object({
  module: z.string(),
  widget: z.string(),
  x: z.number().int().min(0).default(0),
  y: z.number().int().min(0).default(0),
  w: z.number().int().min(1).max(12).default(3),
  h: z.number().int().min(1).max(24).default(2),
  config: z.record(z.string(), z.unknown()).default({}),
});

const layoutInput = z.array(z.object({ id: z.string(), x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1), h: z.number().int().min(1) }));

const settingsPatch = z
  .object({
    hubName: z.string().min(1).max(64),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "bcp-47 language tag"),
    locale: z.string(),
    timezone: z.string(),
    theme: z.enum(["system", "light", "dark"]),
    registries: z.array(z.string().url()),
    location: z.object({ lat: z.number(), lon: z.number(), name: z.string() }).nullable(),
    units: z.enum(["metric", "imperial"]),
    mutedModules: z.array(z.string()),
    notifyChannels: z.object({
      ntfy: z.object({ server: z.string().optional(), topic: z.string().min(1), token: z.string().optional(), minLevel: z.enum(["info", "warning", "urgent"]).optional() }).optional(),
      telegram: z.object({ botToken: z.string().min(1), chatId: z.string().min(1), minLevel: z.enum(["info", "warning", "urgent"]).optional() }).optional(),
    }),
  })
  .partial();

async function json<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T> | null> {
  const body = await c.req.json().catch(() => null);
  const r = schema.safeParse(body);
  return r.success ? r.data : null;
}

function fail(c: { json: (b: unknown, s: 400 | 403 | 404) => Response }, err: unknown) {
  const e = err as { status?: 403 | 404; message?: string };
  return c.json({ error: e.message ?? "error" }, e.status ?? 400);
}

export const settingsRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(getAllSettings()))
  .patch("/", requireRole("admin"), async (c) => {
    const body = await json(c, settingsPatch);
    if (!body) return c.json({ error: "invalid input" }, 400);
    return c.json(patchSettings(body));
  });

export const dashboardRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(dash.listDashboards(c.var.user)))
  .post("/", async (c) => {
    const body = await json(c, z.object({ name: z.string().min(1).max(64), icon: z.string().optional(), shared: z.boolean().optional(), accent: z.string().max(32).nullable().optional() }));
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
    const body = await json(c, z.object({ name: z.string().min(1).max(64).optional(), icon: z.string().nullable().optional(), shared: z.boolean().optional(), ownerId: z.string().nullable().optional(), access: z.array(z.string()).optional(), accent: z.string().max(32).nullable().optional() }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    try {
      dash.assertEdit(c.req.param("id"), c.var.user);
      if (body.ownerId !== undefined && !isAdminRole(c.var.user.role)) return c.json({ error: "only admins can transfer dashboards" }, 403);
      const { access, ...patch } = body;
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
    const body = await json(c, z.object({ ip: z.string().min(3), label: z.string().optional() }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    return c.json(devices.addManualDevice(body.ip, body.label ?? null), 201);
  })
  .patch("/:id", requireRole("admin"), async (c) => {
    const body = await json(c, z.object({ label: z.string().nullable().optional(), claimedBy: z.string().nullable().optional() }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    const id = c.req.param("id");
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
    devices.deleteDevice(c.req.param("id"));
    return c.json({ ok: true });
  });
