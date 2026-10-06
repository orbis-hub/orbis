import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import type { EinkDisplay } from "@orbis/sdk";
import type { EinkRequest, EinkTapResult, EinkTree } from "@orbis/sdk/server";
import { ICONS } from "@orbis/ui/icons";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import satori from "satori";
import { getDb, now, schema } from "../db";
import { childLog } from "../log";
import * as runtime from "../modules/runtime";
import { getDashboard } from "./dashboards";
import { getAllSettings } from "./settings";

const log = childLog("eink");

/* ---------- displays ---------- */

function toPublic(r: typeof schema.einkDisplays.$inferSelect, withToken = false): EinkDisplay {
  return {
    id: r.id,
    name: r.name,
    width: r.width,
    height: r.height,
    dashboardId: r.dashboardId,
    rotate: r.rotate as EinkDisplay["rotate"],
    invert: r.invert,
    grayscale: r.grayscale,
    refreshMinutes: r.refreshMinutes,
    board: r.board,
    lastSeen: r.lastSeen,
    battery: r.battery,
    createdAt: r.createdAt,
    ...(withToken ? { token: r.token } : {}),
  };
}

export function dashboardExists(id: string) {
  return !!getDb().select({ id: schema.dashboards.id }).from(schema.dashboards).where(eq(schema.dashboards.id, id)).get();
}

/** max length of the `x-orbis-board` header a device may report */
export const BOARD_MAX = 64;
export function cleanBoard(v: string | null | undefined): string | null {
  if (!v) return null;
  // printable characters only, capped — the string ends up on the e-ink settings page
  const s = v.replace(/[^\x20-\x7e -￿]/g, "").trim().slice(0, BOARD_MAX);
  return s || null;
}

/**
 * Lazy cleanup (#40): a display whose dashboard was deleted (or went away with its user) is detached
 * the next time anyone looks at it, so the list shows `dashboardId: null` and the panel renders the
 * "no dashboard" state instead of nothing.
 */
function detachIfGone(r: typeof schema.einkDisplays.$inferSelect) {
  if (r.dashboardId && !dashboardExists(r.dashboardId)) {
    log.info({ display: r.id, dashboardId: r.dashboardId }, "dashboard gone, detaching display");
    getDb().update(schema.einkDisplays).set({ dashboardId: null }).where(eq(schema.einkDisplays.id, r.id)).run();
    r.dashboardId = null;
  }
  return r;
}

export function listDisplays() {
  return getDb()
    .select()
    .from(schema.einkDisplays)
    .all()
    .map((r) => toPublic(detachIfGone(r)));
}

export function getDisplay(id: string) {
  const r = getDb().select().from(schema.einkDisplays).where(eq(schema.einkDisplays.id, id)).get();
  return r ? toPublic(detachIfGone(r), true) : null;
}

export function findByToken(token: string) {
  const r = getDb().select().from(schema.einkDisplays).where(eq(schema.einkDisplays.token, token)).get();
  return r ? toPublic(detachIfGone(r), true) : null;
}

/** frame size in pixels after rotation – the coordinate space of taps and of the rendered image */
export function frameSize(display: Pick<EinkDisplay, "width" | "height" | "rotate">) {
  const landscape = display.rotate === 0 || display.rotate === 180;
  return { W: landscape ? display.width : display.height, H: landscape ? display.height : display.width };
}

export function createDisplay(input: { name: string; width: number; height: number; dashboardId?: string | null; grayscale?: number; refreshMinutes?: number; rotate?: number; invert?: boolean; board?: string | null }) {
  const id = nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, "x");
  const token = randomBytes(24).toString("base64url");
  getDb()
    .insert(schema.einkDisplays)
    .values({
      id,
      name: input.name,
      token,
      width: input.width,
      height: input.height,
      dashboardId: input.dashboardId ?? null,
      rotate: input.rotate ?? 0,
      invert: input.invert ?? false,
      grayscale: input.grayscale ?? 1,
      refreshMinutes: input.refreshMinutes ?? 10,
      board: cleanBoard(input.board),
      createdAt: now(),
    })
    .run();
  return getDisplay(id)!;
}

