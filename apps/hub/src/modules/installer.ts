import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ModuleManifest, safeParseManifest } from "@orbis/sdk";
import semver from "semver";
import * as tar from "tar";
import { config } from "../config";
import { childLog } from "../log";

const log = childLog("installer");

export type ModuleSource = "builtin" | "registry" | "dev" | "url";

export type DiscoveredModule = {
  manifest: ModuleManifest;
  dir: string;
  source: ModuleSource;
  sourceRef: string | null;
};

export function readManifest(dir: string): ModuleManifest {
  const file = join(dir, "module.json");
  if (!existsSync(file)) throw new Error(`module.json missing in ${dir}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const parsed = safeParseManifest(raw);
  if (!parsed.success) {
    throw new Error(`invalid module.json in ${dir}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const m = parsed.data;
  if (m.entry.server && !existsSync(join(dir, m.entry.server))) throw new Error(`${m.id}: server entry ${m.entry.server} not found`);
  if (m.entry.client && !existsSync(join(dir, m.entry.client))) throw new Error(`${m.id}: client entry ${m.entry.client} not found`);
  if (!semver.satisfies(config.version, `>=${m.minHub}`, { includePrerelease: true })) {
    throw new Error(`${m.id} needs hub >= ${m.minHub}, this hub is ${config.version}`);
  }
  return m;
}

function scanDir(root: string, source: ModuleSource): DiscoveredModule[] {
  if (!existsSync(root)) return [];
  const out: DiscoveredModule[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, "module.json"))) continue;
      const manifest = readManifest(dir);
      out.push({ manifest, dir, source, sourceRef: dir });
    } catch (err) {
      log.warn({ dir, err: (err as Error).message }, "skipping module directory");
    }
  }
  return out;
}

/** Modules shipped in the repo (modules/<id>/). Only picked up when built (module.json + dist present). */
export function discoverBuiltin() {
  return scanDir(config.builtinModulesDir, "builtin");
}

/** Installed modules in data/modules/<id>/. */
export function discoverInstalled() {
  return scanDir(config.modulesDir, "registry");
}

/** Developer modules in data/modules-dev/<id>/ (hot reloaded). */
export function discoverDev() {
  return scanDir(config.devModulesDir, "dev");
}

/** Download a tarball and install it to data/modules/<id>. Returns the discovered module. */
export async function installFromUrl(url: string, expectedId?: string): Promise<DiscoveredModule> {
  log.info({ url }, "downloading module");
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > 50 * 1024 * 1024) throw new Error("module tarball exceeds 50 MB");
  return installFromBuffer(buf, "registry", url, expectedId);
}

export async function installFromBuffer(buf: Buffer, source: ModuleSource, sourceRef: string | null, expectedId?: string): Promise<DiscoveredModule> {
  const tmp = await mkdtemp(join(tmpdir(), "orbis-mod-"));
  try {
    const tgz = join(tmp, "module.tgz");
    await writeFile(tgz, buf);
    const extractDir = join(tmp, "x");
    mkdirSync(extractDir);
    await tar.x({ file: tgz, cwd: extractDir, strip: 0, filter: (p) => !p.includes("..") });
    // the tarball may contain either module.json at the root or a single top-level folder
    let root = extractDir;
    if (!existsSync(join(root, "module.json"))) {
      const entries = readdirSync(root).filter((e) => statSync(join(root, e)).isDirectory());
      if (entries.length === 1 && existsSync(join(root, entries[0]!, "module.json"))) root = join(root, entries[0]!);
      else throw new Error("tarball has no module.json at its root");
    }
    const manifest = readManifest(root);
    if (expectedId && manifest.id !== expectedId) throw new Error(`tarball is module "${manifest.id}", expected "${expectedId}"`);
    const dest = resolve(config.modulesDir, manifest.id);
    if (!dest.startsWith(resolve(config.modulesDir))) throw new Error("bad module id");
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    // copy by re-extracting into the destination (keeps permissions simple on windows)
    await tar.x({ file: tgz, cwd: dest, strip: root === extractDir ? 0 : 1, filter: (p) => !p.includes("..") });
    log.info({ id: manifest.id, version: manifest.version }, "module installed");
    return { manifest, dir: dest, source, sourceRef };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function removeInstalledFiles(id: string) {
  const dest = resolve(config.modulesDir, id);
  if (dest.startsWith(resolve(config.modulesDir))) rmSync(dest, { recursive: true, force: true });
}
