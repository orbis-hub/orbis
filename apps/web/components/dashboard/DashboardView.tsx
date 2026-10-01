"use client";

import type { Dashboard, InstalledModule, WidgetDef, WidgetInstance } from "@orbis/sdk";
import { Button, cx, Empty, Icon, Input, Menu, Modal, useToast, iconNames } from "@orbis/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import { useDashboardMutations, useDashboards, useModules } from "@/lib/queries";
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
    </span>
  ) : (
    "dashboard"
  );

  const actions = (
    <>
      <Button size="sm" onClick={() => setAdding(true)} disabled={!dash}>
        <Icon name="plus" size={14} />
        <span className="hide-sm">widget</span>
      </Button>
      <Button size="sm" aria-pressed={editMode} onClick={() => setEditMode(!editMode)} disabled={!dash}>
        <Icon name={editMode ? "check" : "move"} size={14} />
        <span className="hide-sm">{editMode ? "done" : "edit"}</span>
      </Button>
      <Menu
        trigger={
          <Button icon size="sm" aria-label="dashboard menu">
            <Icon name="more-vertical" size={14} />
          </Button>
        }
        items={[
          { label: "new dashboard", icon: "plus", onSelect: () => setCreating(true) },
          { label: "rename / icon", icon: "edit", onSelect: () => setRenaming(true), disabled: !dash },
          { sep: true, label: "" },
          {
            label: "delete dashboard",
            icon: "trash",
            danger: true,
            disabled: !dash || list.length <= 1,
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
          editing={editMode}
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
      <DashboardFormModal
        open={creating || renaming}
        initial={renaming && dash ? { name: dash.name, icon: dash.icon ?? "home" } : undefined}
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

function DashboardFormModal({ open, initial, onClose, onSave }: { open: boolean; initial?: { name: string; icon: string }; onClose: () => void; onSave: (v: { name: string; icon: string }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("home");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setIcon(initial?.icon ?? "home");
    }
  }, [open, initial]);
  const icons = useMemo(() => iconNames(), []);
  return (
    <Modal open={open} onClose={onClose} title={initial ? "rename dashboard" : "new dashboard"}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          try {
            await onSave({ name: name.trim(), icon });
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
