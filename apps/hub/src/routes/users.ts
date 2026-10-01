import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth";
import * as users from "../services/users";

const role = z.enum(["owner", "admin", "member"]);
const password = z.string().min(6).max(256);
const name = z.string().trim().min(1).max(64);

/** /api/users – account management. Listing and mutations are admin-only; /me/* is for everyone. */
export const userRoutes = new Hono()
  .use(requireAuth)
  .get("/me", (c) => c.json(users.getUser(c.var.user.id)))
  .patch("/me", async (c) => {
    const body = z.object({ name }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    try {
      return c.json(users.updateUser(c.var.user.id, { name: body.data.name }, c.var.user));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  .post("/me/password", async (c) => {
    const body = z.object({ current: z.string(), password }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input (min 6 characters)" }, 400);
    try {
      users.setPassword(c.var.user.id, body.data.password, { current: body.data.current, requireCurrent: true });
      return c.json({ ok: true, reauth: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  .get("/", requireRole("admin"), (c) => c.json(users.listUsers()))
  .post("/", requireRole("admin"), async (c) => {
    const body = z.object({ name, password, role: role.optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input (password min 6 characters)" }, 400);
    if (body.data.role === "admin" && c.var.user.role !== "owner") return c.json({ error: "only the owner can create admins" }, 403);
    try {
      return c.json(users.createUserAccount(body.data.name, body.data.password, body.data.role ?? "member"), 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  .patch("/:id", requireRole("admin"), async (c) => {
    const body = z.object({ name: name.optional(), role: role.optional(), disabled: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    if (body.data.role === "admin" && c.var.user.role !== "owner") return c.json({ error: "only the owner can promote to admin" }, 403);
    try {
      return c.json(users.updateUser(c.req.param("id"), body.data, c.var.user));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  .post("/:id/password", requireRole("admin"), async (c) => {
    const body = z.object({ password }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input (min 6 characters)" }, 400);
    const target = users.getUser(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);
    if (target.role === "owner" && c.var.user.role !== "owner") return c.json({ error: "only the owner can reset the owner's password" }, 403);
    if (target.role === "admin" && c.var.user.role !== "owner" && target.id !== c.var.user.id) return c.json({ error: "only the owner can reset admin passwords" }, 403);
    try {
      users.setPassword(target.id, body.data.password, { requireCurrent: false });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  .post("/:id/logout", requireRole("admin"), (c) => {
    users.revokeAllSessions(c.req.param("id"));
    return c.json({ ok: true });
  })
  .delete("/:id", requireRole("admin"), (c) => {
    try {
      users.deleteUser(c.req.param("id"), c.var.user);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
