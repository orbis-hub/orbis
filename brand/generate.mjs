// Generates the orbis brand assets (svg + png) into brand/. Run: node brand/generate.mjs
// Everything is pixel art on a grid so it matches the app's retro look; no fonts needed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const out = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(out, "png"), { recursive: true });

const C = {
  pink: "#e2789b",
  pinkDark: "#ff8fb4",
  lavender: "#8b7fd6",
  lavenderDark: "#b0a4ff",
  inkLight: "#3b2c3a",
  inkDark: "#f1e7f0",
  bgLight: "#f4ecf2",
  bgDark: "#17121c",
  paperDark: "#1f1826",
};

/* ---------- the mark: an orbit ring with a core and a satellite, 16×16 ---------- */
// legend: # ring, @ core, * satellite
const MARK = [
  "......####......",
  "....##....##..**",
  "...#........#.**",
  "..#..........#..",
  ".#............#.",
  ".#............#.",
  "#......@@......#",
  "#......@@......#",
  "#..............#",
  "#..............#",
  ".#............#.",
  ".#............#.",
  "..#..........#..",
  "...#........#...",
  "....##....##....",
  "......####......",
];

/* ---------- pixel glyphs for the wordmark (7 rows, baseline at row 6) ---------- */
const GLYPHS = {
  o: ["", "", ".###.", "#...#", "#...#", "#...#", ".###."],
  r: ["", "", "#.##.", "##..#", "#....", "#....", "#...."],
  b: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
  i: ["..#..", ".....", ".##..", "..#..", "..#..", "..#..", ".###."],
  s: ["", "", ".####", "#....", ".###.", "....#", "####."],
};

function rects(grid, colorFor, px, ox = 0, oy = 0) {
  const parts = [];
  grid.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const fill = colorFor(ch);
      if (fill) parts.push(`<rect x="${ox + x * px}" y="${oy + y * px}" width="${px}" height="${px}" fill="${fill}"/>`);
    }),
  );
  return parts.join("");
}

function markSvg({ size = 256, bg = null, ring, core, sat, pad = 0 }) {
  const cells = 16 + pad * 2;
  const px = size / cells;
  const body = rects(MARK, (ch) => (ch === "#" ? ring : ch === "@" ? core : ch === "*" ? sat : null), px, pad * px, pad * px);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ""}${body}</svg>`;
}

function wordmarkSvg({ px = 10, ink, ring, core, sat, bg = null, withMark = true, text = "orbis", padding = 2 }) {
  const gap = 1; // cells between letters
  const letters = [...text].map((c) => GLYPHS[c]);
  const textW = letters.reduce((w, g) => w + 5 + gap, 0) - gap;
  const markW = withMark ? 16 + 3 : 0; // mark + 3 cells gap
  const cellsW = padding * 2 + markW + textW;
  const cellsH = padding * 2 + 16;
  const W = cellsW * px;
  const H = cellsH * px;
  let body = "";
  let ox = padding;
  if (withMark) {
    body += rects(MARK, (ch) => (ch === "#" ? ring : ch === "@" ? core : ch === "*" ? sat : null), px, ox * px, padding * px);
    ox += markW;
  }
  // text block is 7 rows tall; vertically center it on the mark (16 rows): offset = (16-7)/2 = 4.5 → use 4 (looks optically right)
  const oy = padding + 4;
  for (const g of letters) {
    body += rects(g, (ch) => (ch === "#" ? ink : null), px, ox * px, oy * px);
    ox += 5 + gap;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges">${bg ? `<rect width="${W}" height="${H}" fill="${bg}"/>` : ""}${body}</svg>`;
}

