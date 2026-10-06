import type { Dashboard, WidgetInstance } from "@orbis/sdk";
import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { isAdminRole, type AuthUser } from "../auth";
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

/** Everything in the db, with per-user edit rights computed for `viewer` (undefined = system view, all editable). */
function loadAll(viewer?: AuthUser): Dashboard[] {
  const db = getDb();
  const dashes = db.select().from(schema.dashboards).orderBy(asc(schema.dashboards.sort), asc(schema.dashboards.createdAt)).all();
  const widgets = db.select().from(schema.dashboardWidgets).all();
  const access = db.select().from(schema.dashboardAccess).all();
  return dashes.map((d) => {
    const grants = access.filter((a) => a.dashboardId === d.id).map((a) => a.userId);
    // hub-level dashboards (no owner) are editable by admins only
    const canEdit = !viewer || isAdminRole(viewer.role) || d.ownerId === viewer.id;
    return {
      id: d.id,
      name: d.name,
      icon: d.icon,
      sort: d.sort,
      ownerId: d.ownerId,
      shared: d.shared,
      access: grants,
      canEdit,
      accent: d.accent,
      widgets: widgets.filter((w) => w.dashboardId === d.id).map(rowToWidget),
    };
  });
}

export function canView(d: Dashboard, user: AuthUser) {
  return isAdminRole(user.role) || d.shared || d.ownerId === user.id || d.ownerId === null || d.access.includes(user.id);
}

/** Dashboards visible to a user. */
export function listDashboards(user?: AuthUser): Dashboard[] {
  const all = loadAll(user);
  return user ? all.filter((d) => canView(d, user)) : all;
}

export function getDashboard(id: string, user?: AuthUser): Dashboard | null {
  return listDashboards(user).find((d) => d.id === id) ?? null;
}

/** Throws if the user may not edit. */
export function assertEdit(id: string, user: AuthUser): Dashboard {
  const d = getDashboard(id, user);
  if (!d) throw new NotFound();
  if (!d.canEdit) throw new Forbidden("you cannot edit this dashboard");
  return d;
}

export class NotFound extends Error {
  status = 404 as const;
  constructor() {
    super("not found");
  }
}
export class Forbidden extends Error {
  status = 403 as const;
}

export function createDashboard(name: string, icon: string | null, owner?: AuthUser, shared = true): Dashboard {
  const db = getDb();
  const count = db.select().from(schema.dashboards).all().length;
  const id = nanoid(10);
  db.insert(schema.dashboards).values({ id, name, icon, sort: count, createdAt: now(), ownerId: owner?.id ?? null, shared }).run();
  broadcast({ type: "dashboards:changed", dashboardId: id });
  return getDashboard(id, owner)!;
}

export function updateDashboard(id: string, patch: { name?: string; icon?: string | null; sort?: number; shared?: boolean; ownerId?: string | null; accent?: string | null }, user?: AuthUser) {
  const set: Partial<typeof schema.dashboards.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.icon !== undefined) set.icon = patch.icon;
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (patch.shared !== undefined) set.shared = patch.shared;
  if (patch.ownerId !== undefined) set.ownerId = patch.ownerId;
  if (patch.accent !== undefined) set.accent = patch.accent;
  // an empty patch (e.g. PATCH {access:[...]} only) is a no-op, not a drizzle "No values to set" error
  if (Object.keys(set).length === 0) return getDashboard(id, user);
  getDb().update(schema.dashboards).set(set).where(eq(schema.dashboards.id, id)).run();
  broadcast({ type: "dashboards:changed", dashboardId: id });
  return getDashboard(id, user);
}

/** Replace the explicit grant list (who may see a non-shared dashboard). */
export function setAccess(id: string, userIds: string[], user?: AuthUser) {
  const db = getDb();
  db.delete(schema.dashboardAccess).where(eq(schema.dashboardAccess.dashboardId, id)).run();
  for (const userId of new Set(userIds)) db.insert(schema.dashboardAccess).values({ dashboardId: id, userId }).run();
  broadcast({ type: "dashboards:changed", dashboardId: id });
  return getDashboard(id, user);
}

export function deleteDashboard(id: string) {
  const db = getDb();
  db.delete(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.dashboardId, id)).run();
  db.delete(schema.dashboardAccess).where(eq(schema.dashboardAccess.dashboardId, id)).run();
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

/** Bulk layout save from the grid: positions and sizes only. Scoped to the dashboard: ids of other dashboards' widgets are ignored. Returns the number of rows touched. */
export function saveLayout(dashboardId: string, layout: Array<{ id: string; x: number; y: number; w: number; h: number }>) {
  const db = getDb();
  let changed = 0;
  db.transaction((tx) => {
    for (const l of layout) {
      changed += tx
        .update(schema.dashboardWidgets)
        .set({ x: l.x, y: l.y, w: l.w, h: l.h })
        .where(and(eq(schema.dashboardWidgets.id, l.id), eq(schema.dashboardWidgets.dashboardId, dashboardId)))
        .run().changes;
    }
  });
  broadcast({ type: "dashboards:changed", dashboardId });
  return changed;
}

export function widgetDashboard(widgetId: string): string | null {
  return getDb().select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, widgetId)).get()?.dashboardId ?? null;
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
  if (loadAll().length === 0) createDashboard("Home", "home", undefined, true);
}
