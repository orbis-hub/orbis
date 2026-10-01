/**
 * Hub side of the module sandbox: starts a worker_thread for a module and hands back something that
 * looks like a loaded ModuleServer (setup/teardown/eink/einkTap). Every ctx call the worker makes is
 * executed here against the real, in-process context built by context.ts, so permissions, table
 * prefixes and the notification pipeline stay in one place.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import type { ModuleManifest } from "@orbis/sdk";
import type { EinkRequest, EinkTapRequest, EinkTapResult, EinkTree, ModuleServer, ModuleServerContext } from "@orbis/sdk/server";
import { config } from "../../config";
import { childLog } from "../../log";
import type { SerializedRequest, SerializedResponse, SyncCall, SyncResult, ToHub, ToWorker, WorkerData } from "./protocol";

export type WorkerServer = ModuleServer & { worker: Worker; alive: () => boolean };

function entryUrl(): URL {
  // dev (tsx): entry.ts next to this file; prod (tsup): dist/modules/worker/entry.js next to dist/index.js
  const candidates = [new URL("./entry.ts", import.meta.url), new URL("./entry.js", import.meta.url), new URL("./modules/worker/entry.js", import.meta.url)];
  for (const c of candidates) if (existsSync(fileURLToPath(c))) return c;
  throw new Error("module worker entry not found");
}

/** which modules run isolated: ORBIS_ISOLATE = store (default) | all | off */
export function shouldIsolate(source: string): boolean {
  const mode = config.isolate;
  if (mode === "off") return false;
  if (mode === "all") return true;
  return source !== "builtin" && source !== "dev";
}

