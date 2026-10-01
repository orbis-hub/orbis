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

/** Inline style that re-themes a subtree. Dark mode is detected from <html data-theme> or the system. */
export function accentStyle(id: string | null | undefined, dark: boolean): Record<string, string> {
  const a = accentById(id);
  if (!a) return {};
  const [accent, accent2, soft] = dark ? a.dark : a.light;
  return { "--accent": accent, "--accent-2": accent2, "--accent-soft": soft };
}

export function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true;
  if (t === "light") return false;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
