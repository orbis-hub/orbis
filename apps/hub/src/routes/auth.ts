import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { z } from "zod";
import { burnPasswordCheck, clearSessionCookie, clientIp, createSession, createUser, findUserByName, hasUsers, requireAuth, resolveToken, revokeSession, setSessionCookie, tokenFromRequest, verifyPassword } from "../auth";
import { config } from "../config";
import { clearLoginFailures, loginThrottle, recordLoginFailure } from "../ratelimit";
import { getLanguage, getSetting } from "../services/settings";
import { userName } from "../services/users";

const credentials = z.object({ name: userName, password: z.string().min(6).max(256), remember: z.boolean().optional() });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const authRoutes = new Hono()
  .get("/status", (c) => {
    const token = tokenFromRequest(c);
    const user = token ? resolveToken(token) : null;
    // language + locale are public so the login screen can already speak the hub's language
    return c.json({ setup: hasUsers(), authenticated: !!user, user, hubVersion: config.version, language: getLanguage(), locale: getSetting("locale") });
  })
  .post("/setup", async (c) => {
    if (hasUsers()) return c.json({ error: "already set up" }, 409);
    const body = credentials.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input", issues: body.error.issues }, 400);
    const user = createUser(body.data.name, body.data.password, "owner");
    const { token, expiresAt } = createSession(user.id, c.req.header("user-agent"));
    setSessionCookie(c, token, expiresAt, { remember: body.data.remember });
    return c.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  })
  .post("/login", async (c) => {
    const body = credentials.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    // sliding window per ip + account name: 10 failures / 5 min → 429
    let remote: string | null = null;
    try {
      remote = getConnInfo(c).remote.address ?? null;
    } catch {
      /* not a node socket (tests) */
    }
    const key = `${clientIp(c, remote)}|${body.data.name.toLowerCase()}`;
    const throttle = loginThrottle(key);
    if (throttle.blocked) {
      c.header("retry-after", String(throttle.retryAfter));
      return c.json({ error: `too many failed logins, try again in ${throttle.retryAfter}s`, retryAfter: throttle.retryAfter }, 429);
    }
    const user = findUserByName(body.data.name);
    // unknown names cost the same scrypt as a wrong password (no timing oracle)
    const ok = user ? verifyPassword(body.data.password, user.passwordHash) : (burnPasswordCheck(body.data.password), false);
    if (!ok || !user || user.disabled) {
      recordLoginFailure(key);
      await sleep(400); // slow down guessing a little
      // a disabled account gets no session even with the right password, and no hint whether the password matched
      return c.json({ error: user?.disabled ? "account disabled" : "wrong name or password" }, 401);
    }
    clearLoginFailures(key);
    const { token, expiresAt } = createSession(user.id, c.req.header("user-agent"));
    setSessionCookie(c, token, expiresAt, { remember: body.data.remember });
    return c.json({ token, user: { id: user.id, name: user.name, role: user.role } });
  })
  .post("/logout", (c) => {
    const token = tokenFromRequest(c);
    if (token) revokeSession(token);
    clearSessionCookie(c);
    return c.json({ ok: true });
  })
  .get("/me", requireAuth, (c) => c.json({ user: c.var.user }));