export function updateDisplay(id: string, patch: Partial<Omit<EinkDisplay, "id" | "createdAt" | "token" | "lastSeen" | "battery">>) {
  const set: Partial<typeof schema.einkDisplays.$inferInsert> = {};
  for (const k of ["name", "width", "height", "dashboardId", "rotate", "invert", "grayscale", "refreshMinutes", "board"] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  }
  if (set.board !== undefined) set.board = cleanBoard(set.board);
  if (!Object.keys(set).length) return getDisplay(id);
  getDb().update(schema.einkDisplays).set(set).where(eq(schema.einkDisplays.id, id)).run();
  return getDisplay(id);
}

export function rotateToken(id: string) {
  getDb().update(schema.einkDisplays).set({ token: randomBytes(24).toString("base64url") }).where(eq(schema.einkDisplays.id, id)).run();
  return getDisplay(id);
}

/** true when a display was actually removed */
export function deleteDisplay(id: string) {
  return getDb().delete(schema.einkDisplays).where(eq(schema.einkDisplays.id, id)).run().changes > 0;
}

export function touchDisplay(id: string, info: { battery?: number | null; board?: string | null }) {
  const set: Partial<typeof schema.einkDisplays.$inferInsert> = { lastSeen: now() };
  if (info.battery !== undefined && info.battery !== null && Number.isFinite(info.battery)) set.battery = Math.max(0, Math.min(100, Math.round(info.battery)));
  const board = cleanBoard(info.board);
  if (board) set.board = board;
  getDb().update(schema.einkDisplays).set(set).where(eq(schema.einkDisplays.id, id)).run();
}

/* ---------- fonts ---------- */

const here = dirname(fileURLToPath(import.meta.url));
let fonts: Array<{ name: string; data: Buffer; weight: 400 | 700; style: "normal" }> | null = null;
function loadFonts() {
  if (fonts) return fonts;
  const dir = [resolve(here, "../assets/fonts"), resolve(here, "../../assets/fonts"), resolve(process.cwd(), "apps/hub/assets/fonts"), resolve(process.cwd(), "assets/fonts")].find((d) => {
    try {
      readFileSync(resolve(d, "DotGothic16-Regular.ttf"));
      return true;
    } catch {
      return false;
    }
  });
  if (!dir) throw new Error("e-ink fonts not found (apps/hub/assets/fonts)");
  fonts = [
    { name: "DotGothic16", data: readFileSync(resolve(dir, "DotGothic16-Regular.ttf")), weight: 400, style: "normal" },
    { name: "IBM Plex Mono", data: readFileSync(resolve(dir, "IBMPlexMono-Regular.ttf")), weight: 400, style: "normal" },
    { name: "IBM Plex Mono", data: readFileSync(resolve(dir, "IBMPlexMono-Bold.ttf")), weight: 700, style: "normal" },
  ];
  return fonts;
}

/* ---------- EinkTree → satori element tree ---------- */

type El = { type: string; props: Record<string, unknown> };
let monochrome = false; // set per render: 1-bit panels get solid black instead of grays
const gray = (g: number | undefined, d = 0) => {
  let level = Math.min(1, Math.max(0, g ?? d));
  if (monochrome && level > 0.15) level = 1;
  const v = Math.round(255 * (1 - level));
  return `rgb(${v},${v},${v})`;
};
// satori chokes on undefined style values (it calls .trim() on them), so strip them here
function clean(props: Record<string, unknown>) {
  const style = props.style as Record<string, unknown> | undefined;
  if (style) props.style = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined && v !== null));
  return props;
}
const el = (type: string, props: Record<string, unknown>, children?: unknown): El => ({ type, props: clean(children === undefined ? { ...props } : { ...props, children }) });

