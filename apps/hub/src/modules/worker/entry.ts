/**
 * Runs inside a worker_thread: loads one module's server.js and gives it a ctx whose methods are
 * proxied to the hub. Declared manifest permissions are enforced here – a module without
 * `network:fetch` has no fetch, without `storage` no storage, and so on.
 */
import { parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import type { ModuleServer, ModuleServerContext } from "@orbis/sdk/server";
import { createTranslator } from "@orbis/sdk/server";
import type { Device, ModuleStatus } from "@orbis/sdk";
import type { SerializedRequest, SerializedResponse, SyncCall, SyncResult, ToHub, ToWorker, WorkerData } from "./protocol";

const data = workerData as WorkerData;
const port = parentPort!;
const i32 = new Int32Array(data.syncBuffer);
const perms = new Set(data.manifest.permissions);
const send = (m: ToHub, transfer?: ArrayBuffer[]) => port.postMessage(m, transfer as never);
let seq = 1;

const denied = (perm: string) => () => {
  throw new Error(`module "${data.moduleId}" has no "${perm}" permission (declare it in module.json)`);
};

/** blocking call into the hub */
function sync<T>(method: string, ...args: unknown[]): T {
  const id = seq++;
  Atomics.store(i32, 0, 0);
  data.syncPort.postMessage({ id, method, args } satisfies SyncCall);
  const r = Atomics.wait(i32, 0, 0, 30_000);
  if (r === "timed-out") throw new Error(`hub did not answer ${method} in time`);
  const msg = receiveMessageOnPort(data.syncPort)?.message as SyncResult | undefined;
  if (!msg || msg.id !== id) throw new Error(`sync protocol error on ${method}`);
  if (!msg.ok) throw new Error(msg.error ?? `${method} failed`);
  return msg.value as T;
}

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function async<T>(m: Omit<Extract<ToHub, { t: "call" }>, "id">): Promise<T> {
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send({ ...m, id } as ToHub);
  });
}

let settings = data.settings;
let language = data.language;
let translator = createTranslator(language, data.locales);
const languageListeners = new Set<(language: string) => void>();
const settingsListeners = new Set<(s: Record<string, unknown>) => void>();
const deviceListeners = new Set<(d: Device[]) => void>();
const moduleListeners = new Set<(ids: string[]) => void>();
const jobs = new Map<string, () => void | Promise<void>>();
let currentStatus: ModuleStatus | null = null;
const http = new Hono();

const log = (level: "debug" | "info" | "warn" | "error") => (msg: string, ...args: unknown[]) => send({ t: "log", level, msg, args: args.length ? args : undefined });

const ctx: ModuleServerContext = {
  manifest: data.manifest,
  dir: data.dir,
  dataDir: data.dataDir,
  hubVersion: data.hubVersion,
  logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
  storage: perms.has("storage")
    ? {
        get: (k) => sync("storage.get", k),
        set: (k, v) => sync("storage.set", k, v),
        delete: (k) => sync("storage.delete", k),
        keys: (p) => sync("storage.keys", p),
        sql: (q, p) => sync("storage.sql", q, p),
        run: (q, p) => sync("storage.run", q, p),
      }
    : { get: denied("storage"), set: denied("storage"), delete: denied("storage"), keys: denied("storage"), sql: denied("storage"), run: denied("storage") },
  scheduler: perms.has("scheduler")
    ? {
        every(name, ms, fn, opts) {
          jobs.set(name, fn);
          send({ t: "schedule", kind: "every", name, ms, immediate: opts?.immediate });
        },
        once(name, ms, fn) {
          jobs.set(name, fn);
          send({ t: "schedule", kind: "once", name, ms });
        },
        cancel(name) {
          jobs.delete(name);
          send({ t: "cancel", name });
        },
      }
    : { every: denied("scheduler"), once: denied("scheduler"), cancel: () => undefined },
  events: { publish: (name, payload) => send({ t: "publish", name, payload }) },
  devices: {
    list: perms.has("devices:read") ? () => sync("devices.list") : denied("devices:read"),
    suggested: perms.has("devices:read") ? () => sync("devices.suggested") : denied("devices:read"),
    claimed: perms.has("devices:read") ? () => sync("devices.claimed") : denied("devices:read"),
    claim: perms.has("devices:claim") ? (id) => sync("devices.claim", id) : denied("devices:claim"),
    release: perms.has("devices:claim") ? (id) => sync("devices.release", id) : denied("devices:claim"),
    onChange(cb) {
      deviceListeners.add(cb);
      return () => deviceListeners.delete(cb);
    },
  },
  settings: {
    get: () => settings as never,
    set(patch) {
      settings = { ...settings, ...(patch as Record<string, unknown>) };
      send({ t: "settings:set", patch: patch as Record<string, unknown> });
    },
    onChange(cb) {
      settingsListeners.add(cb as never);
      return () => settingsListeners.delete(cb as never);
    },
  },
  status: {
    set(s) {
      currentStatus = s;
      send({ t: "status", status: s });
    },
    get: () => currentStatus,
  },
  notify: perms.has("notifications") ? (input) => sync("notify", input) : denied("notifications"),
  dismissNotification: (key) => send({ t: "dismiss", key }),
  modules: {
    list: () => sync("modules.list"),
    has: (id) => sync("modules.has", id),
    onChange(cb) {
      moduleListeners.add(cb);
      return () => moduleListeners.delete(cb);
    },
    async call(id, path, init = {}) {
      const headers = new Headers(init.headers);
      let body = init.body as string | null | undefined;
      if (init.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(init.json);
      }
      return async({ t: "call", module: id, path, init: { method: init.method, headers: [...headers.entries()], body: typeof body === "string" ? body : body == null ? null : String(body) } });
    },
  },
  http,
  fetch: perms.has("network:fetch") ? globalThis.fetch.bind(globalThis) : (denied("network:fetch") as unknown as typeof fetch),
  i18n: {
    get language() {
      return language;
    },
    t: (key, vars) => translator(key, vars),
    onChange(cb) {
      languageListeners.add(cb);
      return () => languageListeners.delete(cb);
    },
  },
};

