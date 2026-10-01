import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import * as tar from "tar";
import { requireAuth, requireRole } from "../auth";
import { config } from "../config";
import { closeDb, getSqlite, openDb } from "../db";
import { childLog } from "../log";
import * as runtime from "../modules/runtime";
import { broadcast } from "../ws";

const log = childLog("backup");

/**
 * /api/backup (admin)
 *   GET  /            → orbis-backup-<date>.tgz : orbis.sqlite (consistent copy via the sqlite backup api), modules/, module-data/, meta.json
 *   POST /restore     → multipart or raw tgz body; stops modules, swaps data, reopens the db, reloads modules
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
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "file field missing" }, 400);
      buf = Buffer.from(await file.arrayBuffer());
    } else {
      buf = Buffer.from(await c.req.arrayBuffer());
    }
    if (buf.byteLength < 100) return c.json({ error: "that is not a backup" }, 400);
    const tmp = await mkdtemp(join(tmpdir(), "orbis-restore-"));
    try {
      const file = join(tmp, "backup.tgz");
      await writeFile(file, buf);
      const x = join(tmp, "x");
      mkdirSync(x);
      await tar.x({ file, cwd: x, filter: (p) => !p.includes("..") });
      if (!existsSync(join(x, "orbis", "orbis.sqlite"))) return c.json({ error: "backup has no orbis.sqlite" }, 400);
      log.warn("restoring backup: stopping modules");
      await runtime.shutdown();
      closeDb();
      // keep the current data around for one restore, just in case
      const prev = resolve(config.dataDir, "..", `data-before-restore`);
      rmSync(prev, { recursive: true, force: true });
      mkdirSync(prev, { recursive: true });
      for (const f of ["orbis.sqlite", "orbis.sqlite-wal", "orbis.sqlite-shm"]) {
        const p = resolve(config.dataDir, f);
        if (existsSync(p)) rmSync(p, { force: true });
      }
      for (const dir of ["modules", "module-data"]) rmSync(resolve(config.dataDir, dir), { recursive: true, force: true });
      await tar.c({ cwd: x, file: join(prev, "marker.tar"), portable: true }, ["orbis"]).catch(() => undefined);
      // db
      const { copyFileSync } = await import("node:fs");
      copyFileSync(join(x, "orbis", "orbis.sqlite"), resolve(config.dataDir, "orbis.sqlite"));
      for (const t of ["modules.tar", "module-data.tar"]) if (existsSync(join(x, t))) await tar.x({ file: join(x, t), cwd: config.dataDir, filter: (p) => !p.includes("..") });
      openDb();
      await runtime.bootstrap();
      broadcast({ type: "modules:changed" });
      broadcast({ type: "dashboards:changed" });
      broadcast({ type: "settings:changed" });
      broadcast({ type: "users:changed" } as never);
      log.warn("restore complete");
      return c.json({ ok: true, note: "everyone has to sign in again if the backup is from another hub" });
    } catch (err) {
      log.error({ err }, "restore failed");
      try {
        openDb();
        await runtime.bootstrap();
      } catch {
        /* already open */
      }
      return c.json({ error: (err as Error).message }, 500);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
