import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { Hono } from "hono";
import * as tar from "tar";
import { requireAuth, requireRole } from "../auth";
import { config, ensureDirs } from "../config";
import { closeDb, getSqlite, openDb } from "../db";
import { childLog } from "../log";
import * as runtime from "../modules/runtime";
import { broadcast } from "../ws";

const log = childLog("backup");

/** uploads above this are refused with 413 before anything is buffered */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** how many `before-restore-*` copies stay in the data dir */
export const KEEP_RESTORE_COPIES = 3;
export const RESTORE_COPY_PREFIX = "before-restore-";

export class BadArchive extends Error {
  status = 400 as const;
}

/* ---------- restore helpers (pure file operations, unit-tested with a temp data dir) ---------- */

const SQLITE_MAGIC = "SQLite format 3\0";
function isSqliteFile(path: string) {
  try {
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(16);
      return readSync(fd, head, 0, 16, 0) === 16 && head.toString("latin1") === SQLITE_MAGIC;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Unpack an uploaded .tgz into `tmp/x` and make sure it looks like an orbis backup. Throws BadArchive. */
export async function extractUpload(buf: Buffer, tmp: string): Promise<string> {
  const file = join(tmp, "backup.tgz");
  await writeFile(file, buf);
  const x = join(tmp, "x");
  mkdirSync(x);
  try {
    await tar.x({ file, cwd: x, filter: (p) => !p.includes("..") && !p.startsWith("/") && !/^[a-zA-Z]:/.test(p) });
  } catch (err) {
    throw new BadArchive(`that is not an orbis backup: the file could not be unpacked (${(err as Error).message.replace(/^TAR_\w+: /, "")}). upload the .tgz you downloaded from this page.`);
  }
  const sqlite = join(x, "orbis", "orbis.sqlite");
  if (!existsSync(sqlite)) throw new BadArchive("that is not an orbis backup: orbis/orbis.sqlite is missing from the archive");
  if (!isSqliteFile(sqlite)) throw new BadArchive("that is not an orbis backup: orbis/orbis.sqlite is not a sqlite database");
  for (const t of ["modules.tar", "module-data.tar"]) {
    const p = join(x, t);
    if (existsSync(p) && !(await tar.list({ file: p }).then(() => true).catch(() => false))) throw new BadArchive(`that is not an orbis backup: ${t} inside the archive is damaged`);
  }
  return x;
}

export function restoreCopyName(d = new Date()) {
  return `${RESTORE_COPY_PREFIX}${d.toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
}

/**
 * Copy what is in the data dir right now into `<dataDir>/before-restore-<timestamp>/` — BEFORE anything is deleted.
 * Returns the copy's path (null when there was nothing to keep). The db must be closed by the caller.
 */
export function keepCurrentData(dataDir: string, name = restoreCopyName()): string | null {
  const dest = resolve(dataDir, name);
  let kept = false;
  for (const f of ["orbis.sqlite", "orbis.sqlite-wal", "orbis.sqlite-shm"]) {
    const src = resolve(dataDir, f);
    if (!existsSync(src)) continue;
    mkdirSync(dest, { recursive: true });
    copyFileSync(src, resolve(dest, f));
    kept = true;
  }
  for (const dir of ["modules", "module-data"]) {
    const src = resolve(dataDir, dir);
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;
    mkdirSync(dest, { recursive: true });
    cpSync(src, resolve(dest, dir), { recursive: true });
    kept = true;
  }
  return kept ? dest : null;
}

/** Oldest `before-restore-*` folders beyond `keep` are removed. Returns what was removed. */
export function pruneRestoreCopies(dataDir: string, keep = KEEP_RESTORE_COPIES): string[] {
  const copies = readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(RESTORE_COPY_PREFIX))
    .map((e) => e.name)
    .sort(); // timestamped names sort chronologically
  const removed: string[] = [];
  for (const name of copies.slice(0, Math.max(0, copies.length - keep))) {
    rmSync(resolve(dataDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** Replace the data dir contents with the extracted backup `x`. The db must be closed. */
export async function swapInBackup(x: string, dataDir: string) {
  for (const f of ["orbis.sqlite", "orbis.sqlite-wal", "orbis.sqlite-shm"]) {
    const p = resolve(dataDir, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  for (const dir of ["modules", "module-data"]) rmSync(resolve(dataDir, dir), { recursive: true, force: true });
  copyFileSync(join(x, "orbis", "orbis.sqlite"), resolve(dataDir, "orbis.sqlite"));
  for (const t of ["modules.tar", "module-data.tar"]) {
    if (existsSync(join(x, t))) await tar.x({ file: join(x, t), cwd: dataDir, filter: (p) => !p.includes("..") });
  }
  // the store installer and module contexts expect these to exist (they used to be gone until the next restart)
  for (const dir of ["modules", "modules-dev", "module-data"]) mkdirSync(resolve(dataDir, dir), { recursive: true });
}

/** keep a copy → prune old copies → swap. Returns where the previous data went. */
export async function applyRestore(x: string, dataDir: string, opts: { keep?: number; copyName?: string } = {}): Promise<{ previous: string | null; pruned: string[] }> {
  const previous = keepCurrentData(dataDir, opts.copyName);
  const pruned = pruneRestoreCopies(dataDir, opts.keep ?? KEEP_RESTORE_COPIES);
  await swapInBackup(x, dataDir);
  return { previous, pruned };
}

/* ---------- upload reading with a hard size cap ---------- */

class TooLarge extends Error {
  status = 413 as const;
}

async function readUpload(c: Context, max: number): Promise<Buffer> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    // the multipart parser needs the whole body; the content-length check above bounds it
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new BadArchive("file field missing");
    if (file.size > max) throw new TooLarge();
    return Buffer.from(await file.arrayBuffer());
  }
  const body = c.req.raw.body;
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * /api/backup (admin)
 *   GET  /            → orbis-backup-<date>.tgz : orbis.sqlite (consistent copy via the sqlite backup api), modules/, module-data/, meta.json
 *   POST /restore     → multipart or raw tgz body (≤ 200 MB); stops modules, keeps a copy of the current data in
 *                       <dataDir>/before-restore-<timestamp>/ (last 3 are kept), swaps data, reopens the db, reloads modules
 */
export const backupRoutes = new Hono()
  .use(requireAuth)
  .use(requireRole("admin"))
  .get("/", async (c) => {
    const tmp = await mkdtemp(join(tmpdir(), "orbis-backup-"));
    try {
      const stage = join(tmp, "orbis");
      mkdirSync(stage);
      // consistent snapshot even in wal mode
      await getSqlite().backup(join(stage, "orbis.sqlite"));
      for (const dir of ["modules", "module-data"]) {
        const src = resolve(config.dataDir, dir);
        if (existsSync(src) && readdirSync(src).length) {
          await tar.c({ cwd: config.dataDir, file: join(tmp, `${dir}.tar`), portable: true }, [dir]);
        }
      }
      await writeFile(
        join(stage, "meta.json"),
        JSON.stringify({ hubVersion: config.version, createdAt: new Date().toISOString(), modules: runtime.list().map((m) => ({ id: m.id, version: m.version, source: m.source })) }, null, 2),
      );
      const out = join(tmp, "backup.tgz");
      const entries = ["orbis", ...["modules.tar", "module-data.tar"].filter((f) => existsSync(join(tmp, f)))];
      await tar.c({ cwd: tmp, file: out, gzip: true, portable: true }, entries);
      const name = `orbis-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.tgz`;
      c.header("content-type", "application/gzip");
      c.header("content-disposition", `attachment; filename="${name}"`);
      const stream = createReadStream(out);
      stream.on("close", () => void rm(tmp, { recursive: true, force: true }));
      return c.body(Readable.toWeb(stream) as ReadableStream);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      log.error({ err }, "backup failed");
      return c.json({ error: (err as Error).message }, 500);
    }
  })
  .post("/restore", async (c) => {
    let buf: Buffer;
    try {
      buf = await readUpload(c, MAX_UPLOAD_BYTES);
    } catch (err) {
      if (err instanceof TooLarge) return c.json({ error: `backup too large: uploads are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` }, 413);
      if (err instanceof BadArchive) return c.json({ error: err.message }, 400);
      return c.json({ error: "could not read the upload" }, 400);
    }
    if (buf.byteLength < 100) return c.json({ error: "that is not an orbis backup: the upload is empty" }, 400);
    const tmp = await mkdtemp(join(tmpdir(), "orbis-restore-"));
    let swapped = false;
    try {
      // everything that can be wrong with the upload is found before the hub is touched
      const x = await extractUpload(buf, tmp);
      log.warn("restoring backup: stopping modules");
      await runtime.shutdown();
      closeDb();
      swapped = true;
      const { previous, pruned } = await applyRestore(x, config.dataDir);
      ensureDirs();
      openDb();
      await runtime.bootstrap();
      broadcast({ type: "modules:changed" });
      broadcast({ type: "dashboards:changed" });
      broadcast({ type: "settings:changed" });
      broadcast({ type: "users:changed" } as never);
      log.warn({ previous, pruned }, "restore complete");
      return c.json({
        ok: true,
        previousData: previous,
        note: `${previous ? `the data from before the restore is in ${previous} (the last ${KEEP_RESTORE_COPIES} copies are kept). ` : ""}everyone has to sign in again if the backup is from another hub`,
      });
    } catch (err) {
      if (err instanceof BadArchive) return c.json({ error: err.message }, 400);
      log.error({ err }, "restore failed");
      if (swapped) {
        try {
          ensureDirs();
          openDb();
          await runtime.bootstrap();
        } catch {
          /* already open */
        }
      }
      return c.json({ error: (err as Error).message }, 500);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
