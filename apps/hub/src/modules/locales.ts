/**
 * Loads a module's translation bundles (`dist/locales/<lang>.json`, or `locales/` for dev checkouts)
 * and hands out translators for the hub's current language. Cached per directory and invalidated on reload.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTranslator, type Messages, type Translator } from "@orbis/sdk";
import { childLog } from "../log";
import { getLanguage } from "../services/settings";

const log = childLog("i18n");
const cache = new Map<string, { sig: string; bundles: Record<string, Messages> }>();

function localeDir(dir: string): string | null {
  for (const d of [join(dir, "dist", "locales"), join(dir, "locales")]) if (existsSync(d)) return d;
  return null;
}

/** language → messages for a module directory. Empty object when the module ships no translations. */
export function loadLocales(dir: string | null): Record<string, Messages> {
  if (!dir) return {};
  const ld = localeDir(dir);
  if (!ld) return {};
  let files: string[];
  try {
    files = readdirSync(ld).filter((f) => f.endsWith(".json"));
  } catch {
    return {};
  }
  const sig = files.map((f) => `${f}:${statSync(join(ld, f)).mtimeMs}`).join("|");
  const hit = cache.get(dir);
  if (hit && hit.sig === sig) return hit.bundles;
  const bundles: Record<string, Messages> = {};
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(ld, f), "utf8"));
      if (parsed && typeof parsed === "object") bundles[f.slice(0, -5)] = parsed as Messages;
    } catch (err) {
      log.warn({ file: join(ld, f), err }, "ignoring invalid locale file");
    }
  }
  cache.set(dir, { sig, bundles });
  return bundles;
}

export function evictLocales(dir: string | null) {
  if (dir) cache.delete(dir);
}

/** translator for a module directory in the hub's current (or a given) language */
export function translatorFor(dir: string | null, language = getLanguage()): Translator & { language: string } {
  return createTranslator(language, loadLocales(dir));
}
