"use client";

import type { Dashboard, InstalledModule, WidgetDef, WidgetInstance } from "@orbis/sdk";
import { ACCENTS, accentStyle, Button, cx, Empty, Icon, Input, isDarkTheme, Menu, Modal, useToast, iconNames } from "@orbis/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import { useT } from "@/lib/i18n";
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
  const t = useT();
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
      {!dash.shared ? <Icon name="lock" size={12} className="soft" title={t("dashboard.private")} /> : null}
      {!canEdit ? <span className="chip" style={{ fontSize: 10 }}>{t("dashboard.readOnly")}</span> : null}
    </span>
  ) : (
    t("common.dashboard")
  );

  const actions = (
    <>
      {canEdit ? (
        <>
          <Button size="sm" onClick={() => setAdding(true)} disabled={!dash}>
            <Icon name="plus" size={14} />
            <span className="hide-sm">{t("dashboard.widget")}</span>
          </Button>
          <Button size="sm" aria-pressed={editing} onClick={() => setEditMode(!editMode)} disabled={!dash}>
            <Icon name={editing ? "check" : "move"} size={14} />
            <span className="hide-sm">{editing ? t("common.done") : t("common.edit")}</span>
          </Button>
        </>
      ) : null}
      <Menu
        trigger={
          <Button icon size="sm" aria-label={t("dashboard.menu")}>
            <Icon name="more-vertical" size={14} />
          </Button>
        }
        items={[
          { label: t("dashboard.new"), icon: "plus", onSelect: () => setCreating(true) },
          { label: t("dashboard.renameMenu"), icon: "edit", onSelect: () => setRenaming(true), disabled: !canEdit },
          { label: t("dashboard.sharing"), icon: "users", onSelect: () => setSharing(true), disabled: !canEdit },
          { label: t("dashboard.openKiosk"), icon: "frame", onSelect: () => dash && window.open(`/kiosk/?d=${dash.id}`, "_blank"), disabled: !dash },
          { sep: true, label: "" },
          {
            label: t("dashboard.delete"),
            icon: "trash",
            danger: true,
            disabled: !canEdit || list.length <= 1,
            onSelect: async () => {
              if (!dash || !confirm(t("dashboard.deleteConfirm", { name: dash.name, count: dash.widgets.length }))) return;
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
          {t("common.loading")}<span className="blink">…</span>
        </div>
      ) : !dash ? (
        <Empty icon="grid-3x3" title={t("dashboard.empty.title")}>
          <Button onClick={() => setCreating(true)}>{t("dashboard.empty.create")}</Button>
        </Empty>
      ) : dash.widgets.length === 0 ? (
        <Empty icon="grid-3x3" title={t("dashboard.noWidgets.title")}>
          <p style={{ marginBottom: 10 }}>{t("dashboard.noWidgets.body")}</p>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> {t("dashboard.addWidget")}
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
            m.saveLayout.mutate({ dashboardId: dash.id, layout }, { onError: (e) => toast(t("dashboard.layoutNotSaved", { error: e.message }), "bad") });
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
        initial={renaming && dash ? { name: dash.name, icon: dash.icon ?? "home", shared: dash.shared, accent: dash.accent } : undefined}
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

function subscribeTheme(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => {
    obs.disconnect();
    mq.removeEventListener("change", cb);
  };
}

export function Grid({ dash, modMap, editing, onConfigure, onRemove, onLayout }: { dash: Dashboard; modMap: Map<string, InstalledModule>; editing: boolean; onConfigure: (w: WidgetInstance) => void; onRemove: (w: WidgetInstance) => void; onLayout: (l: Array<{ id: string; x: number; y: number; w: number; h: number }>) => void }) {
  const dark = useSyncExternalStore(subscribeTheme, isDarkTheme, () => false);
  const accent = accentStyle(dash.accent, dark) as React.CSSProperties;
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
      <div ref={containerRef} className="widget-stack" style={accent}>
        {sorted.map((w) => (
          <div key={w.id} style={{ height: Math.max(120, w.h * ROW) }}>
            <WidgetFrame instance={w} mod={modMap.get(w.module)} editing={editing} onConfigure={() => onConfigure(w)} onRemove={() => onRemove(w)} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cx(editing && "editing")} style={{ margin: -MARGIN[0] / 2, ...accent }}>
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

function DashboardFormModal({ open, initial, admin, onClose, onSave }: { open: boolean; admin: boolean; initial?: { name: string; icon: string; shared: boolean; accent: string | null }; onClose: () => void; onSave: (v: { name: string; icon: string; shared: boolean; accent: string | null }) => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("home");
  const [shared, setShared] = useState(true);
  const [accent, setAccent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setIcon(initial?.icon ?? "home");
      setShared(initial?.shared ?? admin);
      setAccent(initial?.accent ?? null);
    }
  }, [open, initial, admin]);
  const icons = useMemo(() => iconNames(), []);
  return (
    <Modal open={open} onClose={onClose} title={initial ? t("dashboard.rename") : t("dashboard.new")}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          try {
            await onSave({ name: name.trim(), icon, shared, accent });
            onClose();
          } finally {
            setBusy(false);
          }
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <div className="field">
          <label>{t("common.name")}</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={64} />
        </div>
        <div className="field">
          <label>{t("dashboard.icon")}</label>
          <div className="scroll-y" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 30px)", gap: 4, maxHeight: 160, padding: 2 }}>
            {icons.map((n) => (
              <button key={n} type="button" title={n} className={cx("btn btn-icon", n === icon && "btn-primary")} style={{ boxShadow: "none" }} onClick={() => setIcon(n)}>
                <Icon name={n} size={14} />
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>{t("dashboard.accent")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                title={a.name}
                aria-pressed={(accent ?? "sakura") === a.id}
                onClick={() => setAccent(a.id === "sakura" ? null : a.id)}
                className="btn btn-icon"
                style={{ background: `linear-gradient(135deg, ${a.light[0]} 50%, ${a.light[1]} 50%)`, borderColor: (accent ?? "sakura") === a.id ? "var(--ink)" : a.light[0], boxShadow: (accent ?? "sakura") === a.id ? "2px 2px 0 var(--ink)" : "none" }}
              />
            ))}
          </div>
          <span className="hint">{t("dashboard.accentHint")}</span>
        </div>
        {!initial ? (
          <label className="check" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <i aria-hidden />
            <span>{t("dashboard.visibleToAll")}{!shared ? ` ${t("dashboard.visibleOff")}` : ""}</span>
          </label>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ShareModal({ open, dash, admin, onClose }: { open: boolean; dash: Dashboard | null; admin: boolean; onClose: () => void }) {
  const t = useT();
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
    <Modal open={open} onClose={onClose} title={t("dashboard.sharingTitle", { name: dash.name })}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label className="check" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <i aria-hidden />
          <span>{t("dashboard.sharedWithAll")}</span>
        </label>
        {!shared ? (
          admin ? (
            <div className="field">
              <label>{t("dashboard.whoElse")}</label>
              {others.length === 0 ? (
                <div className="soft" style={{ fontSize: 12 }}>{t("dashboard.noOtherMembers")}</div>
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
              <span className="hint">{t("dashboard.readOnlyHint")}</span>
            </div>
          ) : (
            <div className="soft" style={{ fontSize: 12 }}>{t("dashboard.privateHint")}</div>
          )
        ) : null}
        {admin ? (
          <div className="field">
            <label>{t("dashboard.owner")}</label>
            <select className="input" value={owner ?? ""} onChange={(e) => setOwner(e.target.value || null)}>
              <option value="">{t("dashboard.hubOwner")}</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.id === auth.data?.user?.id ? ` ${t("common.you")}` : ""}
                </option>
              ))}
            </select>
            <span className="hint">{t("dashboard.ownerHint")}</span>
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={m.update.isPending}
            onClick={() =>
              m.update.mutate(
                { id: dash.id, shared, access, ...(admin ? { ownerId: owner } : {}) },
                {
                  onSuccess: () => {
                    toast(t("dashboard.sharingUpdated"), "ok");
                    onClose();
                  },
                  onError: (err) => toast(err.message, "bad"),
                },
              )
            }
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
