// Generates the web app favicons from the brand svgs into apps/web/public/. Run: node brand/favicons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../apps/web/public");
mkdirSync(out, { recursive: true });

const tile = readFileSync(join(here, "logo-tile.svg")); // logo on the dark paper tile, for app icons
const favicon = readFileSync(join(out, "icon.svg")); // the small pixel mark used in the tab

const png = (svg, size) => sharp(svg, { density: 300 }).resize(size, size, { kernel: "nearest" }).png().toBuffer();

/** ico container with png entries (every modern browser reads those) */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = [];
  let offset = 6 + entries.length * 16;
  for (const { size, buf } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.buf)]);
}

const sizes = [16, 32, 48];
const favs = await Promise.all(sizes.map(async (s) => ({ size: s, buf: await png(favicon, s) })));
writeFileSync(join(out, "favicon.ico"), ico(favs));
writeFileSync(join(out, "favicon-16.png"), favs[0].buf);
writeFileSync(join(out, "favicon-32.png"), favs[1].buf);
writeFileSync(join(out, "apple-touch-icon.png"), await png(tile, 180));
writeFileSync(join(out, "icon-192.png"), await png(tile, 192));
writeFileSync(join(out, "icon-512.png"), await png(tile, 512));
// maskable: same tile with extra safe-zone padding (icon in the inner 80 %)
const inner = await png(tile, 410);
writeFileSync(
  join(out, "icon-maskable-512.png"),
  await sharp({ create: { width: 512, height: 512, channels: 4, background: "#1f1826" } })
    .composite([{ input: inner, left: 51, top: 51 }])
    .png()
    .toBuffer(),
);
console.log("favicons written to apps/web/public");
