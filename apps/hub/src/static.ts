import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { config } from "./config";
import { childLog } from "./log";

const log = childLog("static");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

export function hasWebBuild() {
  return existsSync(join(config.webDir, "index.html"));
}

/**
 * Serves the Next.js static export. Resolution order for /foo:
 *   foo (file) → foo.html → foo/index.html → index.html (client-side routing fallback)
 */
export function serveWeb(c: Context): Response | Promise<Response> {
  const root = resolve(config.webDir);
  let pathname = decodeURIComponent(new URL(c.req.url).pathname);
  if (pathname.endsWith("/") && pathname !== "/") pathname = pathname.slice(0, -1);
  const candidates = pathname === "/" ? ["index.html"] : [pathname.slice(1), `${pathname.slice(1)}.html`, `${pathname.slice(1)}/index.html`];
  for (const rel of candidates) {
    const file = resolve(root, rel);
    if (!file.startsWith(root)) continue;
    if (existsSync(file) && statSync(file).isFile()) return send(c, file, rel.startsWith("_next/static/"));
  }
  const fallback = join(root, "index.html");
  if (existsSync(fallback)) return send(c, fallback, false);
  return c.text("web build not found – run `pnpm --filter @orbis/web build`", 404);
}

function send(c: Context, file: string, immutable: boolean) {
  const st = statSync(file);
  const etag = `"${st.size}-${st.mtimeMs}"`;
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  c.header("content-type", MIME[extname(file)] ?? "application/octet-stream");
  c.header("etag", etag);
  c.header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
}

export function logWebStatus() {
  if (hasWebBuild()) log.info({ dir: config.webDir }, "serving web build");
  else log.warn({ dir: config.webDir }, "no web build found; API only (run the Next dev server separately)");
}
