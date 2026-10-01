import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth";
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
    locale: z.string(),
    timezone: z.string(),
    theme: z.enum(["system", "light", "dark"]),
    registries: z.array(z.string().url()),
    location: z.object({ lat: z.number(), lon: z.number(), name: z.string() }).nullable(),
    units: z.enum(["metric", "imperial"]),
  })
  .partial();

async function json<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T> | null> {
  const body = await c.req.json().catch(() => null);
  const r = schema.safeParse(body);
  return r.success ? r.data : null;
}

export const settingsRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(getAllSettings()))
  .patch("/", async (c) => {
    const body = await json(c, settingsPatch);
    if (!body) return c.json({ error: "invalid input" }, 400);
    return c.json(patchSettings(body));
  });

export const dashboardRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(dash.listDashboards()))
  .post("/", async (c) => {
    const body = await json(c, z.object({ name: z.string().min(1).max(64), icon: z.string().optional() }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    return c.json(dash.createDashboard(body.name, body.icon ?? null), 201);
  })
  .post("/reorder", async (c) => {
    const body = await json(c, z.object({ ids: z.array(z.string()) }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    dash.reorderDashboards(body.ids);
    return c.json({ ok: true });
  })
  .get("/:id", (c) => {
    const d = dash.getDashboard(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .patch("/:id", async (c) => {
    const body = await json(c, z.object({ name: z.string().min(1).max(64).optional(), icon: z.string().nullable().optional() }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    const d = dash.updateDashboard(c.req.param("id"), body);
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .delete("/:id", (c) => {
    if (dash.listDashboards().length <= 1) return c.json({ error: "cannot delete the last dashboard" }, 400);
    dash.deleteDashboard(c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/:id/widgets", async (c) => {
    const body = await json(c, widgetInput);
    if (!body) return c.json({ error: "invalid input" }, 400);
    if (!dash.getDashboard(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    return c.json(dash.addWidget(c.req.param("id"), body), 201);
  })
  .put("/:id/layout", async (c) => {
    const body = await json(c, layoutInput);
    if (!body) return c.json({ error: "invalid input" }, 400);
    dash.saveLayout(c.req.param("id"), body);
    return c.json({ ok: true });
  })
  .patch("/:id/widgets/:wid", async (c) => {
    const body = await json(c, widgetInput.pick({ x: true, y: true, w: true, h: true, config: true }).partial());
    if (!body) return c.json({ error: "invalid input" }, 400);
    const w = dash.updateWidget(c.req.param("wid"), body);
    return w ? c.json(w) : c.json({ error: "not found" }, 404);
  })
  .delete("/:id/widgets/:wid", (c) => {
    dash.removeWidget(c.req.param("wid"));
    return c.json({ ok: true });
  });

export const deviceRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(devices.listDevices()))
  .get("/scan", (c) => c.json(scanStatus()))
  .post("/scan", (c) => {
    void scanNetwork();
    return c.json({ ok: true, ...scanStatus() }, 202);
  })
  .post("/", async (c) => {
    const body = await json(c, z.object({ ip: z.string().min(3), label: z.string().optional() }));
    if (!body) return c.json({ error: "invalid input" }, 400);
    return c.json(devices.addManualDevice(body.ip, body.label ?? null), 201);
  })
  .patch("/:id", async (c) => {
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
  .delete("/:id", (c) => {
    devices.deleteDevice(c.req.param("id"));
    return c.json({ ok: true });
  });