function treeToEl(t: EinkTree, key: number): El {
  switch (t.type) {
    case "text":
      return el(
        "div",
        {
          key,
          style: {
            display: "flex",
            fontFamily: t.pixel === false ? "IBM Plex Mono" : "DotGothic16",
            fontWeight: t.bold ? 700 : 400,
            fontSize: t.size ?? 16,
            color: gray(t.gray, 1),
            textAlign: t.align ?? "left",
            justifyContent: t.align === "center" ? "center" : t.align === "right" ? "flex-end" : "flex-start",
            whiteSpace: t.wrap === false ? "nowrap" : "pre-wrap",
            overflow: "hidden",
            flexGrow: t.grow ?? 0,
            minWidth: 0,
            lineHeight: 1.2,
          },
        },
        t.text,
      );
    case "row":
    case "col":
      return el(
        "div",
        {
          key,
          style: {
            display: "flex",
            flexDirection: t.type === "row" ? "row" : "column",
            gap: t.gap ?? 0,
            padding: t.pad ?? 0,
            alignItems: t.align === "start" ? "flex-start" : t.align === "end" ? "flex-end" : (t.align ?? "stretch"),
            justifyContent: t.justify === "between" ? "space-between" : t.justify === "end" ? "flex-end" : t.justify === "center" ? "center" : "flex-start",
            flexGrow: t.grow ?? 0,
            width: t.width,
            height: t.height,
            minWidth: 0,
            minHeight: 0,
          },
        },
        t.children.map(treeToEl),
      );
    case "box":
      return el(
        "div",
        {
          key,
          style: {
            display: "flex",
            flexDirection: "column",
            border: `${t.border ?? 2}px solid #000`,
            padding: t.pad ?? 6,
            backgroundColor: t.fill !== undefined ? gray(t.fill) : "#fff",
            flexGrow: t.grow ?? 0,
            width: t.width,
            height: t.height,
            minWidth: 0,
            minHeight: 0,
          },
        },
        t.children.map(treeToEl),
      );
    case "rule":
      return el("div", {
        key,
        style: t.vertical
          ? { display: "flex", width: 2, alignSelf: "stretch", borderLeft: `2px ${t.dashed ? "dashed" : "solid"} #000` }
          : { display: "flex", height: 2, width: "100%", borderTop: `2px ${t.dashed ? "dashed" : "solid"} #000` },
      });
    case "spacer":
      return el("div", { key, style: { display: "flex", width: t.size ?? 0, height: t.size ?? 0, flexGrow: t.grow ?? 0 } });
    case "icon": {
      const paths = ICONS[t.name] ?? ICONS["square"] ?? [];
      const size = t.size ?? 24;
      return el(
        "svg",
        { key, width: size, height: size, viewBox: "0 0 24 24", style: { display: "flex", flexShrink: 0 } },
        paths.map((d: string, i: number) => el("path", { key: i, d, fill: gray(t.gray, 1) })),
      );
    }
    case "weather-icon": {
      const size = t.size ?? 48;
      return el("svg", { key, width: size, height: size, viewBox: "0 0 24 24", style: { display: "flex", flexShrink: 0 } }, weatherPaths(t.name).map((p, i) => el(p.tag, { key: i, ...p.attrs, fill: "#000" })));
    }
    case "bar": {
      const pct = Math.max(0, Math.min(1, t.value / (t.max ?? 100)));
      return el(
        "div",
        { key, style: { display: "flex", height: t.height ?? 10, width: "100%", border: "2px solid #000", backgroundColor: "#fff" } },
        el("div", { style: { display: "flex", width: `${pct * 100}%`, backgroundColor: "#000" } }),
      );
    }
    case "dots": {
      const size = t.size ?? 10;
      return el(
        "div",
        { key, style: { display: "flex", gap: Math.max(2, size / 3) } },
        Array.from({ length: t.count }, (_, i) => el("div", { key: i, style: { display: "flex", width: size, height: size, border: "2px solid #000", backgroundColor: i < t.filled ? "#000" : "#fff" } })),
      );
    }
  }
}

