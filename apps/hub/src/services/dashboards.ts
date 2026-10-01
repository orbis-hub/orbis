import type { Dashboard, WidgetInstance } from "@orbis/sdk";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb, now, schema } from "../db";
import { broadcast } from "../ws";

function rowToWidget(r: typeof schema.dashboardWidgets.$inferSelect): WidgetInstance {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(r.config);
  } catch {
    /* ignore */
  }
  return { id: r.id, module: r.module, widget: r.widget, x: r.x, y: r.y, w: r.w, h: r.h, config };
}

export function listDashboards(): Dashboard[] {
  const db = getDb();
  const dashes = db.select().from(schema.dashboards).orderBy(asc(schema.dashboards.sort), asc(schema.dashboards.createdAt)).all();
  const widgets = db.select().from(schema.dashboardWidgets).all();
  return dashes.map((d) => ({
    id: d.id,
    name: d.name,
    icon: d.icon,
    sort: d.sort,
    widgets: widgets.filter((w) => w.dashboardId === d.id).map(rowToWidget),
  }));
}

export function getDashboard(id: string): Dashboard | null {
  return listDashboards().find((d) => d.id === id) ?? null;
}

export function createDashboard(name: string, icon?: string | null): Dashboard {
  const db = getDb();
  const count = db.select().from(schema.dashboards).all().length;
  const id = nanoid(10);
  db.insert(schema.dashboards).values({ id, name, icon: icon ?? null, sort: count, createdAt: now() }).run();
  broadcast({ type: "dashboards:changed", dashboardId: id });
  return { id, name, icon: icon ?? null, sort: count, widgets: [] };
}

export function updateDashboard(id: string, patch: { name?: string; icon?: string | null; sort?: number }) {
  getDb().update(schema.dashboards).set(patch).where(eq(schema.dashboards.id, id)).run();
  broadcast({ type: "dashboards:changed", dashboardId: id });
  return getDashboard(id);
}

export function deleteDashboard(id: string) {
  const db = getDb();
  db.delete(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.dashboardId, id)).run();
  db.delete(schema.dashboards).where(eq(schema.dashboards.id, id)).run();
  broadcast({ type: "dashboards:changed", dashboardId: id });
}

export function reorderDashboards(ids: string[]) {
  const db = getDb();
  ids.forEach((id, i) => db.update(schema.dashboards).set({ sort: i }).where(eq(schema.dashboards.id, id)).run());
  broadcast({ type: "dashboards:changed" });
}

export function addWidget(dashboardId: string, input: Omit<WidgetInstance, "id">): WidgetInstance {
  const id = nanoid(10);
  getDb()
    .insert(schema.dashboardWidgets)
    .values({ id, dashboardId, module: input.module, widget: input.widget, x: input.x, y: input.y, w: input.w, h: input.h, config: JSON.stringify(input.config ?? {}) })
    .run();
  broadcast({ type: "dashboards:changed", dashboardId });
  return { id, ...input };
}

export function updateWidget(id: string, patch: Partial<Omit<WidgetInstance, "id" | "module" | "widget">>) {
  const set: Partial<typeof schema.dashboardWidgets.$inferInsert> = {};
  if (patch.x !== undefined) set.x = patch.x;
  if (patch.y !== undefined) set.y = patch.y;
  if (patch.w !== undefined) set.w = patch.w;
  if (patch.h !== undefined) set.h = patch.h;
  if (patch.config !== undefined) set.config = JSON.stringify(patch.config);
  const db = getDb();
  db.update(schema.dashboardWidgets).set(set).where(eq(schema.dashboardWidgets.id, id)).run();
  const row = db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, id)).get();
  if (row) broadcast({ type: "dashboards:changed", dashboardId: row.dashboardId });
  return row ? rowToWidget(row) : null;
}

/** Bulk layout save from the grid: positions and sizes only. */
export function saveLayout(dashboardId: string, layout: Array<{ id: string; x: number; y: number; w: number; h: number }>) {
  const db = getDb();
  db.transaction((tx) => {
    for (const l of layout) {
      tx.update(schema.dashboardWidgets).set({ x: l.x, y: l.y, w: l.w, h: l.h }).where(eq(schema.dashboardWidgets.id, l.id)).run();
    }
  });
  broadcast({ type: "dashboards:changed", dashboardId });
}

export function removeWidget(id: string) {
  const db = getDb();
  const row = db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, id)).get();
  db.delete(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, id)).run();
  if (row) broadcast({ type: "dashboards:changed", dashboardId: row.dashboardId });
}

/** Remove every widget instance belonging to a module (on uninstall). */
export function removeWidgetsOfModule(moduleId: string) {
  getDb().delete(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.module, moduleId)).run();
  broadcast({ type: "dashboards:changed" });
}

export function ensureDefaultDashboard() {
  if (listDashboards().length === 0) createDashboard("Home", "home");
}
