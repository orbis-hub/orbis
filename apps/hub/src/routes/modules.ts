import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { extname, join, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, resolveToken, tokenFromRequest } from "../auth";
import { config } from "../config";
import * as registry from "../modules/registry";
import * as runtime from "../modules/runtime";
import { settingsForRole } from "../modules/secrets";

export const moduleRoutes = new Hono()
  .use(requireAuth)
  .get("/", (c) => c.json(runtime.list().map(runtime.toPublic)))
  .get("/registry", async (c) => {
    const force = c.req.query("refresh") === "1";
    const { modules, errors } = await registry.fetchAllRegistries(force);
    const installed = new Map(runtime.list().map((m) => [m.id, m.version]));
    return c.json({
      registries: registry.registryUrls(),
      errors,
      modules: modules.map((m) => ({ ...m, installedVersion: installed.get(m.id) ?? null })),
    });
  })
  .post("/install", requireRole("admin"), async (c) => {
    const body = z.object({ id: z.string().optional(), url: z.string().url().optional(), version: z.string().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    try {
      let url = body.data.url;
      const { modules } = await registry.fetchAllRegistries();
      if (!url) {
        if (!body.data.id) return c.json({ error: "id or url required" }, 400);
        const entry = modules.find((m) => m.id === body.data.id);
        if (!entry) return c.json({ error: `module ${body.data.id} not in any registry` }, 404);
        url = registry.tarballUrlFor(entry, body.data.version ?? entry.latest);
      }
      const s = await runtime.install(url, body.data.id);
      // hard dependencies: pull them from the registry too (one level at a time, recursion through the same path)
      const installedDeps: string[] = [];
      const queue = [...s.manifest.deps];
      const seen = new Set<string>([s.id]);
      while (queue.length) {
        const depId = queue.shift()!;
        if (seen.has(depId)) continue;
        seen.add(depId);
        if (runtime.get(depId)) continue;
        const entry = modules.find((m) => m.id === depId);
        if (!entry) continue; // left for the user: module card shows "needs x"
        const dep = await runtime.install(registry.tarballUrlFor(entry, entry.latest), depId);
        installedDeps.push(dep.id);
        queue.push(...dep.manifest.deps);
      }
      if (installedDeps.length) await runtime.reload(s.id);
      return c.json({ ...runtime.toPublic(runtime.get(s.id) ?? s), installedDeps }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  /** manifest + settings; members get the settings without `format: "secret"` keys (#38) */
  .get("/:id", (c) => {
    const s = runtime.get(c.req.param("id"));
    return s ? c.json({ ...runtime.toPublic(s), settings: settingsForRole(s.manifest, s.settings, c.var.user.role) }) : c.json({ error: "not found" }, 404);
  })
  .patch("/:id", requireRole("admin"), async (c) => {
    const body = z.object({ enabled: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    try {
      let s = runtime.get(c.req.param("id"));
      if (!s) return c.json({ error: "not found" }, 404);
      if (body.data.enabled !== undefined) s = await runtime.setEnabled(s.id, body.data.enabled);
      return c.json(runtime.toPublic(s));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  .post("/:id/reload", requireRole("admin"), async (c) => {
    try {
      return c.json(runtime.toPublic(await runtime.reload(c.req.param("id"))));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  .delete("/:id", requireRole("admin"), async (c) => {
    try {
      await runtime.uninstall(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })
  /** raw settings incl. secrets: admins only (members use GET /:id, which strips secrets) */
  .get("/:id/settings", requireRole("admin"), (c) => {
    const s = runtime.get(c.req.param("id"));
    return s ? c.json(s.settings) : c.json({ error: "not found" }, 404);
  })
  .patch("/:id/settings", requireRole("admin"), async (c) => {
    const body = z.record(z.string(), z.unknown()).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid input" }, 400);
    try {
      return c.json(await runtime.updateSettings(c.req.param("id"), body.data));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

/** `/api/m/<id>/*` → the module's own Hono router (authenticated). */
export const moduleApiProxy = new Hono().all("/:id/*", async (c) => {
  const s = runtime.get(c.req.param("id"));
  if (!s || !s.enabled) return c.json({ error: "module not found" }, 404);
  if (!s.loaded || !s.built) return c.json({ error: s.error ?? "module not loaded" }, 503);
  const url = new URL(c.req.url);
  const prefix = `/api/m/${s.id}`;
  url.pathname = url.pathname.slice(prefix.length) || "/";
  // manifest.publicPaths (oauth callbacks etc.) skip the session check; everything else needs one
  // "/x" also covers "/x/…"; a trailing "*" is a plain prefix ("/ingest/*", "/hook*")
  const isPublic = s.manifest.publicPaths.some((p) => (p.endsWith("*") ? url.pathname.startsWith(p.slice(0, -1)) : url.pathname === p || url.pathname.startsWith(p.endsWith("/") ? p : `${p}/`)));
  const req = new Request(url, c.req.raw);
  // the module sees who is calling via x-orbis-user / x-orbis-role; a client cannot forge them (always reset here)
  req.headers.delete("x-orbis-user");
  req.headers.delete("x-orbis-role");
  if (!isPublic) {
    // `?token=` is normally ignored (#39). The one exception: a top-level browser navigation (oauth login links such as
    // /strava/login and /spotify/login, which cannot carry headers and which token-only clients like the app open directly).
    const navigation = c.req.method === "GET" && c.req.header("sec-fetch-dest") === "document";
    const token = tokenFromRequest(c, { allowQuery: navigation });
    const user = token ? resolveToken(token) : null;
    if (!user) return c.json({ error: "unauthorized" }, 401);
    req.headers.set("x-orbis-user", user.id);
    req.headers.set("x-orbis-role", user.role);
  }
  return s.built.ctx.http.fetch(req);
});

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** `/modules/<id>/<path>` → files from the module directory (client bundle, icons). Public: bundles contain no secrets. */
export const moduleFiles = new Hono().get("/:id/*", (c) => {
  const s = runtime.get(c.req.param("id"));
  if (!s?.dir || !s.enabled) return c.text("not found", 404);
  const rel = decodeURIComponent(new URL(c.req.url).pathname.replace(`/modules/${s.id}/`, ""));
  const file = resolve(s.dir, rel);
  if (!file.startsWith(resolve(s.dir)) || rel.includes("..")) return c.text("forbidden", 403);
  if (!existsSync(file) || !statSync(file).isFile()) return c.text("not found", 404);
  const etag = `"${s.version}-${statSync(file).mtimeMs}"`;
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  c.header("content-type", MIME[extname(file)] ?? "application/octet-stream");
  c.header("etag", etag);
  c.header("cache-control", config.dev || s.source === "dev" ? "no-cache" : "public, max-age=3600");
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
});

export function moduleClientUrl(id: string) {
  const s = runtime.get(id);
  if (!s?.manifest.entry.client) return null;
  return `/modules/${id}/${s.manifest.entry.client}`;
}

export { join };