export async function startWorkerServer(manifest: ModuleManifest, file: string, ctx: ModuleServerContext): Promise<WorkerServer> {
  const log = childLog(`mod:${manifest.id}:worker`);
  const { port1: syncHub, port2: syncWorker } = new MessageChannel();
  const syncBuffer = new SharedArrayBuffer(4);
  const i32 = new Int32Array(syncBuffer);
  const data: WorkerData = { moduleId: manifest.id, file, manifest, dir: ctx.dir, dataDir: ctx.dataDir, hubVersion: ctx.hubVersion, settings: ctx.settings.get() as Record<string, unknown>, syncPort: syncWorker, syncBuffer };
  const worker = new Worker(entryUrl(), {
    workerData: data,
    transferList: [syncWorker],
    env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "", TZ: process.env.TZ ?? "" },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    stdout: false,
    stderr: false,
  });
  let alive = true;
  let seq = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const timers = new Map<string, NodeJS.Timeout>();
  type Ask = { t: "setup" } | { t: "teardown" } | { t: "http"; req: SerializedRequest } | { t: "eink"; req: Omit<EinkRequest, "now"> & { now: string } } | { t: "einkTap"; req: Omit<EinkTapRequest, "now"> & { now: string } };
  const ask = <T,>(m: Ask, transfer?: ArrayBuffer[]): Promise<T> => {
    if (!alive) return Promise.reject(new Error("module worker is not running"));
    const id = seq++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...m, id } as ToWorker, transfer as never);
    });
  };

  /* ---- sync calls (storage, devices, …) ---- */
  const syncHandlers: Record<string, (...args: never[]) => unknown> = {
    "storage.get": (k: string) => ctx.storage.get(k),
    "storage.set": (k: string, v: unknown) => ctx.storage.set(k, v),
    "storage.delete": (k: string) => ctx.storage.delete(k),
    "storage.keys": (p?: string) => ctx.storage.keys(p),
    "storage.sql": (q: string, p?: unknown[]) => ctx.storage.sql(q, p),
    "storage.run": (q: string, p?: unknown[]) => {
      const r = ctx.storage.run(q, p);
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    },
    "devices.list": () => ctx.devices.list(),
    "devices.suggested": () => ctx.devices.suggested(),
    "devices.claimed": () => ctx.devices.claimed(),
    "devices.claim": (id: string) => ctx.devices.claim(id),
    "devices.release": (id: string) => ctx.devices.release(id),
    "modules.list": () => ctx.modules.list(),
    "modules.has": (id: string) => ctx.modules.has(id),
    notify: (input: Parameters<ModuleServerContext["notify"]>[0]) => ctx.notify(input),
  };
  syncHub.on("message", (m: SyncCall) => {
    let res: SyncResult;
    try {
      const h = syncHandlers[m.method];
      if (!h) throw new Error(`unknown sync method ${m.method}`);
      res = { id: m.id, ok: true, value: h(...(m.args as never[])) ?? null };
    } catch (err) {
      res = { id: m.id, ok: false, error: (err as Error).message };
    }
    syncHub.postMessage(res);
    Atomics.store(i32, 0, 1);
    Atomics.notify(i32, 0);
  });

  /* ---- async traffic from the worker ---- */
  worker.on("message", (m: ToHub) => {
    switch (m.t) {
      case "result": {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error ?? "worker call failed"));
        return;
      }
      case "log":
        return ctx.logger[m.level](m.msg, ...(m.args ?? []));
      case "publish":
        return ctx.events.publish(m.name, m.payload);
      case "status":
        return ctx.status.set(m.status as never);
      case "settings:set":
        return ctx.settings.set(m.patch as never);
      case "dismiss":
        return ctx.dismissNotification(m.key);
      case "schedule": {
        const prev = timers.get(m.name);
        if (prev) {
          clearInterval(prev);
          clearTimeout(prev);
        }
        const tick = () => alive && worker.postMessage({ t: "tick", name: m.name } satisfies ToWorker);
        if (m.kind === "every") {
          timers.set(m.name, setInterval(tick, Math.max(1000, m.ms)));
          if (m.immediate) tick();
        } else {
          timers.set(
            m.name,
            setTimeout(() => {
              timers.delete(m.name);
              tick();
            }, m.ms),
          );
        }
        return;
      }
      case "cancel": {
        const t = timers.get(m.name);
        if (t) {
          clearInterval(t);
          clearTimeout(t);
          timers.delete(m.name);
        }
        return;
      }
      case "call":
        return void ctx.modules
          .call(m.module, m.path, { method: m.init.method, headers: m.init.headers, body: m.init.body ?? undefined })
          .then(
            (value) => worker.postMessage({ t: "result", id: m.id, ok: true, value } satisfies ToWorker),
            (err: Error) => worker.postMessage({ t: "result", id: m.id, ok: false, error: err.message } satisfies ToWorker),
          );
    }
  });
  const die = (why: string) => {
    if (!alive) return;
    alive = false;
    for (const p of pending.values()) p.reject(new Error(why));
    pending.clear();
    for (const t of timers.values()) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.clear();
    syncHub.close();
    ctx.status.set({ state: "error", message: why });
  };
  worker.on("error", (err) => {
    log.error({ err }, "module worker crashed");
    die(`module crashed: ${err.message}`);
  });
  worker.on("exit", (code) => {
    if (alive) log.warn({ code }, "module worker exited");
    die(`module worker exited (${code})`);
  });

  /* ---- fan hub-side changes into the worker ---- */
  const offSettings = ctx.settings.onChange((s) => alive && worker.postMessage({ t: "settings", settings: s as Record<string, unknown> } satisfies ToWorker));
  const offDevices = ctx.devices.onChange(() => alive && worker.postMessage({ t: "devices" } satisfies ToWorker));
  const offModules = ctx.modules.onChange((loaded) => alive && worker.postMessage({ t: "modules", loaded } satisfies ToWorker));

  /* ---- http: everything that reaches ctx.http goes to the worker's router ---- */
  ctx.http.all("*", async (c) => {
    const body = c.req.method === "GET" || c.req.method === "HEAD" ? null : new Uint8Array(await c.req.raw.arrayBuffer());
    const sr: SerializedRequest = { method: c.req.method, url: c.req.url, headers: [...c.req.raw.headers.entries()], body };
    const r = await ask<SerializedResponse>({ t: "http", req: sr }, body ? [body.buffer as ArrayBuffer] : undefined);
    return new Response(r.body, { status: r.status, headers: r.headers });
  });

  const caps = await ask<{ eink: boolean; einkTap: boolean }>({ t: "setup" });
  log.info({ isolated: true }, "module running in worker");

  const server: WorkerServer = {
    worker,
    alive: () => alive,
    setup() {
      /* already done by the worker */
    },
    async teardown() {
      offSettings();
      offDevices();
      offModules();
      if (alive) {
        try {
          await Promise.race([ask({ t: "teardown" }), new Promise((r) => setTimeout(r, 3000))]);
        } catch {
          /* dying anyway */
        }
      }
      alive = false;
      syncHub.close();
      for (const t of timers.values()) {
        clearInterval(t);
        clearTimeout(t);
      }
      timers.clear();
      await worker.terminate();
    },
    eink: caps.eink ? (_ctx, req: EinkRequest) => ask<EinkTree>({ t: "eink", req: { ...req, now: req.now.toISOString() } }) : undefined,
    einkTap: caps.einkTap ? (_ctx, req: EinkTapRequest) => ask<EinkTapResult | void>({ t: "einkTap", req: { ...req, now: req.now.toISOString() } }) : undefined,
  };
  return server;
}
