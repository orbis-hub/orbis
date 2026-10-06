import { Hono } from "hono";
import { z } from "zod";
import { isAdminRole, requireAuth, requireRole } from "../auth";
import { getDashboard } from "../services/dashboards";
import * as eink from "../services/eink";

const displayInput = z.strictObject({
  name: z.string().min(1).max(64),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  dashboardId: z.string().min(1).max(64).nullable().optional(),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  invert: z.boolean().optional(),
  grayscale: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(),
  refreshMinutes: z.number().int().min(1).max(1440).optional(),
  board: z.string().max(eink.BOARD_MAX).nullable().optional(),
});

/** a dashboard a display is attached to has to exist (#40) */
function badDashboard(dashboardId: string | null | undefined) {
  return typeof dashboardId === "string" && !eink.dashboardExists(dashboardId) ? `unknown dashboard "${dashboardId}"` : null;
}

/** admin management under /api/eink/displays */
export const einkAdminRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(eink.listDisplays()))
  .post("/", requireRole("admin"), async (c) => {
    const body = displayInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    const bad = badDashboard(body.data.dashboardId);
    if (bad) return c.json({ error: bad }, 400);
    return c.json(eink.createDisplay(body.data), 201);
  })
  .get("/:id", requireRole("admin"), (c) => {
    const d = eink.getDisplay(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .patch("/:id", requireRole("admin"), async (c) => {
    const body = displayInput.partial().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    const bad = badDashboard(body.data.dashboardId);
    if (bad) return c.json({ error: bad }, 400);
    if (!eink.getDisplay(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    const d = eink.updateDisplay(c.req.param("id"), body.data);
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .post("/:id/token", requireRole("admin"), (c) => {
    const d = eink.rotateToken(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .delete("/:id", requireRole("admin"), (c) => {
    return eink.deleteDisplay(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  })
  /** preview for the settings page (session auth, png): admins, or anyone who may see the attached dashboard */
  .get("/:id/preview.png", async (c) => {
    const d = eink.getDisplay(c.req.param("id"));
    if (!d) return c.text("not found", 404);
    if (!isAdminRole(c.var.user.role)) {
      // a display without a dashboard (or with one you cannot see) is not yours to look at
      if (!d.dashboardId || !getDashboard(d.dashboardId, c.var.user)) return c.json({ error: "forbidden" }, 403);
    }
    const r = await eink.renderDisplay(d, { format: "png" });
    c.header("content-type", r.contentType);
    c.header("cache-control", "no-store");
    return c.body(new Uint8Array(r.body));
  });

/**
 * Device endpoints under /api/eink – token auth (header `authorization: Bearer <token>` or `?token=`), no session.
 *   GET /<id>.bin   packed pixels for the firmware ("ORB1" header)
 *   GET /<id>.png   grayscale png (debugging, other displays)
 *   GET /<id>.bmp   1-bit bmp
 *   GET /<id>.svg   the vector source
 *   GET /<id>/config  what the device should know (size, refresh)
 *   POST /<id>/tap { x, y }  touch → (later) widget actions; today it just triggers a re-render
 */
export const einkDeviceRoutes = new Hono()
  .use(async (c, next) => {
    const auth = c.req.header("authorization");
    const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : c.req.query("token");
    if (!token) return c.json({ error: "token required" }, 401);
    const d = eink.findByToken(token);
    // the token must belong to the display named in the path (/<id>.bin, /<id>/config, /<id>/tap)
    const segs = c.req.path.split("/").filter(Boolean);
    if (!d || !segs.some((p) => p === d.id || p.startsWith(`${d.id}.`))) return c.json({ error: "unknown display or token" }, 401);
    c.set("display" as never, d as never);
    const battery = c.req.header("x-orbis-battery");
    const batteryNum = battery !== undefined ? Number(battery) : undefined;
    // board strings are capped (BOARD_MAX) and cleaned in the service; they show up on the e-ink page
    eink.touchDisplay(d.id, { battery: batteryNum !== undefined && Number.isFinite(batteryNum) ? batteryNum : undefined, board: c.req.header("x-orbis-board") ?? undefined });
    await next();
  })
  .get("/:id/config", (c) => {
    const d = c.get("display" as never) as ReturnType<typeof eink.getDisplay>;
    if (!d) return c.json({ error: "not found" }, 404);
    return c.json({ id: d.id, name: d.name, width: d.width, height: d.height, rotate: d.rotate, grayscale: d.grayscale, refreshMinutes: d.refreshMinutes, image: `/api/eink/${d.id}.bin` });
  })
  .post("/:id/tap", async (c) => {
    const d = c.get("display" as never) as ReturnType<typeof eink.getDisplay>;
    if (!d) return c.json({ error: "not found" }, 404);
    const body = z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input: x and y must be numbers >= 0" }, 400);
    // taps are in frame space (after rotation): 0..W × 0..H
    const { W, H } = eink.frameSize(d);
    if (body.data.x > W || body.data.y > H) return c.json({ error: `tap out of bounds: x must be 0..${W}, y 0..${H}` }, 400);
    const r = await eink.handleTap(d, body.data.x, body.data.y);
    return c.json({ ok: true, ...r });
  })
  .get("/:file", async (c) => {
    const d = c.get("display" as never) as ReturnType<typeof eink.getDisplay>;
    if (!d) return c.json({ error: "not found" }, 404);
    const ext = c.req.param("file").split(".").pop() as "png" | "bin" | "bmp" | "svg";
    if (!["png", "bin", "bmp", "svg"].includes(ext)) return c.json({ error: "unknown format" }, 404);
    const r = await eink.renderDisplay(d, { format: ext });
    c.header("content-type", r.contentType);
    c.header("cache-control", "no-store");
    c.header("x-orbis-refresh-minutes", String(d.refreshMinutes));
    return c.body(new Uint8Array(r.body));
  });
