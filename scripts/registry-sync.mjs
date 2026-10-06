#!/usr/bin/env node
// Mirrors manifest fields (languages, deps, softDeps, description) of the first-party modules into registry/index.json.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const file = join(root, "registry", "index.json");
const index = JSON.parse(readFileSync(file, "utf8"));
const manifests = new Map();
for (const d of readdirSync(join(root, "modules"))) {
  const mf = join(root, "modules", d, "module.json");
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, "utf8"));
    manifests.set(m.id, m);
  }
}
let changed = 0;
for (const entry of index.modules) {
  const m = manifests.get(entry.id);
  if (!m) continue;
  const next = { ...entry, description: m.description || entry.description, languages: m.languages ?? [], deps: m.deps ?? [], softDeps: m.softDeps ?? [] };
  if (!next.deps.length) delete next.deps;
  if (!next.softDeps.length) delete next.softDeps;
  if (!next.languages.length) delete next.languages;
  if (JSON.stringify(next) !== JSON.stringify(entry)) {
    Object.assign(entry, next);
    changed++;
  }
}
writeFileSync(file, JSON.stringify(index, null, 2) + "\n");
console.log(`registry/index.json: ${changed} entr${changed === 1 ? "y" : "ies"} updated, ${manifests.size} manifests seen`);
