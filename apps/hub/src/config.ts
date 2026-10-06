import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// src/ in dev (tsx), dist/ in prod (tsup) – both one level below apps/hub
const hubRoot = resolve(here, "..");
const repoRoot = resolve(hubRoot, "../..");

const env = (k: string, d?: string) => process.env[k] ?? d;

export const config = {
  version: "0.2.0",
  port: Number(env("PORT", "3001")),
  host: env("HOST", "0.0.0.0")!,
  dev: env("NODE_ENV") !== "production",
  /** Writable data directory: sqlite, installed modules, module data. */
  dataDir: resolve(env("ORBIS_DATA_DIR", resolve(hubRoot, "data"))!),
  /** Static web build (apps/web/out). Served at / when it exists. */
  webDir: resolve(env("ORBIS_WEB_DIR", resolve(repoRoot, "apps/web/out"))!),
  /** First-party modules shipped with the repo (modules/<id>/). */
  builtinModulesDir: resolve(env("ORBIS_BUILTIN_MODULES_DIR", resolve(repoRoot, "modules"))!),
  /** Default registries, comma separated. */
  registries: (env("ORBIS_REGISTRIES", "https://raw.githubusercontent.com/orbis-hub/registry/main/index.json") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Extra CORS origins (comma separated). Capacitor + dev origins are always allowed. */
  corsOrigins: (env("ORBIS_CORS_ORIGINS", "") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  sessionDays: Number(env("ORBIS_SESSION_DAYS", "90")),
  /** Run module server code in worker_threads: "store" (everything that is not builtin/dev, default), "all", "off". */
  isolate: (env("ORBIS_ISOLATE", "store") as "store" | "all" | "off"),
  logLevel: env("LOG_LEVEL", env("NODE_ENV") === "production" ? "info" : "debug")!,
  get dbPath() {
    return resolve(this.dataDir, "orbis.sqlite");
  },
  get modulesDir() {
    return resolve(this.dataDir, "modules");
  },
  get devModulesDir() {
    return resolve(this.dataDir, "modules-dev");
  },
  get moduleDataDir() {
    return resolve(this.dataDir, "module-data");
  },
};

export function ensureDirs() {
  for (const d of [config.dataDir, config.modulesDir, config.devModulesDir, config.moduleDataDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}