let server: ModuleServer | null = null;

async function handleHttp(r: SerializedRequest): Promise<SerializedResponse> {
  const req = new Request(r.url, { method: r.method, headers: r.headers, body: r.body && r.method !== "GET" && r.method !== "HEAD" ? r.body : undefined });
  const res = await http.fetch(req);
  const body = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: [...res.headers.entries()], body };
}

const reply = (id: number, p: Promise<unknown>, transfer?: (v: unknown) => ArrayBuffer[]) =>
  p.then(
    (value) => send({ t: "result", id, ok: true, value }, transfer?.(value)),
    (err: Error) => send({ t: "result", id, ok: false, error: err?.message ?? String(err) }),
  );

port.on("message", (m: ToWorker) => {
  switch (m.t) {
    case "setup":
      return reply(
        m.id,
        (async () => {
          const mod = await import(pathToFileURL(data.file).href);
          server = (mod.default ?? mod) as ModuleServer;
          if (typeof server?.setup !== "function") throw new Error("server entry has no default export with setup()");
          await server.setup(ctx);
          return { eink: typeof server.eink === "function", einkTap: typeof server.einkTap === "function" };
        })(),
      );
    case "teardown":
      return reply(m.id, Promise.resolve(server?.teardown?.()));
    case "http":
      return reply(m.id, handleHttp(m.req), (v) => [(v as SerializedResponse).body.buffer as ArrayBuffer]);
    case "eink":
      return reply(m.id, Promise.resolve(server?.eink ? server.eink(ctx, { ...m.req, now: new Date(m.req.now) }) : Promise.reject(new Error("module has no eink view"))));
    case "einkTap":
      return reply(m.id, Promise.resolve(server?.einkTap ? server.einkTap(ctx, { ...m.req, now: new Date(m.req.now) }) : undefined));
    case "tick": {
      const fn = jobs.get(m.name);
      if (fn) void Promise.resolve().then(fn).catch((err: Error) => send({ t: "log", level: "error", msg: `scheduled job ${m.name} failed: ${err.message}` }));
      return;
    }
    case "settings":
      settings = m.settings;
      for (const cb of settingsListeners) cb(settings);
      return;
    case "language":
      language = m.language;
      translator = createTranslator(language, data.locales);
      for (const cb of languageListeners) cb(language);
      return;
    case "devices": {
      if (!deviceListeners.size) return;
      const list = perms.has("devices:read") ? sync<Device[]>("devices.list") : [];
      for (const cb of deviceListeners) cb(list);
      return;
    }
    case "modules":
      for (const cb of moduleListeners) cb(m.loaded);
      return;
    case "result": {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error ?? "call failed"));
      return;
    }
  }
});

process.on("uncaughtException", (err) => send({ t: "log", level: "error", msg: `uncaught in module worker: ${err.message}` }));
process.on("unhandledRejection", (err) => send({ t: "log", level: "error", msg: `unhandled rejection in module worker: ${(err as Error)?.message ?? String(err)}` }));
