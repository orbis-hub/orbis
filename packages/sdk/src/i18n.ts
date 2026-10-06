/**
 * Tiny translation layer shared by the hub, the web app and module bundles.
 *
 * A locale file is a flat json object: `{ "widget.today.empty": "nobody yet", "greeting": "hi {name}" }`.
 * Keys are free-form; by convention `manifest.*`, `widget.<id>.*` and `page.<id>.*` describe the manifest
 * (see `localizeManifest`) and everything else is up to the module.
 * Placeholders are `{name}`; a `{count}` placeholder also picks a plural form when the message is an
 * object: `{ "one": "{count} task", "other": "{count} tasks" }`.
 */

export type MessageValue = string | { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type Messages = Record<string, MessageValue>;
export type TranslateVars = Record<string, string | number | boolean | null | undefined>;
export type Translator = (key: string, vars?: TranslateVars) => string;

/** English is always the last fallback. */
export const FALLBACK_LANGUAGE = "en";

/** "de-DE" → ["de-DE", "de"]; "en" → ["en"] */
export function languageChain(language: string | null | undefined): string[] {
  const out: string[] = [];
  const lang = (language ?? "").trim();
  if (!lang) return [FALLBACK_LANGUAGE];
  out.push(lang);
  const base = lang.split("-")[0]!;
  if (base !== lang) out.push(base);
  if (!out.includes(FALLBACK_LANGUAGE)) out.push(FALLBACK_LANGUAGE);
  return out;
}

/** Pick the best available language for a wanted one: wanted → its base → fallback → first available. */
export function pickLanguage(wanted: string | null | undefined, available: string[]): string {
  for (const l of languageChain(wanted)) if (available.includes(l)) return l;
  return available[0] ?? FALLBACK_LANGUAGE;
}

function interpolate(msg: string, vars?: TranslateVars): string {
  if (!vars) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

function pluralRule(language: string): Intl.PluralRules | null {
  try {
    return new Intl.PluralRules(language);
  } catch {
    return null;
  }
}

/**
 * Build a translator from a language → messages map. Lookup order follows `languageChain(language)`,
 * and an unknown key returns the key itself (so missing strings are visible, never empty).
 */
export function createTranslator(language: string | null | undefined, bundles: Record<string, Messages | undefined>): Translator & { language: string } {
  const chain = languageChain(language);
  const rules = pluralRule(chain[0]!);
  const t = ((key: string, vars?: TranslateVars) => {
    for (const lang of chain) {
      const v = bundles[lang]?.[key];
      if (v === undefined) continue;
      if (typeof v === "string") return interpolate(v, vars);
      const n = typeof vars?.count === "number" ? vars.count : Number(vars?.count);
      const cat = Number.isFinite(n) && rules ? rules.select(n) : "other";
      const form = (n === 0 && v.zero) || v[cat] || v.other;
      return interpolate(form, vars);
    }
    return key;
  }) as Translator & { language: string };
  t.language = chain[0]!;
  return t;
}

type ManifestLike = {
  name: string;
  description?: string;
  widgets?: Array<{ id: string; name: string; description?: string }>;
  pages?: Array<{ id: string; name: string }>;
};

/**
 * Return a copy of a manifest with `name`, `description`, widget and page names replaced by the
 * translations in `t` when present. Keys: `manifest.name`, `manifest.description`,
 * `widget.<id>.name`, `widget.<id>.description`, `page.<id>.name`.
 */
export function localizeManifest<T extends ManifestLike>(manifest: T, t: Translator): T {
  const pick = (key: string, fallback: string | undefined) => {
    const v = t(key);
    return v === key ? fallback : v;
  };
  return {
    ...manifest,
    name: pick("manifest.name", manifest.name) ?? manifest.name,
    description: pick("manifest.description", manifest.description),
    widgets: manifest.widgets?.map((w) => ({ ...w, name: pick(`widget.${w.id}.name`, w.name) ?? w.name, description: pick(`widget.${w.id}.description`, w.description) })),
    pages: manifest.pages?.map((p) => ({ ...p, name: pick(`page.${p.id}.name`, p.name) ?? p.name })),
  };
}
