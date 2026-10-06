"use client";

import type { InstalledModule } from "@orbis/sdk";
import type { SettingsProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Modal, Switch, Tab, Tabs, useToast, Window } from "@orbis/ui";
import Link from "next/link";
import { useState, type ComponentType } from "react";
import { useConfirm } from "@/components/Confirm";
import { SchemaForm, schemaDefaults, type JsonSchema } from "@/components/SchemaForm";
import { Shell } from "@/components/Shell";
import { useT } from "@/lib/i18n";
import { evictModuleClient, ModuleProvider, useModuleClient } from "@/lib/module-host";
import { isAdminRole, useAuthStatus, useModuleDetail, useModuleMutations, useModules, useRegistry, type RegistryModule } from "@/lib/queries";

export default function ModulesPage() {
  const t = useT();
  const [tab, setTab] = useState<"installed" | "store">("installed");
  const modules = useModules();
  const [settingsFor, setSettingsFor] = useState<InstalledModule | null>(null);
  return (
    <Shell
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="blocks" size={16} style={{ color: "var(--accent)" }} /> {t("modules.title")}
        </span>
      }
    >
      <Tabs className="mb-4">
        <Tab active={tab === "installed"} onClick={() => setTab("installed")}>
          {t("modules.tab.installed")} <Chip style={{ fontSize: 10 }}>{modules.data?.length ?? 0}</Chip>
        </Tab>
        <Tab active={tab === "store"} onClick={() => setTab("store")}>
          {t("modules.tab.store")}
        </Tab>
      </Tabs>
      {tab === "installed" ? <Installed onSettings={setSettingsFor} /> : <Store />}
      <ModuleSettingsModal mod={settingsFor} onClose={() => setSettingsFor(null)} />
    </Shell>
  );
}

function Installed({ onSettings }: { onSettings: (m: InstalledModule) => void }) {
  const t = useT();
  const modules = useModules();
  const m = useModuleMutations();
  // module settings (incl. secrets) are admin-only on the hub (#38); members do not get a form they cannot save
  const admin = isAdminRole(useAuthStatus().data?.user?.role);
  const toast = useToast();
  const confirm = useConfirm();
  const list = modules.data ?? [];
  if (modules.isPending) return null;
  if (list.length === 0)
    return (
      <Empty icon="blocks" title={t("modules.empty.title")}>
        {t("modules.empty.before")} <code>data/modules-dev/</code> {t("modules.empty.after")}
      </Empty>
    );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
      {list.map((mod) => (
        <Window
          key={mod.id}
          title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name={mod.manifest.icon ?? "square"} size={14} /> {mod.manifest.name}
            </span>
          }
          right={
            <Switch
              checked={mod.enabled}
              onChange={(e) => m.setEnabled.mutate({ id: mod.id, enabled: e.target.checked }, { onError: (err) => toast(err.message, "bad") })}
              aria-label={t("modules.enable", { name: mod.manifest.name })}
            />
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
            <div className="soft">{mod.manifest.description || t("modules.noDescription")}</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <Chip>v{mod.version}</Chip>
              <Chip>{mod.source}</Chip>
              {mod.manifest.widgets.length ? <Chip>{t("modules.widgets", { count: mod.manifest.widgets.length })}</Chip> : null}
              {mod.manifest.pages.length ? <Chip>{t("modules.pages", { count: mod.manifest.pages.length })}</Chip> : null}
              {mod.error ? (
                <Chip tone="bad" title={mod.error}>
                  {t("common.error")}
                </Chip>
              ) : mod.status && mod.status.state !== "ok" ? (
                <Chip tone={mod.status.state === "error" ? "bad" : "warn"}>{mod.status.state === "needs-setup" ? t("modules.status.needsSetup") : mod.status.state === "warning" ? t("modules.status.warning") : t("common.error")}</Chip>
              ) : mod.enabled ? (
                <Chip tone="ok">{t("modules.status.running")}</Chip>
              ) : null}
            </div>
            {mod.error ? <div style={{ color: "var(--dnd)", fontSize: 11, overflowWrap: "anywhere" }}>{mod.error}</div> : null}
            {!mod.error && mod.status && mod.status.state !== "ok" ? (
              <div className="win win-dashed win-flat" style={{ padding: "6px 8px", fontSize: 11, display: "flex", gap: 8, alignItems: "center", flexDirection: "row", borderColor: mod.status.state === "error" ? "var(--dnd)" : "var(--idle)" }}>
                <Icon name="warning-diamond" size={12} style={{ color: mod.status.state === "error" ? "var(--dnd)" : "var(--idle)", flex: "none" }} />
                <span style={{ flex: 1 }}>{mod.status.message ?? t("modules.status.attention")}</span>
                {mod.status.action ? (
                  mod.status.action.page ? (
                    <Link href={`/m/?id=${mod.id}&page=${mod.status.action.page}`} className="btn btn-sm">{mod.status.action.label}</Link>
                  ) : (
                    <Button size="sm" onClick={() => onSettings(mod)}>{mod.status.action.label}</Button>
                  )
                ) : null}
              </div>
            ) : null}
            {mod.manifest.permissions.length ? (
              <div className="soft" style={{ fontSize: 11 }}>
                {t("modules.permissions", { list: mod.manifest.permissions.join(", ") })}
              </div>
            ) : null}
            <DepsLine mod={mod} all={list} />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              <Button size="sm" onClick={() => onSettings(mod)} disabled={!mod.enabled || !admin}>
                <Icon name="sliders" size={12} /> {t("common.settings")}
              </Button>
              <Button
                size="sm"
                loading={m.reload.isPending && m.reload.variables === mod.id}
                onClick={() => {
                  evictModuleClient(mod.id);
                  m.reload.mutate(mod.id, { onSuccess: () => toast(t("modules.reloaded", { name: mod.manifest.name }), "ok"), onError: (err) => toast(err.message, "bad") });
                }}
              >
                <Icon name="reload" size={12} /> {t("common.reload")}
              </Button>
              {mod.source !== "builtin" ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    if (!(await confirm({ title: t("modules.uninstallTitle", { name: mod.manifest.name }), body: t("modules.uninstallConfirm", { name: mod.manifest.name }), confirmLabel: t("common.remove"), danger: true }))) return;
                    m.uninstall.mutate(mod.id, { onError: (err) => toast(err.message, "bad") });
                  }}
                >
                  <Icon name="trash" size={12} /> {t("common.remove")}
                </Button>
              ) : null}
            </div>
          </div>
        </Window>
      ))}
    </div>
  );
}

