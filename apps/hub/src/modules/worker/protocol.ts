/**
 * Messages between the hub and a module worker. Two channels:
 *  - the worker's main port: async traffic both ways (http requests, events, ticks, setup/teardown)
 *  - a dedicated sync port + SharedArrayBuffer: the worker blocks with Atomics.wait while the hub answers
 *    storage/devices/settings calls, so the module keeps the synchronous sdk api it already has.
 */
import type { EinkRequest, EinkTapRequest } from "@orbis/sdk/server";
import type { Messages, ModuleManifest } from "@orbis/sdk";

export type WorkerData = {
  moduleId: string;
  file: string;
  manifest: ModuleManifest;
  dir: string;
  dataDir: string;
  hubVersion: string;
  settings: Record<string, unknown>;
  /** hub ui language + the module's locale bundles, so ctx.i18n works without a round trip */
  language: string;
  locales: Record<string, Messages>;
  syncPort: import("node:worker_threads").MessagePort;
  syncBuffer: SharedArrayBuffer;
};

export type SerializedRequest = { method: string; url: string; headers: [string, string][]; body: Uint8Array | null };
export type SerializedResponse = { status: number; headers: [string, string][]; body: Uint8Array };

/** hub → worker */
export type ToWorker =
  | { t: "setup"; id: number }
  | { t: "teardown"; id: number }
  | { t: "http"; id: number; req: SerializedRequest }
  | { t: "eink"; id: number; req: Omit<EinkRequest, "now"> & { now: string } }
  | { t: "einkTap"; id: number; req: Omit<EinkTapRequest, "now"> & { now: string } }
  | { t: "tick"; name: string }
  | { t: "settings"; settings: Record<string, unknown> }
  | { t: "language"; language: string }
  | { t: "devices" }
  | { t: "modules"; loaded: string[] }
  | { t: "result"; id: number; ok: boolean; value?: unknown; error?: string };

/** worker → hub (async) */
export type ToHub =
  | { t: "result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; args?: unknown[] }
  | { t: "publish"; name: string; payload?: unknown }
  | { t: "status"; status: unknown }
  | { t: "settings:set"; patch: Record<string, unknown> }
  | { t: "schedule"; kind: "every" | "once"; name: string; ms: number; immediate?: boolean }
  | { t: "cancel"; name: string }
  | { t: "dismiss"; key: string }
  | { t: "call"; id: number; module: string; path: string; init: { method?: string; headers?: [string, string][]; body?: string | null } };

/** worker → hub (sync, answered on the sync port) */
export type SyncCall = { id: number; method: string; args: unknown[] };
export type SyncResult = { id: number; ok: boolean; value?: unknown; error?: string };

export const SYNC_STATE = 0; // index into the Int32Array: 0 = waiting, 1 = answered
