import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth";
import { errorStatus } from "../errors";
import * as users from "../services/users";

const password = z.string().min(6, "password min 6 characters").max(256, "password max 256 characters");
const name = users.userName;
/** roles an admin/owner may hand out; "owner" is never assignable (exactly one, created at setup) */
const assignableRole = z.enum(["admin", "member"], { error: "role must be admin or member" });

function fail(c: { json: (b: unknown, s: 400 | 401 | 403 | 404 | 409 | 429) => Response }, err: unknown) {
  return c.json({ error: (err as Error).message ?? "error" }, errorStatus(err));
}

/** first zod issue as a readable message ("invalid name (1-64 printable characters)") */
function issueMessage(err: z.ZodError) {
  const i = err.issues[0];
  return i ? `invalid ${i.path.join(".") || "input"} (${i.message})` : "invalid input";
}

/** /api/users - account management. Listing and mutations are admin-only; /me/* is for everyone. */
export const userRoutes = new Hono()
  .use(requireAuth)
  .get("/me", (c) => c.json(users.getUser(c.var.user.id)))
  .patch("/me", async (c) => {
    const body = z.object({ name }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issueMessage(body.error) }, 400);
    try {
      return c.json(users.updateUser(c.var.user.id, { name: body.data.name }, c.var.user));
    } catch (err) {
      return fail(c, err);
    }
  })
  .post("/me/password", async (c) => {
    const body = z.object({ current: z.string(), password }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issueMessage(body.error) }, 400);
    try {
      users.setPassword(c.var.user.id, body.data.password, { current: body.data.current, requireCurrent: true });
      return c.json({ ok: true, reauth: true });
    } catch (err) {
      return fail(c, err);
    }
  })
  .get("/", requireRole("admin"), (c) => c.json(users.listUsers()))
  .post("/", requireRole("admin"), async (c) => {
    const body = z.object({ name, password, role: assignableRole.optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issueMessage(body.error) }, 400);
    if (body.data.role === "admin" && c.var.user.role !== "owner") return c.json({ error: "only the owner can create admins" }, 403);
    try {
      return c.json(users.createUserAccount(body.data.name, body.data.password, body.data.role ?? "member"), 201);
    } catch (err) {
      return fail(c, err);
    }
  })
  .patch("/:id", requireRole("admin"), async (c) => {
    const body = z.object({ name: name.optional(), role: assignableRole.optional(), disabled: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issueMessage(body.error) }, 400);
    try {
      return c.json(users.updateUser(c.req.param("id"), body.data, c.var.user));
    } catch (err) {
      return fail(c, err);
    }
  })
  .post("/:id/password", requireRole("admin"), async (c) => {
    const body = z.object({ password }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: issueMessage(body.error) }, 400);
    try {
      const target = users.getUser(c.req.param("id"));
      if (!target) return c.json({ error: "user not found" }, 404);
      users.assertMayManage(target, c.var.user, "reset the password of");
      users.setPassword(target.id, body.data.password, { requireCurrent: false });
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  })
  .post("/:id/logout", requireRole("admin"), (c) => {
    try {
      users.revokeAllSessions(c.req.param("id"), c.var.user);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  })
  .delete("/:id", requireRole("admin"), (c) => {
    try {
      users.deleteUser(c.req.param("id"), c.var.user);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, err);
    }
  });
