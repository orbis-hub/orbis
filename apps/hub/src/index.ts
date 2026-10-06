import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { purgeExpiredSessions, resolveToken, tokenFromRequest } from "./auth";
import { config, ensureDirs } from "./config";
import { closeDb, openDb } from "./db";
import { log } from "./log";
import * as runtime from "./modules/runtime";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes, deviceRoutes, settingsRoutes } from "./routes/core";
import { moduleApiProxy, moduleFiles, moduleRoutes } from "./routes/modules";
import { userRoutes } from "./routes/users";
import { einkAdminRoutes, einkDeviceRoutes } from "./routes/eink";
import { backupRoutes } from "./routes/backup";
import { notificationRoutes } from "./routes/notifications";
import { logReady as einkReady } from "./services/eink";
import { ensureDefaultDashboard } from "./services/dashboards";
import { logWebStatus, serveWeb } from "./static";
import { addClient, clientCount, removeClient } from "./ws";

ensureDirs();
openDb();

if (process.argv[2] === "reset-password") {
  const [, , , name, given] = process.argv;
  if (!name) {
    console.error("usage: reset-password <name> [new password]");
    process.exit(1);
  }
  const { findUserByName } = await import("./auth");
  const { setPassword } = await import("./services/users");
  const { randomBytes } = await import("node:crypto");
  const u = findUserByName(name);
  if (!u) {
    console.error(`no user "${name}"`);
    process.exit(1);
  }
  const pw = given ?? randomBytes(6).toString("base64url");
  setPassword(u.id, pw, { requireCurrent: false });
  console.log(`password for ${name} is now: ${pw}\nall sessions of this user were ended.`);
  closeDb();
  process.exit(0);
}
if (process.argv[2] === "users") {
  const { listUsers } = await import("./services/users");
  for (const u of listUsers()) console.log(`${u.name}\t${u.role}${u.disabled ? "\t(disabled)" : ""}`);
  closeDb();
  process.exit(0);
}
ensureDefaultDashboard();
purgeExpiredSessions();

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// never log session tokens that clients put in the query string (websocket upgrade, e-ink devices)
const redactQuery = (msg: string) => msg.replace(/([?&]token=)[^&\s]+/gi, "$1[redacted]");
if (config.dev) app.use(honoLogger((msg) => log.debug(redactQuery(msg))));

const allowedOrigins = new Set([
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  ...config.corsOrigins,
]);
const corsPolicy = cors({
    origin: (origin) => {
      if (!origin) return origin;
      if (allowedOrigins.has(origin)) return origin;
      // same-host LAN access from the Next dev server on another port
      try {
        const u = new URL(origin);
        if (config.dev && (["localhost", "127.0.0.1"].includes(u.hostname) || u.hostname.endsWith(".local") || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(u.hostname))) return origin;
      } catch {
        /* ignore */
      }
      return "";
    },
    credentials: true,
    allowHeaders: ["content-type", "authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
app.use("/api/*", corsPolicy);
app.use("/modules/*", corsPolicy);

app.get("/api/health", (c) => c.json({ ok: true, version: config.version, clients: clientCount(), modules: runtime.list().filter((m) => m.loaded).length }));
app.route("/api/auth", authRoutes);
app.route("/api/users", userRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/dashboards", dashboardRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/modules", moduleRoutes);
app.route("/api/m", moduleApiProxy);
app.route("/api/backup", backupRoutes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/eink/displays", einkAdminRoutes);
app.route("/api/eink", einkDeviceRoutes);
app.route("/modules", moduleFiles);

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    // browsers cannot set headers on the upgrade request, so ?token= is accepted here (and on e-ink device routes), nowhere else
    const token = tokenFromRequest(c, { allowQuery: true });
    const user = token ? resolveToken(token) : null;
    return {
      onOpen(_ev, ws) {
        if (!user) {
          ws.send(JSON.stringify({ type: "error", error: "unauthorized" }));
          ws.close(4401, "unauthorized");
          return;
        }
        addClient(ws, user.id);
        ws.send(JSON.stringify({ type: "hello", hubVersion: config.version }));
      },
      onMessage(ev, ws) {
        if (String(ev.data) === "ping") ws.send("pong");
      },
      onClose(_ev, ws) {
        removeClient(ws);
      },
      onError(_ev, ws) {
        removeClient(ws);
      },
    };
  }),
);

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
  return serveWeb(c);
});

app.onError((err, c) => {
  log.error({ err, path: c.req.path }, "unhandled error");
  return c.json({ error: config.dev ? err.message : "internal error" }, 500);
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info({ port: info.port, host: config.host, dataDir: config.dataDir, version: config.version }, "orbis hub listening");
  logWebStatus();
});
injectWebSocket(server);

await runtime.bootstrap();
einkReady();

setInterval(purgeExpiredSessions, 6 * 3600_000).unref();

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  await runtime.shutdown();
  server.close();
  closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
