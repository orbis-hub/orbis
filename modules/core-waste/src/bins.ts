import type { BinType } from "./types";

/** Default colour and pixel icon per bin type. Colours follow the usual german bin lids. */
export const BIN_STYLE: Record<BinType, { color: string; icon: string }> = {
  residual: { color: "#4b4b4b", icon: "trash" },
  organic: { color: "#7a4b1f", icon: "leaf" },
  paper: { color: "#2f6fd6", icon: "file-text" },
  packaging: { color: "#e3b916", icon: "shopping-bag" },
  glass: { color: "#3aa655", icon: "coffee" },
  bulky: { color: "#8a6f5c", icon: "sofa" },
  hazardous: { color: "#d6372f", icon: "warning-diamond" },
  christmas: { color: "#1f7a3a", icon: "tree-pine" },
  custom: { color: "#8c8c8c", icon: "trash" },
};

/** "Würzburg" → "wuerzburg", strips diacritics, keeps letters/digits/spaces. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same as `normalize` but with umlauts collapsed to the base vowel (ü → u) so "Wurzburg" also matches. */
export function normalizeLoose(s: string): string {
  return normalize(s).replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u");
}

/** keyword lists per type, checked in this order (first hit wins) */
const KEYWORDS: Array<[BinType, string[]]> = [
  ["christmas", ["weihnacht", "tannenbaum", "christbaum", "christmas tree", "xmas"]],
  ["hazardous", ["schadstoff", "sondermuell", "sonderabfall", "problemstoff", "giftmobil", "hazardous", "chemical"]],
  ["bulky", ["sperr", "bulky", "sperrgut"]],
  ["glass", ["glas", "glass", "altglas"]],
  ["paper", ["papier", "pappe", "karton", "altpapier", "paper", "cardboard", "blaue"]],
  ["packaging", ["gelb", "wertstoff", "verpackung", "leichtverpackung", "lvp", "dsd", "plastik", "kunststoff", "recycling", "packaging", "yellow"]],
  ["residual", ["restmuell", "restabfall", "rest", "hausmuell", "graue", "schwarze", "residual", "general waste", "refuse", "rubbish"]],
  ["organic", ["bio", "gruen", "garten", "kompost", "organic", "food", "garden", "green"]],
];

/** short provider codes like "WITT_GELB" / "DA_REST_2W" */
const CODES: Array<[BinType, string[]]> = [
  ["christmas", ["weih", "tanne", "xmas"]],
  ["hazardous", ["schad", "sonder"]],
  ["bulky", ["sperr"]],
  ["glass", ["glas"]],
  ["paper", ["pap"]],
  ["packaging", ["gelb", "wert", "lvp", "dsd"]],
  ["residual", ["rest", "haus"]],
  ["organic", ["bio"]],
];

/**
 * Map a provider title / ics summary (and optionally the provider code) to a bin type.
 * "Rest- und Biomüll" → residual, "Wertstofftonne" → packaging, "Weihnachtsbaum" → christmas, unknown → custom.
 */
export function mapTrashName(title: string, code?: string | null): BinType {
  const n = normalize(title);
  if (n) for (const [type, words] of KEYWORDS) if (words.some((w) => n.includes(w))) return type;
  if (code) {
    const c = normalize(code.replace(/^[A-Z]{1,6}_/, ""));
    for (const [type, words] of CODES) if (words.some((w) => c.includes(w))) return type;
  }
  return "custom";
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(s);
}

/** provider colours come as "f3f880" / "FFFF00"; returns "#rrggbb" or null */
export function providerColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const h = raw.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(h)) return `#${h}`;
  if (/^[0-9a-f]{3}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  return null;
}