/** "needs: x ✓ · y (missing)" and "works with: z" on a module card. */
function DepsLine({ mod, all }: { mod: InstalledModule; all: InstalledModule[] }) {
  const t = useT();
  const m = useModuleMutations();
  const toast = useToast();
  const deps = mod.manifest.deps ?? [];
  const soft = mod.manifest.softDeps ?? [];
  if (!deps.length && !soft.length) return null;
  const state = (id: string) => {
    const target = all.find((x) => x.id === id);
    if (!target) return "missing" as const;
    if (!target.enabled) return "disabled" as const;
    if (target.error) return "error" as const;
    return "ok" as const;
  };
  const chip = (id: string, hard: boolean) => {
    const st = state(id);
    const tone = st === "ok" ? "ok" : hard ? "bad" : undefined;
    return (
      <span key={id} style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
        <Chip tone={tone} style={{ fontSize: 10 }} title={t(`modules.deps.${st}`)}>
          {id}
          {st === "ok" ? " ✓" : st === "missing" ? "" : ` (${t(`modules.deps.${st}`)})`}
        </Chip>
        {st === "missing" ? (
          <Button size="sm" variant="ghost" style={{ padding: "0 6px", fontSize: 10 }} loading={m.install.isPending && m.install.variables?.id === id} onClick={() => m.install.mutate({ id }, { onSuccess: () => toast(t("modules.installed", { name: id }), "ok"), onError: (e) => toast(t("modules.installError", { name: id, error: e.message }), "bad") })}>
            {t("common.install")}
          </Button>
        ) : null}
      </span>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
      {deps.length ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          <span className="soft">{t("modules.deps.needs")}</span>
          {deps.map((d) => chip(d, true))}
        </div>
      ) : null}
      {soft.length ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          <span className="soft">{t("modules.deps.worksWith")}</span>
          {soft.map((d) => chip(d, false))}
        </div>
      ) : null}
    </div>
  );
}

function Store() {
  const t = useT();
  const [refresh, setRefresh] = useState(false);
  const reg = useRegistry(refresh);
  const m = useModuleMutations();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [url, setUrl] = useState("");
  const items = (reg.data?.modules ?? []).filter((x) => !q || `${x.name} ${x.description} ${(x.tags ?? []).join(" ")}`.toLowerCase().includes(q.toLowerCase()));

  const install = (input: { id?: string; url?: string }, name: string) =>
    m.install.mutate(input, {
      onSuccess: (r) => toast(r.installedDeps?.length ? t("modules.installedWith", { name, deps: r.installedDeps.join(", ") }) : t("modules.installed", { name }), "ok"),
      onError: (err) => toast(t("modules.installFailed", { error: err.message }), "bad"),
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Input type="search" placeholder={t("modules.store.search")} aria-label={t("modules.store.search")} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <Button size="sm" onClick={() => setRefresh((v) => !v)} loading={reg.isFetching}>
          <Icon name="reload" size={12} /> {t("common.refresh")}
        </Button>
        <span className="soft" style={{ fontSize: 11 }}>
          {t("modules.store.registries", { count: reg.data?.registries.length ?? 0 })}
        </span>
      </div>
      {reg.data?.errors.map((e) => (
        <div key={e.url} className="win win-dashed win-flat" style={{ padding: "6px 10px", fontSize: 11, color: "var(--idle)" }}>
          <Icon name="warning-diamond" size={12} /> {e.url}: {e.error}
        </div>
      ))}
      {reg.isPending ? (
        <div className="soft pixel" style={{ fontSize: 12 }}>
          {t("modules.store.fetching")}<span className="blink">…</span>
        </div>
      ) : items.length === 0 ? (
        <Empty icon="store" title={t("modules.store.empty.title")}>
          {reg.data?.modules.length ? t("modules.store.empty.noMatch") : t("modules.store.empty.noRegistry")}
        </Empty>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
          {items.map((x) => (
            <StoreCard key={`${x.registry}/${x.id}`} entry={x} busy={m.install.isPending && m.install.variables?.id === x.id} onInstall={() => install({ id: x.id }, x.name)} />
          ))}
        </div>
      )}
      <Window title={t("modules.store.fromUrl")} dashed>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url) install({ url }, url);
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <Input type="url" inputMode="url" placeholder="https://github.com/you/module-x/releases/download/v0.1.0/module.tgz" aria-label={t("modules.store.fromUrl")} value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
          <Button type="submit" loading={m.install.isPending && !!m.install.variables?.url} disabled={!url}>
            <Icon name="download" size={12} /> {t("common.install")}
          </Button>
        </form>
        <p className="soft" style={{ fontSize: 11, marginTop: 8 }}>
          {t("modules.store.trust")} {t("modules.store.trustCovers")} <b>{t("modules.store.trustNotCovered")}</b>
        </p>
      </Window>
    </div>
  );
}