const files = {
  // marks
  "logo.svg": markSvg({ ring: C.pink, core: C.lavender, sat: C.lavender }),
  "logo-dark.svg": markSvg({ ring: C.pinkDark, core: C.lavenderDark, sat: C.lavenderDark }),
  "logo-mono.svg": markSvg({ ring: "currentColor", core: "currentColor", sat: "currentColor" }),
  "logo-tile.svg": markSvg({ bg: C.paperDark, ring: C.pinkDark, core: C.lavenderDark, sat: C.lavenderDark, pad: 2 }),
  // wordmarks
  "wordmark.svg": wordmarkSvg({ ink: C.inkLight, ring: C.pink, core: C.lavender, sat: C.lavender }),
  "wordmark-dark.svg": wordmarkSvg({ ink: C.inkDark, ring: C.pinkDark, core: C.lavenderDark, sat: C.lavenderDark }),
  "wordmark-text.svg": wordmarkSvg({ ink: "currentColor", withMark: false }),
};
for (const [name, svg] of Object.entries(files)) writeFileSync(join(out, name), svg + "\n");

// theme-aware wordmark for READMEs (github honours prefers-color-scheme inside svg)
const wmLight = files["wordmark.svg"].replace(/<\/?svg[^>]*>\n?/g, "");
const wmDark = files["wordmark-dark.svg"].replace(/<\/?svg[^>]*>\n?/g, "");
const dims = files["wordmark.svg"].match(/viewBox="([^"]+)" width="(\d+)" height="(\d+)"/);
writeFileSync(
  join(out, "wordmark-auto.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${dims[1]}" width="${dims[2]}" height="${dims[3]}" shape-rendering="crispEdges"><style>.l{display:inline}.d{display:none}@media (prefers-color-scheme: dark){.l{display:none}.d{display:inline}}</style><g class="l">${wmLight}</g><g class="d">${wmDark}</g></svg>\n`,
);

/* ---------- pngs ---------- */
async function png(svg, name, width, height = width) {
  await sharp(Buffer.from(svg), { density: 300 }).resize(width, height, { kernel: "nearest" }).png().toFile(join(out, "png", name));
}
await png(files["logo-tile.svg"], "avatar-512.png", 512);
await png(files["logo-tile.svg"], "avatar-1024.png", 1024);
await png(files["logo.svg"], "logo-256.png", 256);
await png(files["logo-dark.svg"], "logo-dark-256.png", 256);
await png(files["wordmark.svg"], "wordmark-light.png", 1200, Math.round((1200 * Number(dims[3])) / Number(dims[2])));
await png(files["wordmark-dark.svg"], "wordmark-dark.png", 1200, Math.round((1200 * Number(dims[3])) / Number(dims[2])));

// social preview 1280×640: dark paper, big wordmark, tagline as pixel text is overkill → keep it to the wordmark + subtle starfield dots
{
  const W = 1280, H = 640, px = 14;
  const wm = wordmarkSvg({ px, ink: C.inkDark, ring: C.pinkDark, core: C.lavenderDark, sat: C.lavenderDark, padding: 0 });
  const [, , wW, wH] = wm.match(/viewBox="([^"]+)" width="(\d+)" height="(\d+)"/);
  const inner = wm.replace(/<\/?svg[^>]*>\n?/g, "");
  let stars = "";
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 90; i++) {
    const s = rnd() < 0.2 ? 4 : 2;
    stars += `<rect x="${Math.floor(rnd() * W)}" y="${Math.floor(rnd() * H)}" width="${s}" height="${s}" fill="${rnd() < 0.15 ? C.pinkDark : rnd() < 0.3 ? C.lavenderDark : "#fff"}" fill-opacity="${(0.15 + rnd() * 0.5).toFixed(2)}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges"><rect width="${W}" height="${H}" fill="${C.bgDark}"/>${stars}<g transform="translate(${(W - wW) / 2} ${(H - wH) / 2 - 20})">${inner}</g><rect x="${W / 2 - 170}" y="${H / 2 + wH / 2 + 10}" width="340" height="3" fill="${C.pinkDark}" fill-opacity="0.6"/></svg>`;
  writeFileSync(join(out, "social-preview.svg"), svg + "\n");
  await png(svg, "social-preview.png", W, H);
}

console.log("brand assets written to", out);
