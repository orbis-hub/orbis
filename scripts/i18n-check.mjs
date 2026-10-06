#!/usr/bin/env node
// Compares every locale against english: missing keys, extra keys, placeholder mismatches.
// usage: node scripts/i18n-check.mjs   (exit 1 when something is missing)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
let problems = 0;

function placeholders(v) {
  // plural forms other than "other" may drop {count} ("den nächsten tag frei"), so only compare the general form
  const s = typeof v === "string" ? v : v.other ?? Object.values(v).join(" ");
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
}

function compare(label, en, other, lang) {
  const enKeys = new Set(Object.keys(en));
  const missing = [...enKeys].filter((k) => !(k in other));
  const extra = Object.keys(other).filter((k) => !enKeys.has(k));
  const mismatch = [...enKeys].filter((k) => k in other && placeholders(en[k]) !== placeholders(other[k]));
  if (missing.length) { problems += missing.length; console.log(`${label} ${lang}: missing ${missing.length}: ${missing.slice(0, 15).join(", ")}${missing.length > 15 ? " …" : ""}`); }
  if (extra.length) console.log(`${label} ${lang}: extra (not in en) ${extra.length}: ${extra.slice(0, 10).join(", ")}`);
  if (mismatch.length) { problems += mismatch.length; console.log(`${label} ${lang}: placeholder mismatch: ${mismatch.join(", ")}`); }
  if (!missing.length && !extra.length && !mismatch.length) console.log(`${label} ${lang}: ok (${enKeys.size} keys)`);
}

function loadDir(dir) {
  const out = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) Object.assign(out, JSON.parse(readFileSync(join(dir, f), "utf8")));
  return out;
}

// web app: locales/<lang>/*.json
const webLocales = join(root, "apps", "web", "locales");
const webLangs = readdirSync(webLocales).filter((d) => existsSync(join(webLocales, d, "index.ts")));
const webEn = loadDir(join(webLocales, "en"));
for (const lang of webLangs) if (lang !== "en") compare("apps/web", webEn, loadDir(join(webLocales, lang)), lang);

// modules: locales/<lang>.json + manifest.languages
const modulesDir = join(root, "modules");
for (const d of readdirSync(modulesDir)) {
  const mdir = join(modulesDir, d);
  const manifestFile = join(mdir, "module.json");
  if (!existsSync(manifestFile)) continue;
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const ldir = join(mdir, "locales");
  const langs = manifest.languages ?? [];
  if (!existsSync(ldir)) {
    if (langs.length) { problems++; console.log(`${d}: manifest.languages=${langs} but no locales/ folder`); }
    else console.log(`${d}: no translations`);
    continue;
  }
  const files = readdirSync(ldir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  for (const l of langs) if (!files.includes(l)) { problems++; console.log(`${d}: manifest lists "${l}" but locales/${l}.json is missing`); }
  for (const f of files) if (!langs.includes(f)) { problems++; console.log(`${d}: locales/${f}.json exists but "${f}" is not in manifest.languages`); }
  if (!files.includes("en")) { problems++; console.log(`${d}: locales/en.json (fallback) is missing`); continue; }
  const en = JSON.parse(readFileSync(join(ldir, "en.json"), "utf8"));
  for (const k of ["manifest.name", ...manifest.widgets.map((w) => `widget.${w.id}.name`), ...manifest.pages.map((p) => `page.${p.id}.name`)]) if (!(k in en)) console.log(`${d}: en.json has no "${k}" (manifest text stays untranslated)`);
  for (const f of files) if (f !== "en") compare(d, en, JSON.parse(readFileSync(join(ldir, `${f}.json`), "utf8")), f);
}

if (problems) { console.log(`\n${problems} problem(s)`); process.exit(1); }
console.log("\nall locales complete");