/** weather glyphs mirrored from @orbis/ui's WeatherIcon (satori can't run react components, so paths are inlined) */
const CLOUD = "M22 10h-4v2h4v-2Zm2 2h-2v6h2v-6Zm-2 6H2v2h20v-2ZM2 12H0v6h2v-6Zm2-2H2v2h2v-2Zm4-2H4v2h4V8Zm8-4h-6v2h6V4Zm-6 2H8v2h2V6Zm0 4H8v2h2v-2Zm8-4h-2v2h2V6ZM20 8h-2v4h2V8Zm-2 4h-2v2h2v-2Z";
const SUN = "M13 22h-2v-3h2v3Zm-6-3H5v-2h2v2Zm12 0h-2v-2h2v2Zm-4-2H9v-2h6v2Zm-6-2H7V9h2v6Zm8 0h-2V9h2v6ZM5 13H2v-2h3v2Zm17 0h-3v-2h3v2Zm-7-4H9V7h6v2ZM7 7H5V5h2v2Zm12 0h-2V5h2v2Zm-6-2h-2V2h2v3Z";
const MOON = "M18 22H8v-2h10v2ZM8 20H6v-2h2v2Zm12 0h-2v-2h2v2ZM6 18H4v-2h2v2Zm16 0h-2v-4h-2v-2h2v-2h2v8ZM4 16H2V6h2v10Zm14 0h-6v-2h6v2Zm-6-2h-2v-2h2v2Zm-2-2H8V6h2v6ZM6 6H4V4h2v2Zm8-2h-2v2h-2V4H6V2h8v2Z";
const CLOUD_SUN = "M14 22H4v-2h10v2ZM4 20H2v-4h2v4Zm12 0h-2v-4h2v4Zm-6-2H8v-2h2v2Zm-2-2H4v-2h4v2Zm6 0h-2v-2h2v2Zm-2-2H8v-2h4v2Zm12-1h-4v-2h4v2Zm-6-1h-2v-2h2v2ZM8 10H6V8h2v2Zm8 0h-2V8h2v2Zm-2-2H8V6h6v2ZM6 6H4V4h2v2Zm14 0h-2V4h2v2ZM4 4H2V2h2v2Zm9 0h-2V0h2v4Zm9 0h-2V2h2v2Z";
const CLOUD_MOON = "M14 22H4v-2h10v2ZM4 20H2v-4h2v4Zm12 0h-2v-4h2v4Zm-6-2H8v-2h2v2Zm-2-2H4v-2h4v2Zm6 0h-2v-2h2v2Zm6 0h-2v-2h2v2Zm-8-2H8v-2h4v2Zm10 0h-2v-4h-2V8h2V6h2v8Zm-4-2h-4v-2h4v2ZM8 10H6V6h2v4Zm6 0h-2V6h2v4Zm-4-4H8V4h2v2Zm8-2h-2v2h-2V4h-4V2h8v2Z";
const ZAP = "M4 13h8v6h2v2h-2v2h-2v-8H2v-4h2v2Zm12 6h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2v-2h2v2Zm-6-6h8v4h-2v-2h-8V5h-2V3h2V1h2v8Zm-8 2H4V9h2v2Zm2-2H6V7h2v2Zm2-2H8V5h2v2Z";
const WIND = "M2 7h10v2H2zm10-4h2v4h-2zM7 1h5v2H7zM2 11h18v2H2zm18-4h2v4h-2zm-4-2h4v2h-4zM2 17h12v-2H2zm12 2h2v-2h-2zm-5 2h5v-2H9z";
type P = { tag: string; attrs: Record<string, unknown> };
const rect = (x: number, y: number, w: number, h: number): P => ({ tag: "rect", attrs: { x, y, width: w, height: h } });
const cloudUp: P = { tag: "path", attrs: { d: CLOUD, transform: "translate(0 -4)" } };
function weatherPaths(name: string): P[] {
  switch (name) {
    case "sun": return [{ tag: "path", attrs: { d: SUN } }];
    case "moon": return [{ tag: "path", attrs: { d: MOON } }];
    case "cloud-sun": return [{ tag: "path", attrs: { d: CLOUD_SUN } }];
    case "cloud-moon": return [{ tag: "path", attrs: { d: CLOUD_MOON } }];
    case "wind": return [{ tag: "path", attrs: { d: WIND } }];
    case "rain": return [cloudUp, rect(5, 19, 2, 4), rect(11, 18, 2, 4), rect(17, 19, 2, 4)];
    case "drizzle": return [cloudUp, rect(5, 19, 2, 2), rect(11, 18, 2, 2), rect(17, 19, 2, 2)];
    case "snow": return [cloudUp, rect(5, 18, 2, 2), rect(11, 18, 2, 2), rect(17, 18, 2, 2), rect(8, 22, 2, 2), rect(14, 22, 2, 2)];
    case "fog": return [cloudUp, rect(2, 18, 14, 2), rect(8, 22, 14, 2)];
    case "thunder": return [{ tag: "path", attrs: { d: CLOUD, transform: "translate(0 -5)" } }, { tag: "path", attrs: { d: ZAP, transform: "translate(9 12) scale(0.5)" } }];
    default: return [{ tag: "path", attrs: { d: CLOUD } }];
  }
}

