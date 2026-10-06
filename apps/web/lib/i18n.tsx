"use client";

/**
 * App-level translations. Strings live in `apps/web/locales/<lang>/<area>.json` (flat keys, `{name}`
 * placeholders, plural objects – same format as module locales, see @orbis/sdk `createTranslator`).
 * The language is a hub setting (`language`), exposed publicly through /api/auth/status so the login
 * screen already speaks it; before a hub is known we fall back to the browser language.
 */
import { createTranslator, pickLanguage, type Translator } from "@orbis/sdk";
import { useMemo } from "react";
import de from "@/locales/de";
import en from "@/locales/en";
import { useAuthStatus } from "./queries";

export const LANGUAGES: Array<{ id: string; name: string; flag: string }> = [
  { id: "en", name: "English", flag: "🇬🇧" },
  { id: "de", name: "Deutsch", flag: "🇩🇪" },
];
export const LANGUAGE_IDS = LANGUAGES.map((l) => l.id);

const bundles = { en, de } as const;

export function browserLanguage(): string {
  if (typeof navigator === "undefined") return "en";
  return pickLanguage(navigator.language, LANGUAGE_IDS);
}

/** current ui language: hub setting when known, browser language before that */
export function useLanguage(): string {
  const status = useAuthStatus(false);
  return status.data?.language ?? browserLanguage();
}

const cache = new Map<string, Translator & { language: string }>();
export function appTranslator(language: string): Translator & { language: string } {
  let t = cache.get(language);
  if (!t) {
    t = createTranslator(language, bundles);
    cache.set(language, t);
  }
  return t;
}

/** `const t = useT(); t("shell.nav.settings")` */
export function useT(): Translator & { language: string } {
  const language = useLanguage();
  return useMemo(() => appTranslator(language), [language]);
}

/** hub locale (for Intl formatting) with a sane fallback */
export function useLocale(): string {
  const status = useAuthStatus(false);
  return status.data?.locale ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
}
