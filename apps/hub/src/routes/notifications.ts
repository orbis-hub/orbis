import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth";
import * as n from "../services/notifications";

export const notificationRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json({ items: n.listNotifications({ unreadOnly: c.req.query("unread") === "1", limit: Number(c.req.query("limit") ?? 100) }), unread: n.unreadCount() }))
  .post("/read", async (c) => {
    const body = z.object({ ids: z.union([z.array(z.string()), z.literal("all")]) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    n.markRead(body.data.ids);
    return c.json({ ok: true, unread: n.unreadCount() });
  })
  .post("/clear-read", (c) => {
    n.clearRead();
    return c.json({ ok: true });
  })
  .post("/test", requireRole("admin"), (c) => c.json(n.sendTest()))
  .delete("/:id", (c) => {
    n.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