/* ---------- compose a display ---------- */

type Cell = { x: number; y: number; w: number; h: number; title: string; tree: EinkTree | null; error?: string; module?: string; widget?: string; config?: Record<string, unknown> };

/** frame size + widget boxes for a display, shared by render and tap */
function frameGeometry(display: EinkDisplay) {
  const { W, H } = frameSize(display);
  const pad = 8;
  const gap = 8;
  const dash = display.dashboardId ? getDashboard(display.dashboardId) : null;
  const boxes: Array<{ x: number; y: number; w: number; h: number; module: string; widget: string; config: Record<string, unknown> }> = [];
  if (dash) {
    const cols = 12;
    const rows = Math.max(1, ...dash.widgets.map((w) => w.y + w.h));
    const cw = (W - pad * 2 - gap * (cols - 1)) / cols;
    const rh = (H - pad * 2 - gap * (rows - 1)) / rows;
    for (const w of dash.widgets) boxes.push({ x: pad + w.x * (cw + gap), y: pad + w.y * (rh + gap), w: w.w * cw + (w.w - 1) * gap, h: w.h * rh + (w.h - 1) * gap, module: w.module, widget: w.widget, config: w.config });
  }
  return { W, H, pad, gap, dash, boxes };
}

/**
 * A touch display reported a tap. Coordinates are in frame space (what the display shows, after rotation).
 * Finds the widget, forwards to its einkTap hook if it has one; otherwise a tap just means "refresh".
 */
export async function handleTap(display: EinkDisplay, x: number, y: number): Promise<EinkTapResult & { widget?: string; module?: string }> {
  const { boxes } = frameGeometry(display);
  const box = boxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  if (!box) return { refresh: true };
  const mod = runtime.get(box.module);
  if (!mod?.loaded || !mod.server?.einkTap || !mod.built) return { refresh: true, widget: box.widget, module: box.module };
  const settings = getAllSettings();
  // content area: inside the 1.5px frame and below the ~24px title bar, matching the box eink() rendered into
  const req = { displayId: display.id, width: Math.floor(box.w) - 12, height: Math.floor(box.h) - 30, grayLevelsBits: display.grayscale, widget: box.widget, config: box.config, locale: settings.locale, timezone: settings.timezone, language: settings.language, now: new Date(), x: Math.round(x - box.x - 6), y: Math.round(y - box.y - 24) };
  try {
    const r = (await mod.server.einkTap(mod.built.ctx, req)) ?? {};
    return { refresh: r.refresh ?? true, toast: r.toast, widget: box.widget, module: box.module };
  } catch (err) {
    log.warn({ err, module: box.module }, "einkTap failed");
    return { refresh: true, widget: box.widget, module: box.module };
  }
}