function StoreCard({ entry, busy, onInstall }: { entry: RegistryModule; busy: boolean; onInstall: () => void }) {
  const t = useT();
  const installed = entry.installedVersion;
  const upgrade = installed && installed !== entry.latest;
  return (
    <Window
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name={entry.icon ?? "square"} size={14} /> {entry.name}
        </span>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
        <div className="soft">{entry.description}</div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <Chip>v{entry.latest}</Chip>
          {entry.author ? <Chip>{entry.author}</Chip> : null}
          {(entry.tags ?? []).map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
        {entry.deps?.length || entry.softDeps?.length ? (
          <div className="soft" style={{ fontSize: 11 }}>
            {entry.deps?.length ? <span>{t("modules.store.needs", { deps: entry.deps.join(", ") })}</span> : null}
            {entry.softDeps?.length ? <span>{t("modules.store.worksWith", { deps: entry.softDeps.join(", ") })}</span> : null}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
          {installed && !upgrade ? (
            <Chip tone="ok">{t("modules.store.installed")}</Chip>
          ) : (
            <Button size="sm" variant={upgrade ? "primary" : "default"} loading={busy} onClick={onInstall}>
              <Icon name="download" size={12} /> {upgrade ? t("modules.store.update", { from: installed, to: entry.latest }) : t("common.install")}
            </Button>
          )}
          {entry.repo ? (
            <a href={entry.repo.replace(/^github:/, "https://github.com/")} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
              {t("modules.store.source")}
            </a>
          ) : null}
        </div>
      </div>
    </Window>
  );
}

function ModuleSettingsModal({ mod, onClose }: { mod: InstalledModule | null; onClose: () => void }) {
  const t = useT();
  const detail = useModuleDetail(mod?.id ?? null);
  if (!mod) return null;
  return (
    <Modal open onClose={onClose} title={t("modules.settingsTitle", { name: mod.manifest.name })} closeLabel={t("common.close")}>
      {detail.data ? (
        <ModuleSettingsForm key={mod.id} mod={mod} initial={detail.data.settings} onClose={onClose} />
      ) : detail.error ? (
        <div style={{ color: "var(--dnd)", fontSize: 12 }}>{detail.error.message}</div>
      ) : (
        <div className="soft pixel" style={{ fontSize: 12 }}>
          {t("common.loading")}<span className="blink">…</span>
        </div>
      )}
    </Modal>
  );
}

function ModuleSettingsForm({ mod, initial, onClose }: { mod: InstalledModule; initial: Record<string, unknown>; onClose: () => void }) {
  const t = useT();
  const m = useModuleMutations();
  const toast = useToast();
  const [value, setValue] = useState<Record<string, unknown>>(() => ({ ...schemaDefaults(mod.manifest.settingsSchema as JsonSchema | undefined), ...initial }));
  const { client } = useModuleClient(mod);
  const Custom = client?.settings as ComponentType<SettingsProps> | undefined;
  const schema = (mod.manifest.settingsSchema ?? { type: "object", properties: {} }) as JsonSchema;
  return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <ModuleProvider mod={mod}>
          {Custom ? <Custom value={value} onChange={setValue} /> : <SchemaForm schema={schema} value={value} onChange={setValue} idPrefix={`ms-${mod.id}`} />}
        </ModuleProvider>
        <Field hint={t("modules.settingsHint", { id: mod.id, version: mod.version })}>{null}</Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={m.patchSettings.isPending}
            onClick={() =>
              m.patchSettings.mutate(
                { id: mod.id, patch: value },
                {
                  onSuccess: () => {
                    toast(t("modules.settingsSaved"), "ok");
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
  );
}
