"use client";

import type { InstalledModule } from "@orbis/sdk";
import type { SettingsProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Modal, Switch, Tab, Tabs, useToast, Window } from "@orbis/ui";
import Link from "next/link";
import { useEffect, useState, type ComponentType } from "react";
import { SchemaForm, schemaDefaults, type JsonSchema } from "@/components/SchemaForm";
import { Shell } from "@/components/Shell";
import { evictModuleClient, ModuleProvider, useModuleClient } from "@/lib/module-host";
import { useModuleDetail, useModuleMutations, useModules, useRegistry, type RegistryModule } from "@/lib/queries";

export default function ModulesPage() {
  const [tab, setTab] = useState<"installed" | "store">("installed");
  const modules = useModules();
  const [settingsFor, setSettingsFor] = useState<InstalledModule | null>(null);
  return (
    <Shell
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="blocks" size={16} style={{ color: "var(--accent)" }} /> modules
        </span>
      }
    >
      <Tabs className="mb-4">
        <Tab active={tab === "installed"} onClick={() => setTab("installed")}>
          installed <Chip style={{ fontSize: 10 }}>{modules.data?.length ?? 0}</Chip>
        </Tab>
        <Tab active={tab === "store"} onClick={() => setTab("store")}>
          store
        </Tab>
      </Tabs>
      {tab === "installed" ? <Installed onSettings={setSettingsFor} /> : <Store />}
      <ModuleSettingsModal mod={settingsFor} onClose={() => setSettingsFor(null)} />
    </Shell>
  );
}

function Installed({ onSettings }: { onSettings: (m: InstalledModule) => void }) {
  const modules = useModules();
  const m = useModuleMutations();
  const toast = useToast();
  const list = modules.data ?? [];
  if (modules.isPending) return null;
  if (list.length === 0)
    return (
      <Empty icon="blocks" title="no modules yet">
        head to the store tab or drop a module into <code>data/modules-dev/</code> for development.
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
              aria-label={`enable ${mod.manifest.name}`}
            />
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
            <div className="soft">{mod.manifest.description || "no description"}</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <Chip>v{mod.version}</Chip>
              <Chip>{mod.source}</Chip>
              {mod.manifest.widgets.length ? <Chip>{mod.manifest.widgets.length} widget{mod.manifest.widgets.length > 1 ? "s" : ""}</Chip> : null}
              {mod.manifest.pages.length ? <Chip>{mod.manifest.pages.length} page{mod.manifest.pages.length > 1 ? "s" : ""}</Chip> : null}
              {mod.error ? (
                <Chip tone="bad" title={mod.error}>
                  error
                </Chip>
              ) : mod.status && mod.status.state !== "ok" ? (
                <Chip tone={mod.status.state === "error" ? "bad" : "warn"}>{mod.status.state === "needs-setup" ? "needs setup" : mod.status.state}</Chip>
              ) : mod.enabled ? (
                <Chip tone="ok">running</Chip>
              ) : null}
            </div>
            {mod.error ? <div style={{ color: "var(--dnd)", fontSize: 11, overflowWrap: "anywhere" }}>{mod.error}</div> : null}
            {!mod.error && mod.status && mod.status.state !== "ok" ? (
              <div className="win win-dashed win-flat" style={{ padding: "6px 8px", fontSize: 11, display: "flex", gap: 8, alignItems: "center", flexDirection: "row", borderColor: mod.status.state === "error" ? "var(--dnd)" : "var(--idle)" }}>
                <Icon name="warning-diamond" size={12} style={{ color: mod.status.state === "error" ? "var(--dnd)" : "var(--idle)", flex: "none" }} />
                <span style={{ flex: 1 }}>{mod.status.message ?? "this module needs attention"}</span>
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
                permissions: {mod.manifest.permissions.join(", ")}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              <Button size="sm" onClick={() => onSettings(mod)} disabled={!mod.enabled}>
                <Icon name="sliders" size={12} /> settings
              </Button>
              <Button
                size="sm"
                loading={m.reload.isPending && m.reload.variables === mod.id}
                onClick={() => {
                  evictModuleClient(mod.id);
                  m.reload.mutate(mod.id, { onSuccess: () => toast(`${mod.manifest.name} reloaded`, "ok"), onError: (err) => toast(err.message, "bad") });
                }}
              >
                <Icon name="reload" size={12} /> reload
              </Button>
              {mod.source !== "builtin" ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    if (!confirm(`uninstall ${mod.manifest.name}? its widgets and data are removed.`)) return;
                    m.uninstall.mutate(mod.id, { onError: (err) => toast(err.message, "bad") });
                  }}
                >
                  <Icon name="trash" size={12} /> remove
                </Button>
              ) : null}
            </div>
          </div>
        </Window>
      ))}
    </div>
  );
}

