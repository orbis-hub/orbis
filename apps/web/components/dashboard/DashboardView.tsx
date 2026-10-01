"use client";

import type { Dashboard, InstalledModule, WidgetDef, WidgetInstance } from "@orbis/sdk";
import { Button, cx, Empty, Icon, Input, Menu, Modal, useToast, iconNames } from "@orbis/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import { isAdminRole, useAuthStatus, useDashboardMutations, useDashboards, useModules, useUsers } from "@/lib/queries";
import { useShell } from "@/lib/store";
import { Shell } from "../Shell";
import { AddWidgetModal } from "./AddWidgetModal";
import { WidgetConfigModal } from "./WidgetConfigModal";
import { WidgetFrame } from "./WidgetFrame";

const COLS = 12;
const ROW = 56;
const MARGIN: [number, number] = [14, 14];

export function DashboardView() {
  const params = useSearchParams();
  const router = useRouter();
  const dashboards = useDashboards();
  const modules = useModules();
  const { editMode, setEditMode, activeDashboard, setActiveDashboard } = useShell();
  const m = useDashboardMutations();
  const toast = useToast();
  const auth = useAuthStatus();
  const admin = isAdminRole(auth.data?.user?.role);

  const list = dashboards.data ?? [];
  const requested = params.get("d");
  const dash = list.find((d) => d.id === requested) ?? list.find((d) => d.id === activeDashboard) ?? list[0];
  useEffect(() => {
    if (dash && dash.id !== activeDashboard) setActiveDashboard(dash.id);
  }, [dash, activeDashboard, setActiveDashboard]);

  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<WidgetInstance | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sharing, setSharing] = useState(false);
  const canEdit = !!dash?.canEdit;
  const editing = editMode && canEdit;

  const modMap = useMemo(() => new Map((modules.data ?? []).map((x) => [x.id, x])), [modules.data]);

  async function addWidget(mod: InstalledModule, w: WidgetDef) {
    if (!dash) return;
    const y = dash.widgets.reduce((max, x) => Math.max(max, x.y + x.h), 0);
    await m.addWidget.mutateAsync({ dashboardId: dash.id, module: mod.id, widget: w.id, x: 0, y, w: w.defaultSize.w, h: w.defaultSize.h, config: {} });
    setEditMode(true);
  }

  const title = dash ? (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Icon name={dash.icon ?? "home"} size={16} style={{ color: "var(--accent)" }} />
      {dash.name}
      {!dash.shared ? <Icon name="lock" size={12} className="soft" title="private" /> : null}
      {!canEdit ? <span className="chip" style={{ fontSize: 10 }}>read only</span> : null}
    </span>
  ) : (
    "dashboard"
  );

  const actions = (
    <>
      {canEdit ? (
        <>
          <Button size="sm" onClick={() => setAdding(true)} disabled={!dash}>
            <Icon name="plus" size={14} />
            <span className="hide-sm">widget</span>
          </Button>
          <Button size="sm" aria-pressed={editing} onClick={() => setEditMode(!editMode)} disabled={!dash}>
            <Icon name={editing ? "check" : "move"} size={14} />
            <span className="hide-sm">{editing ? "done" : "edit"}</span>
          </Button>
        </>
      ) : null}
      <Menu
        trigger={
          <Button icon size="sm" aria-label="dashboard menu">
            <Icon name="more-vertical" size={14} />
          </Button>
        }
        items={[
          { label: "new dashboard", icon: "plus", onSelect: () => setCreating(true) },
          { label: "rename / icon", icon: "edit", onSelect: () => setRenaming(true), disabled: !canEdit },
          { label: "sharing & access", icon: "users", onSelect: () => setSharing(true), disabled: !canEdit },
          { sep: true, label: "" },
          {
            label: "delete dashboard",
            icon: "trash",
            danger: true,
            disabled: !canEdit || list.length <= 1,
            onSelect: async () => {
              if (!dash || !confirm(`delete "${dash.name}" and its ${dash.widgets.length} widgets?`)) return;
              await m.remove.mutateAsync(dash.id);
              router.replace("/");
            },
          },
        ]}
      />
    </>
  );

  return (
    <Shell title={title} actions={actions}>
      <style>{`@media (max-width: 640px) { .hide-sm { display: none; } }`}</style>
      {dashboards.isPending ? (
        <div className="soft pixel" style={{ fontSize: 12 }}>
          loading<span className="blink">…</span>
        </div>
      ) : !dash ? (
        <Empty icon="grid-3x3" title="no dashboard">
          <Button onClick={() => setCreating(true)}>create one</Button>
        </Empty>
      ) : dash.widgets.length === 0 ? (
        <Empty icon="grid-3x3" title="empty dashboard">
          <p style={{ marginBottom: 10 }}>add your first widget. modules bring widgets, install more under modules.</p>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> add widget
          </Button>
        </Empty>
      ) : (
        <Grid
          dash={dash}
          modMap={modMap}
          editing={editing}
          onConfigure={setConfiguring}
          onRemove={async (w) => {
            await m.removeWidget.mutateAsync({ dashboardId: dash.id, id: w.id });
          }}
          onLayout={(layout) => {
            m.saveLayout.mutate({ dashboardId: dash.id, layout }, { onError: (e) => toast(`layout not saved: ${e.message}`, "bad") });
          }}
        />
      )}

      <AddWidgetModal open={adding} onClose={() => setAdding(false)} modules={modules.data ?? []} onPick={addWidget} />
      <WidgetConfigModal
        instance={configuring}
        mod={configuring ? modMap.get(configuring.module) : undefined}
        onClose={() => setConfiguring(null)}
        onSave={async (config) => {
          if (!dash || !configuring) return;
          await m.updateWidget.mutateAsync({ dashboardId: dash.id, id: configuring.id, config });
        }}
      />
      <ShareModal open={sharing} dash={dash ?? null} admin={admin} onClose={() => setSharing(false)} />
      <DashboardFormModal
        open={creating || renaming}
        admin={admin}
        initial={renaming && dash ? { name: dash.name, icon: dash.icon ?? "home", shared: dash.shared } : undefined}
        onClose={() => {
          setCreating(false);
          setRenaming(false);
        }}
        onSave={async (v) => {
          if (renaming && dash) await m.update.mutateAsync({ id: dash.id, ...v });
          else {
            const d = await m.create.mutateAsync(v);
            router.push(`/?d=${d.id}`);
          }
        }}
      />
    </Shell>
  );
}