export async function renderDisplay(display: EinkDisplay, opts: { format: "png" | "bin" | "bmp" | "svg" }): Promise<{ body: Buffer; contentType: string }> {
  const settings = getAllSettings();
  monochrome = display.grayscale <= 1;
  const { W, H, pad, dash, boxes } = frameGeometry(display);

  const cells: Cell[] = [];
  if (dash) {
    for (const b of boxes) {
      const w = { module: b.module, widget: b.widget, config: b.config };
      const { x, y, w: width, h: height } = b;
      const mod = runtime.get(w.module);
      // localized manifest: widget names in the hub language, same as the web app shows them
      const def = mod ? runtime.localizedManifest(mod).widgets.find((d) => d.id === w.widget) : undefined;
      const cell: Cell = { x, y, w: width, h: height, title: String(w.config.title ?? def?.name ?? w.widget), tree: null };
      if (mod?.loaded && mod.server?.eink && mod.built) {
        try {
          const req: EinkRequest = { displayId: display.id, width: Math.floor(width) - 12, height: Math.floor(height) - 30, grayLevelsBits: display.grayscale, widget: w.widget, config: w.config, locale: settings.locale, timezone: settings.timezone, language: settings.language, now: new Date() };
          cell.tree = await mod.server.eink(mod.built.ctx, req);
        } catch (err) {
          cell.error = (err as Error).message;
        }
      } else if (mod && !mod.server?.eink) {
        cell.tree = { type: "col", align: "center", justify: "center", grow: 1, children: [{ type: "icon", name: mod.manifest.icon ?? "square", size: 24, gray: 0.5 }, { type: "text", text: "no e-ink view", size: 12, gray: 0.5 }] };
      } else {
        cell.error = mod ? (mod.error ?? "module not loaded") : `module ${w.module} missing`;
      }
      cells.push(cell);
    }
  }

  const children: El[] = cells.map((c, i) =>
    el(
      "div",
      { key: i, style: { position: "absolute", left: c.x, top: c.y, width: c.w, height: c.h, display: "flex", flexDirection: "column", border: "2px solid #000", backgroundColor: "#fff" } },
      [
        el("div", { key: "t", style: { display: "flex", alignItems: "center", gap: 6, padding: "2px 8px", borderBottom: "2px solid #000", fontFamily: "DotGothic16", fontSize: 14, height: 24 } }, [
          el("div", { key: "d", style: { display: "flex", width: 8, height: 8, border: "2px solid #000", backgroundColor: "#000" } }),
          el("div", { key: "n", style: { display: "flex", overflow: "hidden", whiteSpace: "nowrap" } }, c.title),
        ]),
        el("div", { key: "b", style: { display: "flex", flexDirection: "column", flexGrow: 1, padding: 6, minHeight: 0, overflow: "hidden", fontFamily: "IBM Plex Mono", fontSize: 14, color: "#000" } }, c.error ? [el("div", { key: "e", style: { display: "flex", fontSize: 12 } }, `⚠ ${c.error}`)] : c.tree ? [treeToEl(c.tree, 0)] : []),
      ],
    ),
  );
  if (!dash) {
    children.push(
      el("div", { style: { position: "absolute", left: 0, top: 0, width: W, height: H, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "DotGothic16", fontSize: 28 } }, [
        el("div", { key: 1, style: { display: "flex" } }, "◎ orbis"),
        el("div", { key: 2, style: { display: "flex", fontFamily: "IBM Plex Mono", fontSize: 14, marginTop: 8 } }, `display "${display.name}" has no dashboard yet – pick one under settings → e-ink`),
      ]),
    );
  }
  // footer: time + battery
  const t = new Intl.DateTimeFormat(settings.locale, { hour: "2-digit", minute: "2-digit", timeZone: settings.timezone }).format(new Date());
  children.push(el("div", { style: { position: "absolute", right: pad, bottom: 2, display: "flex", fontFamily: "IBM Plex Mono", fontSize: 10, color: "#000" } }, `${t}${display.battery !== null ? ` · ${display.battery}%` : ""}`));

  const rootEl: El = el("div", { style: { display: "flex", width: W, height: H, backgroundColor: "#fff", position: "relative" } }, children);
  const svg = await satori(rootEl as never, { width: W, height: H, fonts: loadFonts() });
  if (opts.format === "svg") return { body: Buffer.from(svg), contentType: "image/svg+xml" };

  const png = new Resvg(svg, { fitTo: { mode: "width", value: W }, background: "#ffffff" }).render();
  const rgba = png.pixels; // RGBA
  let grayBuf = toGray(rgba, W, H);
  if (display.rotate) grayBuf = rotateGray(grayBuf, W, H, display.rotate);
  const outW = display.width;
  const outH = display.height;
  if (display.invert) for (let i = 0; i < grayBuf.length; i++) grayBuf[i] = 255 - grayBuf[i]!;

  if (opts.format === "png") return { body: Buffer.from(grayToPng(dither(grayBuf, outW, outH, display.grayscale), outW, outH)), contentType: "image/png" };
  if (opts.format === "bmp") return { body: grayToBmp1(dither(grayBuf, outW, outH, 1), outW, outH), contentType: "image/bmp" };
  return { body: packBits(dither(grayBuf, outW, outH, display.grayscale), outW, outH, display.grayscale), contentType: "application/octet-stream" };
}