function Store() {
  const [refresh, setRefresh] = useState(false);
  const reg = useRegistry(refresh);
  const m = useModuleMutations();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [url, setUrl] = useState("");
  const items = (reg.data?.modules ?? []).filter((x) => !q || `${x.name} ${x.description} ${(x.tags ?? []).join(" ")}`.toLowerCase().includes(q.toLowerCase()));

  const install = (input: { id?: string; url?: string }, name: string) =>
    m.install.mutate(input, { onSuccess: () => toast(`${name} installed`, "ok"), onError: (err) => toast(`install failed: ${err.message}`, "bad") });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Input placeholder="search the registry…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <Button size="sm" onClick={() => setRefresh((v) => !v)} loading={reg.isFetching}>
          <Icon name="reload" size={12} /> refresh
        </Button>
        <span className="soft" style={{ fontSize: 11 }}>
          {reg.data?.registries.length ?? 0} registr{(reg.data?.registries.length ?? 0) === 1 ? "y" : "ies"}
        </span>
      </div>
      {reg.data?.errors.map((e) => (
        <div key={e.url} className="win win-dashed win-flat" style={{ padding: "6px 10px", fontSize: 11, color: "var(--idle)" }}>
          <Icon name="warning-diamond" size={12} /> {e.url}: {e.error}
        </div>
      ))}
      {reg.isPending ? (
        <div className="soft pixel" style={{ fontSize: 12 }}>
          fetching registries<span className="blink">…</span>
        </div>
      ) : items.length === 0 ? (
        <Empty icon="store" title="nothing in the store">
          {reg.data?.modules.length ? "nothing matches your search." : "no registry reachable or no modules listed yet. you can still install from a tarball url below."}
        </Empty>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 14 }}>
          {items.map((x) => (
            <StoreCard key={`${x.registry}/${x.id}`} entry={x} busy={m.install.isPending && m.install.variables?.id === x.id} onInstall={() => install({ id: x.id }, x.name)} />
          ))}
        </div>
      )}
      <Window title="install from url" dashed>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url) install({ url }, url);
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <Input placeholder="https://github.com/you/module-x/releases/download/v0.1.0/module.tgz" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
          <Button type="submit" loading={m.install.isPending && !!m.install.variables?.url} disabled={!url}>
            <Icon name="download" size={12} /> install
          </Button>
        </form>
        <p className="soft" style={{ fontSize: 11, marginTop: 8 }}>
          only install modules you trust: module code runs inside your hub with full access.
        </p>
      </Window>
    </div>
  );
}

function StoreCard({ entry, busy, onInstall }: { entry: RegistryModule; busy: boolean; onInstall: () => void }) {
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
          {(entry.tags ?? []).map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
          {installed && !upgrade ? (
            <Chip tone="ok">installed</Chip>
          ) : (
            <Button size="sm" variant={upgrade ? "primary" : "default"} loading={busy} onClick={onInstall}>
              <Icon name="download" size={12} /> {upgrade ? `update ${installed} → ${entry.latest}` : "install"}
            </Button>
          )}
          {entry.repo ? (
            <a href={entry.repo.replace(/^github:/, "https://github.com/")} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
              source ↗
            </a>
          ) : null}
        </div>
      </div>
    </Window>
  );
}

function ModuleSettingsModal({ mod, onClose }: { mod: InstalledModule | null; onClose: () => void }) {
  const detail = useModuleDetail(mod?.id ?? null);
  const m = useModuleMutations();
  const toast = useToast();
  const [value, setValue] = useState<Record<string, unknown>>({});
  const { client } = useModuleClient(mod ?? undefined);
  useEffect(() => {
    if (detail.data) setValue({ ...schemaDefaults(mod?.manifest.settingsSchema as JsonSchema | undefined), ...detail.data.settings });
  }, [detail.data, mod]);
  if (!mod) return null;
  const Custom = client?.settings as ComponentType<SettingsProps> | undefined;
  const schema = (mod.manifest.settingsSchema ?? { type: "object", properties: {} }) as JsonSchema;
  return (
    <Modal open onClose={onClose} title={`${mod.manifest.name} · settings`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <ModuleProvider mod={mod}>
          {Custom ? <Custom value={value} onChange={setValue} /> : <SchemaForm schema={schema} value={value} onChange={setValue} idPrefix={`ms-${mod.id}`} />}
        </ModuleProvider>
        <Field hint={`module id: ${mod.id} · v${mod.version}`}>{null}</Field>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>cancel</Button>
          <Button
            variant="primary"
            loading={m.patchSettings.isPending}
            onClick={() =>
              m.patchSettings.mutate(
                { id: mod.id, patch: value },
                {
                  onSuccess: () => {
                    toast("settings saved", "ok");
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
