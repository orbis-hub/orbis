import type { RegistryEntry, RegistryIndex } from "@orbis/sdk";
import { config } from "../config";
import { childLog } from "../log";
import { getSetting } from "../services/settings";

const log = childLog("registry");

type Cached = { at: number; index: RegistryIndex; url: string };
const cache = new Map<string, Cached>();
const TTL = 10 * 60_000;

export function registryUrls(): string[] {
  const extra = getSetting("registries");
  return [...new Set([...config.registries, ...extra])];
}

export async function fetchRegistry(url: string, force = false): Promise<RegistryIndex> {
  const hit = cache.get(url);
  if (hit && !force && Date.now() - hit.at < TTL) return hit.index;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`registry ${url}: HTTP ${res.status}`);
  const json = (await res.json()) as Partial<RegistryIndex>;
  const index: RegistryIndex = { name: json.name ?? url, modules: Array.isArray(json.modules) ? json.modules : [] };
  cache.set(url, { at: Date.now(), index, url });
  return index;
}

export type RegistryModule = RegistryEntry & { registry: string };

export async function fetchAllRegistries(force = false): Promise<{ modules: RegistryModule[]; errors: Array<{ url: string; error: string }> }> {
  const modules: RegistryModule[] = [];
  const errors: Array<{ url: string; error: string }> = [];
  await Promise.all(
    registryUrls().map(async (url) => {
      try {
        const idx = await fetchRegistry(url, force);
        for (const m of idx.modules) modules.push({ ...m, registry: url });
      } catch (err) {
        log.warn({ url, err: (err as Error).message }, "registry fetch failed");
        errors.push({ url, error: (err as Error).message });
      }
    }),
  );
  return { modules, errors };
}

/** `github:owner/repo` or a GitHub URL → tarball URL of the release asset `module.tgz`. */
export function tarballUrlFor(entry: RegistryEntry, version = entry.latest): string {
  if (entry.tarball) return entry.tarball.replace(/\{version\}/g, version);
  const repo = normalizeRepo(entry.repo);
  if (!repo) throw new Error(`cannot derive tarball for ${entry.id}: unknown repo format "${entry.repo}"`);
  return `https://github.com/${repo}/releases/download/v${version}/module.tgz`;
}

export function normalizeRepo(repo: string | undefined): string | null {
  if (!repo) return null;
  const gh = repo.match(/^github:([^/]+\/[^/]+)$/);
  if (gh) return gh[1]!;
  const url = repo.match(/github\.com\/([^/]+\/[^/#?]+)/);
  if (url) return url[1]!.replace(/\.git$/, "");
  if (/^[^/]+\/[^/]+$/.test(repo)) return repo;
  return null;
}
