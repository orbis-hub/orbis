#!/usr/bin/env node
// Checks the design tokens in packages/ui/src/styles.css (light + dark) and every accent preset in
// packages/ui/src/accents.ts against the WCAG 2 contrast formula.
// usage: node scripts/contrast-check.mjs   (exit 1 when a text pair is below 4.5:1)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// accents.ts is plain TypeScript (type annotations only); node >= 22.18 / 23.6 strips those natively.
if (!process.features.typescript) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const root = new URL("..", import.meta.url);
const cssPath = new URL("packages/ui/src/styles.css", root);
const accentsUrl = pathToFileURL(new URL("packages/ui/src/accents.ts", root).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
const { ACCENTS, accentTokens, contrastRatio, SURFACES, MIN_TEXT_CONTRAST } = await import(accentsUrl.href);

const TEXT = MIN_TEXT_CONTRAST; // 4.5:1, AA normal text
const UI = 3; // 3:1, AA non-text (borders, focus rings, icons)

/* ---------- read the token blocks out of styles.css ---------- */
const css = readFileSync(cssPath, "utf8");
function block(selector) {
  const i = css.indexOf(selector + " {");
  if (i < 0) throw new Error(`token block "${selector}" not found in styles.css`);
  const body = css.slice(i, css.indexOf("}", i));
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}
const light = block(":root");
const dark = { ...light, ...block(':root[data-theme="dark"]') };
const media = { ...light, ...block(':root:not([data-theme="light"])') };

let failures = 0;
let warnings = 0;
const rows = [];

function check(scope, fg, bg, fgName, bgName, min) {
  const r = contrastRatio(fg, bg);
  const ok = r >= min;
  const kind = min === TEXT ? "text" : "ui";
  if (!ok) min === TEXT ? failures++ : warnings++;
  rows.push([ok ? "ok  " : min === TEXT ? "FAIL" : "warn", scope, kind, `${fgName} on ${bgName}`, `${fg} / ${bg}`, r.toFixed(2)]);
}

/* ---------- theme tokens ---------- */
function checkTheme(name, t) {
  const surfaces = ["--paper", "--paper-2", "--bg", "--accent-soft"];
  const text = ["--ink", "--ink-soft", "--accent-ink", "--accent-2-ink", "--dnd", "--ok-ink", "--idle-ink"];
  for (const fg of text) for (const bg of surfaces) check(name, t[fg], t[bg], fg, bg, TEXT);
  check(name, t["--on-accent"], t["--accent"], "--on-accent", "--accent", TEXT);
  // non-text: borders and focus marks on the card
  for (const fg of ["--line", "--accent", "--accent-2"]) check(name, t[fg], t["--paper"], fg, "--paper", UI);
}
checkTheme("light", light);
checkTheme("dark", dark);

// the system-dark media block must carry the same values as the explicit dark block
for (const k of Object.keys(dark)) {
  if (media[k] !== dark[k]) {
    failures++;
    rows.push(["FAIL", "dark", "sync", `${k} differs between [data-theme=dark] and the prefers-color-scheme block`, `${dark[k]} / ${media[k]}`, "-"]);
  }
}

/* ---------- accent presets ---------- */
for (const a of ACCENTS) {
  for (const isDark of [false, true]) {
    const scope = `${a.id}/${isDark ? "dark" : "light"}`;
    const t = accentTokens(a, isDark);
    const surfaces = [...(isDark ? SURFACES.dark : SURFACES.light), t["--accent-soft"]];
    const names = ["--paper", "--paper-2", "--bg", "--accent-soft"];
    for (const [fg, fgName] of [[t["--accent-ink"], "--accent-ink"], [t["--accent-2-ink"], "--accent-2-ink"]])
      surfaces.forEach((bg, i) => check(scope, fg, bg, fgName, names[i], TEXT));
    check(scope, t["--on-accent"], t["--accent"], "--on-accent", "--accent", TEXT);
    check(scope, t["--accent"], surfaces[0], "--accent", "--paper", UI);
  }
}

// SURFACES in accents.ts mirrors the stylesheet; the default theme is the sakura preset
const drift = [];
const expect = { light: [light["--paper"], light["--paper-2"], light["--bg"]], dark: [dark["--paper"], dark["--paper-2"], dark["--bg"]] };
for (const k of ["light", "dark"]) if (SURFACES[k].join() !== expect[k].join()) drift.push(`SURFACES.${k} ${SURFACES[k].join()} != styles.css ${expect[k].join()}`);
const sakura = ACCENTS.find((a) => a.id === "sakura");
for (const [theme, t] of [["light", light], ["dark", dark]]) {
  const p = accentTokens(sakura, theme === "dark");
  for (const k of Object.keys(p)) if (p[k] !== t[k]) drift.push(`${theme} ${k}: styles.css ${t[k]} != sakura preset ${p[k]}`);
}
for (const d of drift) {
  failures++;
  rows.push(["FAIL", "sync", "sync", d, "", "-"]);
}

/* ---------- report ---------- */
const w = rows.reduce((m, r) => r.map((c, i) => Math.max(m[i] ?? 0, String(c).length)), []);
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join("  "));
console.log();
console.log(`${rows.length} pairs checked, ${failures} text failure(s) below ${TEXT}:1, ${warnings} non-text warning(s) below ${UI}:1`);
process.exit(failures ? 1 : 0);
