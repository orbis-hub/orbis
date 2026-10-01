import { Hono } from "hono";
import { z } from "zod";
import { clearSessionCookie, createSession, createUser, findUserByName, hasUsers, requireAuth, resolveToken, revokeSession, setSessionCookie, tokenFromRequest, verifyPassword } from "../auth";
import { config } from "../config";

const credentials = z.object({ name: z.string().trim().min(1).max(64), password: z.string().min(6).max(256), remember: z.boolean().optional() });

export const authRoutes = new Hono()
  .get("/status", (c) => {
    const token = tokenFromRequest(c);
    const user = token ? resolveToken(token) : null;
    return c.json({ setup: hasUsers(), authenticated: !!user, user, hubVersion: config.version });
  })
  .post("/setup", async (c) => {
    if (hasUsers()) return c.json({ error: "already set up" }, 409);
    const body = credentials.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input", issues: body.error.issues }, 400);
    const user = createUser(body.data.name, body.data.password, "owner");
    const { token, expiresAt } = createSession(user.id, c.req.header("user-agent"));
    setSessionCookie(c, token, expiresAt);
    return c.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  })
  .post("/login", async (c) => {
    const body = credentials.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    const user = findUserByName(body.data.name);
    if (!user || !verifyPassword(body.data.password, user.passwordHash)) {
      await new Promise((r) => setTimeout(r, 400)); // slow down guessing a little
      return c.json({ error: "wrong name or password" }, 401);
    }
    const { token, expiresAt } = createSession(user.id, c.req.header("user-agent"));
    setSessionCookie(c, token, expiresAt);
    return c.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  })
  .post("/logout", (c) => {
    const token = tokenFromRequest(c);
    if (token) revokeSession(token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  })
  .get("/me", requireAuth, (c) => c.json({ user: c.var.user }));

