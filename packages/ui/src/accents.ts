/** Accent presets a dashboard can pick. Light and dark variants of --accent / --accent-2 / --accent-soft; everything else follows. */
export type Accent = { id: string; name: string; light: [string, string, string]; dark: [string, string, string] };

export const ACCENTS: Accent[] = [
  { id: "sakura", name: "sakura (default)", light: ["#e2789b", "#8b7fd6", "#fbe3ec"], dark: ["#ff8fb4", "#b0a4ff", "#3a2a3f"] },
  { id: "lavender", name: "lavender", light: ["#8b7fd6", "#e2789b", "#e9e4fb"], dark: ["#b0a4ff", "#ff8fb4", "#2d2a44"] },
  { id: "summer", name: "summer", light: ["#ec7f47", "#2f9fbf", "#ffe6d3"], dark: ["#ffb066", "#6fd3ea", "#33302a"] },
  { id: "autumn", name: "autumn", light: ["#d9702e", "#8a6d1e", "#fbe3cf"], dark: ["#ff9a4a", "#e0b34a", "#3d2a1f"] },
  { id: "winter", name: "winter", light: ["#4f93d6", "#8e86d9", "#ddebf8"], dark: ["#8cc8ff", "#b7b0ff", "#26304a"] },
  { id: "forest", name: "forest", light: ["#2e9d5c", "#4f93d6", "#dcf3e4"], dark: ["#5fd48a", "#8cc8ff", "#223a2c"] },
  { id: "halloween", name: "halloween", light: ["#f2701a", "#7d4fd6", "#ffe3cc"], dark: ["#ff8c2e", "#a985ff", "#3a2440"] },
  { id: "mono", name: "mono", light: ["#3b2c3a", "#7a6478", "#ece6ea"], dark: ["#f1e7f0", "#b39fb0", "#3a3340"] },
];

export function accentById(id: string | null | undefined) {
  return ACCENTS.find((a) => a.id === id) ?? null;
}

/* ---------- contrast helpers (wcag 2.x) ---------- */

/** Hub surfaces text sits on; mirror of --paper / --paper-2 / --bg in styles.css. Text inks are derived against the hardest one. */
export const SURFACES = {
  light: ["#fffaf9", "#f9eef4", "#f4ecf2"],
  dark: ["#1f1826", "#291f32", "#17121c"],
} as const;

/** WCAG AA for normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** Candidate inks for text sitting on an accent fill (buttons): the dark paper, or white when the accent itself is dark. */
const ON_ACCENT_CANDIDATES = ["#1f1826", "#ffffff"];

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/**
 * Nudge a colour's HSL lightness (down for light surfaces, up for dark ones) in 1 % steps until it reaches
 * `min` contrast against every surface. Hue stays and saturation eases off 0.5 % per step, so the ink still
 * reads as "the accent" without going neon.
 */
export function inkFor(hex: string, surfaces: readonly string[], dark: boolean, min = MIN_TEXT_CONTRAST): string {
  const passes = (c: string) => surfaces.every((s) => contrastRatio(c, s) >= min);
  if (passes(hex)) return hex.toLowerCase();
  let [h, s, l] = rgbToHsl(hexToRgb(hex));
  const step = dark ? 0.01 : -0.01;
  for (let i = 0; i < 100; i++) {
    l += step;
    s = Math.max(0, s - 0.005);
    if (l < 0 || l > 1) break;
    const c = rgbToHex(hslToRgb([h, s, l]));
    if (passes(c)) return c;
  }
  return dark ? "#ffffff" : "#000000";
}

/** Text ink for a solid accent fill: whichever of dark paper / white contrasts more. */
export function onAccent(fill: string): string {
  return ON_ACCENT_CANDIDATES.map((c) => [c, contrastRatio(c, fill)] as const).sort((a, b) => b[1] - a[1])[0]![0];
}

export type AccentTokens = {
  "--accent": string;
  "--accent-2": string;
  "--accent-soft": string;
  /** accent darkened/lightened for text and icons on paper surfaces and on --accent-soft */
  "--accent-ink": string;
  "--accent-2-ink": string;
  /** text on a solid --accent fill (primary buttons, checked boxes) */
  "--on-accent": string;
};

const tokenCache = new Map<string, AccentTokens>();

/** Full token set for a preset in one theme; inks are derived once and cached. */
export function accentTokens(a: Accent, dark: boolean): AccentTokens {
  const key = a.id + (dark ? ":dark" : ":light");
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const [accent, accent2, soft] = dark ? a.dark : a.light;
  // chips put accent text on --accent-soft, so the soft tint is a surface too
  const surfaces = [...(dark ? SURFACES.dark : SURFACES.light), soft];
  const t: AccentTokens = {
    "--accent": accent,
    "--accent-2": accent2,
    "--accent-soft": soft,
    "--accent-ink": inkFor(accent, surfaces, dark),
    "--accent-2-ink": inkFor(accent2, surfaces, dark),
    "--on-accent": onAccent(accent),
  };
  tokenCache.set(key, t);
  return t;
}

/** Inline style that re-themes a subtree. Dark mode is detected from <html data-theme> or the system. */
export function accentStyle(id: string | null | undefined, dark: boolean): Record<string, string> {
  const a = accentById(id);
  if (!a) return {};
  return { ...accentTokens(a, dark) };
}

export function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
