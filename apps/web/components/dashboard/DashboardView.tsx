"use client";

import type { Dashboard, InstalledModule, WidgetDef, WidgetInstance } from "@orbis/sdk";
import { ACCENTS, accentStyle, Button, cx, Empty, Field, Icon, Input, isDarkTheme, Menu, Modal, useStableId, useToast, iconNames } from "@orbis/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import GridLayout, { useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import { useConfirm } from "@/components/Confirm";
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
  const confirm = useConfirm();

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

  // the h1 in Shell truncates with an ellipsis, but only inline text can be cut: the name gets its own shrinkable span, icon and chips stay whole
  const title = dash ? (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, maxWidth: "100%", minWidth: 0, verticalAlign: "bottom" }} title={dash.name}>
      <Icon name={dash.icon ?? "home"} size={16} style={{ color: "var(--accent-ink)", flex: "none" }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dash.name}</span>
      {!dash.shared ? <Icon name="lock" size={12} className="soft" title={t("dashboard.private")} style={{ flex: "none" }} /> : null}
      {!canEdit ? <span className="chip" style={{ fontSize: "var(--fs-meta)", flex: "none" }}>{t("dashboard.readOnly")}</span> : null}
    </span>
  ) : (
    t("common.dashboard")
  );

  const actions = (
    <>
      {canEdit ? (
        // phones show the stacked list (no editing), so add/edit are hidden there (.hide-phone in globals.css)
        <>
          <Button size="sm" className="hide-phone" onClick={() => setAdding(true)} disabled={!dash} aria-label={t("dashboard.addWidget")} title={t("dashboard.addWidget")}>
            <Icon name="plus" size={14} />
            <span className="hide-sm" aria-hidden>{t("dashboard.widget")}</span>
          </Button>
          <Button size="sm" className="hide-phone" aria-pressed={editing} onClick={() => setEditMode(!editMode)} disabled={!dash} aria-label={editing ? t("dashboard.editDone") : t("dashboard.editLayout")} title={editing ? t("dashboard.editDone") : t("dashboard.editLayout")}>
            <Icon name={editing ? "check" : "move"} size={14} />
            <span className="hide-sm" aria-hidden>{editing ? t("common.done") : t("common.edit")}</span>
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
              if (!dash) return;
              if (!(await confirm({ title: t("dashboard.delete"), body: t("dashboard.deleteConfirm", { name: dash.name, count: dash.widgets.length }), confirmLabel: t("common.delete"), danger: true }))) return;
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
      {sharing && dash ? <ShareModal dash={dash} admin={admin} onClose={() => setSharing(false)} /> : null}
      {creating || renaming ? (
        <DashboardFormModal
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
      ) : null}
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

/** mounted only while open (see DashboardView), so the initial values are read once */
function DashboardFormModal({ initial, admin, onClose, onSave }: { admin: boolean; initial?: { name: string; icon: string; shared: boolean; accent: string | null }; onClose: () => void; onSave: (v: { name: string; icon: string; shared: boolean; accent: string | null }) => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "home");
  const [shared, setShared] = useState(initial?.shared ?? admin);
  const [accent, setAccent] = useState<string | null>(initial?.accent ?? null);
  const [busy, setBusy] = useState(false);
  const icons = useMemo(() => iconNames(), []);
  const iconsId = useStableId("dash-icons");
  const accentId = useStableId("dash-accent");
  return (
    <Modal open onClose={onClose} title={initial ? t("dashboard.rename") : t("dashboard.new")} closeLabel={t("common.close")}>
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
        <Field label={t("common.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={64} />
        </Field>
        <div className="field" role="group" aria-labelledby={iconsId}>
          <label id={iconsId}>{t("dashboard.icon")}</label>
          <div className="scroll-y" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, 30px)", gap: 4, maxHeight: 160, padding: 2 }}>
            {icons.map((n) => (
              <button key={n} type="button" title={n} aria-label={n} aria-pressed={n === icon} className={cx("btn btn-icon", n === icon && "btn-primary")} style={{ boxShadow: "none" }} onClick={() => setIcon(n)}>
                <Icon name={n} size={14} />
              </button>
            ))}
          </div>
        </div>
        <div className="field" role="group" aria-labelledby={accentId}>
          <label id={accentId}>{t("dashboard.accent")}</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                title={a.name}
                aria-label={a.name}
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

/** mounted only while open (see DashboardView), so the dashboard's current sharing is read once */
function ShareModal({ dash, admin, onClose }: { dash: Dashboard; admin: boolean; onClose: () => void }) {
  const t = useT();
  const users = useUsers(admin);
  const m = useDashboardMutations();
  const toast = useToast();
  const auth = useAuthStatus();
  const [shared, setShared] = useState(dash.shared);
  const [access, setAccess] = useState<string[]>(dash.access);
  const [owner, setOwner] = useState<string | null>(dash.ownerId);
  const whoId = useStableId("share-who");
  const ownerId = useStableId("share-owner");
  const others = (users.data ?? []).filter((u) => u.id !== (owner ?? "") && u.role !== "owner" && u.role !== "admin");
  return (
    <Modal open onClose={onClose} title={t("dashboard.sharingTitle", { name: dash.name })} closeLabel={t("common.close")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label className="check" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <i aria-hidden />
          <span>{t("dashboard.sharedWithAll")}</span>
        </label>
        {!shared ? (
          admin ? (
            <div className="field" role="group" aria-labelledby={whoId}>
              <label id={whoId}>{t("dashboard.whoElse")}</label>
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
            <label htmlFor={ownerId}>{t("dashboard.owner")}</label>
            <select id={ownerId} className="input" value={owner ?? ""} onChange={(e) => setOwner(e.target.value || null)}>
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