function Grid({ dash, modMap, editing, onConfigure, onRemove, onLayout }: { dash: Dashboard; modMap: Map<string, InstalledModule>; editing: boolean; onConfigure: (w: WidgetInstance) => void; onRemove: (w: WidgetInstance) => void; onLayout: (l: Array<{ id: string; x: number; y: number; w: number; h: number }>) => void }) {
  const { width, containerRef, mounted } = useContainerWidth();
  const narrow = mounted && width < 640;
  const layout = useMemo<Layout>(
    () =>
      dash.widgets.map((w) => {
        const def = modMap.get(w.module)?.manifest.widgets.find((d) => d.id === w.widget);
        return { i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: def?.minSize.w ?? 1, minH: def?.minSize.h ?? 1, maxW: def?.maxSize?.w, maxH: def?.maxSize?.h };
      }),
    [dash.widgets, modMap],
  );
  const last = useRef("");
  const handleChange = useCallback(
    (l: Layout) => {
      const next = l.map((it) => ({ id: it.i, x: it.x, y: it.y, w: it.w, h: it.h }));
      const sig = JSON.stringify(next);
      const current = JSON.stringify(dash.widgets.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h })));
      if (sig === current || sig === last.current) return;
      last.current = sig;
      onLayout(next);
    },
    [dash.widgets, onLayout],
  );

  if (narrow) {
    // phones: a simple stacked list ordered by grid position; editing happens on larger screens
    const sorted = [...dash.widgets].sort((a, b) => a.y - b.y || a.x - b.x);
    return (
      <div ref={containerRef} className="widget-stack">
        {sorted.map((w) => (
          <div key={w.id} style={{ height: Math.max(120, w.h * ROW) }}>
            <WidgetFrame instance={w} mod={modMap.get(w.module)} editing={editing} onConfigure={() => onConfigure(w)} onRemove={() => onRemove(w)} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cx(editing && "editing")} style={{ margin: -MARGIN[0] / 2 }}>
      {mounted ? (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols: COLS, rowHeight: ROW, margin: MARGIN, containerPadding: [MARGIN[0] / 2, MARGIN[1] / 2] }}
          dragConfig={{ enabled: editing, handle: ".widget-handle", cancel: "button, a, input, select, textarea" }}
          resizeConfig={{ enabled: editing, handles: ["se"] }}
          compactor={verticalCompactor}
          onDragStop={handleChange}
          onResizeStop={handleChange}
        >
          {dash.widgets.map((w) => (
            <div key={w.id}>
              <WidgetFrame instance={w} mod={modMap.get(w.module)} editing={editing} onConfigure={() => onConfigure(w)} onRemove={() => onRemove(w)} />
            </div>
          ))}
        </GridLayout>
      ) : null}
    </div>
  );
}

