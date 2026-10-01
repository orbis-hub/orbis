import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth";
import * as eink from "../services/eink";

const displayInput = z.object({
  name: z.string().min(1).max(64),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  dashboardId: z.string().nullable().optional(),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  invert: z.boolean().optional(),
  grayscale: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(),
  refreshMinutes: z.number().int().min(1).max(1440).optional(),
  board: z.string().nullable().optional(),
});

/** admin management under /api/eink/displays */
export const einkAdminRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(eink.listDisplays()))
  .post("/", requireRole("admin"), async (c) => {
    const body = displayInput.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    return c.json(eink.createDisplay(body.data), 201);
  })
  .get("/:id", requireRole("admin"), (c) => {
    const d = eink.getDisplay(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .patch("/:id", requireRole("admin"), async (c) => {
    const body = displayInput.partial().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    const d = eink.updateDisplay(c.req.param("id"), body.data);
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .post("/:id/token", requireRole("admin"), (c) => {
    const d = eink.rotateToken(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  })
  .delete("/:id", requireRole("admin"), (c) => {
    eink.deleteDisplay(c.req.param("id"));
    return c.json({ ok: true });
  })
  /** preview for the settings page (session auth, png) */
  .get("/:id/preview.png", async (c) => {
    const d = eink.getDisplay(c.req.param("id"));
    if (!d) return c.text("not found", 404);
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
    const id = c.req.param("id") ?? c.req.path.split("/").pop()?.replace(/\.(bin|png|bmp|svg)$/, "");
    if (!token) return c.json({ error: "token required" }, 401);
    const d = eink.findByToken(token);
    if (!d || (id && d.id !== id && !id.startsWith(d.id))) return c.json({ error: "unknown display or token" }, 401);
    c.set("display" as never, d as never);
    const battery = c.req.header("x-orbis-battery");
    eink.touchDisplay(d.id, { battery: battery !== undefined ? Number(battery) : undefined, board: c.req.header("x-orbis-board") ?? undefined });
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
    const body = z.object({ x: z.number(), y: z.number() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    // widget-level tap handling is the next step; for now a tap means "show me something fresh"
    return c.json({ ok: true, refresh: true });
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
