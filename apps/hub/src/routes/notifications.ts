import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth";
import * as n from "../services/notifications";

/**
 * /api/notifications – everything is scoped to the signed-in account (#41):
 * shared notifications (userId null) plus the ones addressed to me, read state per account.
 */
export const notificationRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json({ items: n.listNotifications(c.var.user.id, { unreadOnly: c.req.query("unread") === "1", limit: Number.isFinite(limit) ? limit : 100 }), unread: n.unreadCount(c.var.user.id) });
  })
  .post("/read", async (c) => {
    const body = z.object({ ids: z.union([z.array(z.string().max(64)).max(500), z.literal("all")]) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    n.markRead(c.var.user.id, body.data.ids);
    return c.json({ ok: true, unread: n.unreadCount(c.var.user.id) });
  })
  .post("/clear-read", (c) => {
    n.clearRead(c.var.user);
    return c.json({ ok: true, unread: n.unreadCount(c.var.user.id) });
  })
  .post("/test", requireRole("admin"), (c) => c.json(n.sendTest()))
  .delete("/:id", (c) => {
    const r = n.remove(c.req.param("id"), c.var.user);
    if (!r) return c.json({ error: "not found" }, 404);
    // members cannot delete a shared notification for the whole household; it is dismissed (marked read) for them instead
    return c.json({ ok: true, deleted: r.deleted, dismissed: !r.deleted, unread: n.unreadCount(c.var.user.id) });
  });