function DashboardFormModal({ open, initial, admin, onClose, onSave }: { open: boolean; admin: boolean; initial?: { name: string; icon: string; shared: boolean }; onClose: () => void; onSave: (v: { name: string; icon: string; shared: boolean }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("home");
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setIcon(initial?.icon ?? "home");
      setShared(initial?.shared ?? admin);
    }
  }, [open, initial, admin]);
  const icons = useMemo(() => iconNames(), []);
  return (
    <Modal open={open} onClose={onClose} title={initial ? "rename dashboard" : "new dashboard"}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          try {
            await onSave({ name: name.trim(), icon, shared });
            onClose();
          } finally {
            setBusy(false);
          }
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <div className="field">
          <label>name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={64} />
        </div>
        <div className="field">
          <label>icon</label>
          <div className="scroll-y" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 30px)", gap: 4, maxHeight: 160, padding: 2 }}>
            {icons.map((n) => (
              <button key={n} type="button" title={n} className={cx("btn btn-icon", n === icon && "btn-primary")} style={{ boxShadow: "none" }} onClick={() => setIcon(n)}>
                <Icon name={n} size={14} />
              </button>
            ))}
          </div>
        </div>
        {!initial ? (
          <label className="check" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <i aria-hidden />
            <span>visible to everyone on this hub{!shared ? " (off: only you, plus people an admin grants access)" : ""}</span>
          </label>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ShareModal({ open, dash, admin, onClose }: { open: boolean; dash: Dashboard | null; admin: boolean; onClose: () => void }) {
  const users = useUsers(open && admin);
  const m = useDashboardMutations();
  const toast = useToast();
  const auth = useAuthStatus();
  const [shared, setShared] = useState(true);
  const [access, setAccess] = useState<string[]>([]);
  const [owner, setOwner] = useState<string | null>(null);
  useEffect(() => {
    if (open && dash) {
      setShared(dash.shared);
      setAccess(dash.access);
      setOwner(dash.ownerId);
    }
  }, [open, dash]);
  if (!dash) return null;
  const others = (users.data ?? []).filter((u) => u.id !== (owner ?? "") && u.role !== "owner" && u.role !== "admin");
  return (
    <Modal open={open} onClose={onClose} title={`sharing · ${dash.name}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label className="check" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <i aria-hidden />
          <span>shared with everyone on this hub</span>
        </label>
        {!shared ? (
          admin ? (
            <div className="field">
              <label>who else may see it</label>
              {others.length === 0 ? (
                <div className="soft" style={{ fontSize: 12 }}>no other members yet (admins always see everything)</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {others.map((u) => (
                    <label key={u.id} className="check" style={{ fontSize: 12 }}>
                      <input type="checkbox" checked={access.includes(u.id)} onChange={(e) => setAccess(e.target.checked ? [...access, u.id] : access.filter((x) => x !== u.id))} />
                      <i aria-hidden />
                      <span>{u.name}</span>
                    </label>
                  ))}
                </div>
              )}
              <span className="hint">read only for them; only the dashboard owner and admins can edit.</span>
            </div>
          ) : (
            <div className="soft" style={{ fontSize: 12 }}>private: only you and admins can see this dashboard. ask an admin to grant other people access.</div>
          )
        ) : null}
        {admin ? (
          <div className="field">
            <label>owner</label>
            <select className="input" value={owner ?? ""} onChange={(e) => setOwner(e.target.value || null)}>
              <option value="">hub (admins only)</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.id === auth.data?.user?.id ? " (you)" : ""}
                </option>
              ))}
            </select>
            <span className="hint">the owner can edit the dashboard and its widgets.</span>
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>cancel</Button>
          <Button
            variant="primary"
            loading={m.update.isPending}
            onClick={() =>
              m.update.mutate(
                { id: dash.id, shared, access, ...(admin ? { ownerId: owner } : {}) },
                {
                  onSuccess: () => {
                    toast("sharing updated", "ok");
                    onClose();
                  },
                  onError: (err) => toast(err.message, "bad"),
                },
              )
            }
          >
            save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