function toGray(rgba: Uint8Array, w: number, h: number) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!, a = rgba[i * 4 + 3]! / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    out[i] = Math.round(lum * a + 255 * (1 - a));
  }
  return out;
}

function rotateGray(src: Uint8Array, w: number, h: number, deg: number) {
  if (deg === 180) {
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[w * h - 1 - i] = src[i]!;
    return out;
  }
  // 90 / 270: output is h × w
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x]!;
      if (deg === 90) out[x * h + (h - 1 - y)] = v;
      else out[(w - 1 - x) * h + y] = v;
    }
  return out;
}

/** Floyd–Steinberg to 2^bits levels. */
function dither(src: Uint8Array, w: number, h: number, bits: number) {
  const levels = Math.max(2, 1 << Math.min(8, Math.max(1, bits)));
  const step = 255 / (levels - 1);
  const buf = Float32Array.from(src);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i]!;
      const q = Math.round(Math.max(0, Math.min(255, old)) / step) * step;
      out[i] = q;
      const err = old - q;
      if (x + 1 < w) buf[i + 1]! += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) buf[i + w - 1]! += (err * 3) / 16;
        buf[i + w]! += (err * 5) / 16;
        if (x + 1 < w) buf[i + w + 1]! += (err * 1) / 16;
      }
    }
  return out;
}

/**
 * Firmware format "ORB1": 16-byte header + packed pixels, rows padded to whole bytes, MSB first.
 *   magic "ORB1" | u16 width | u16 height | u8 bits (1|2|4|8) | u8 flags (bit0: 1 = black is 1) | u16 refreshMinutes | u32 crc32 of payload
 */
function packBits(gray: Uint8Array, w: number, h: number, bits: number) {
  const b = [1, 2, 4, 8].includes(bits) ? bits : 1;
  const levels = (1 << b) - 1;
  const rowBytes = Math.ceil((w * b) / 8);
  const payload = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.round((gray[y * w + x]! / 255) * levels); // 0 = black … levels = white
      const bitPos = x * b;
      const byte = y * rowBytes + (bitPos >> 3);
      const shift = 8 - b - (bitPos & 7);
      payload[byte]! |= v << shift;
    }
  const header = Buffer.alloc(16);
  header.write("ORB1", 0, "ascii");
  header.writeUInt16LE(w, 4);
  header.writeUInt16LE(h, 6);
  header.writeUInt8(b, 8);
  header.writeUInt8(0, 9); // 0 = white is max value
  header.writeUInt16LE(10, 10);
  header.writeUInt32LE(crc32(payload), 12);
  return Buffer.concat([header, payload]);
}

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 1-bit BMP (for people who want to look at it or feed it to other tools). */
function grayToBmp1(gray: Uint8Array, w: number, h: number) {
  const rowBytes = Math.ceil(w / 32) * 4;
  const dataSize = rowBytes * h;
  const buf = Buffer.alloc(62 + dataSize);
  buf.write("BM", 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(62, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(1, 28);
  buf.writeUInt32LE(dataSize, 34);
  buf.writeUInt32LE(0x00000000, 54); // palette 0 black
  buf.writeUInt32LE(0x00ffffff, 58); // palette 1 white
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y;
    for (let x = 0; x < w; x++) if (gray[y * w + x]! > 127) buf[62 + row * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
  }
  return buf;
}

/** Minimal 8-bit grayscale PNG encoder (no deps). */
function grayToPng(gray: Uint8Array, w: number, h: number) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function logReady() {
  try {
    loadFonts();
    log.info("e-ink renderer ready");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "e-ink renderer unavailable");
  }
}
