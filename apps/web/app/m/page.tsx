"use client";

import type { PageProps as ModulePageProps } from "@orbis/sdk/client";
import { Empty, Icon, Tab, Tabs } from "@orbis/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Component, Suspense, type ComponentType, type ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { ModuleProvider, useModuleClient } from "@/lib/module-host";
import { useModules } from "@/lib/queries";

export default function Page() {
  return (
    <Suspense fallback={<Shell title="…">{null}</Shell>}>
      <ModulePageView />
    </Suspense>
  );
}

function ModulePageView() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id");
  const modules = useModules();
  const mod = modules.data?.find((m) => m.id === id);
  const pageId = params.get("page") ?? mod?.manifest.pages[0]?.id ?? null;
  const page = mod?.manifest.pages.find((p) => p.id === pageId);
  const { client, error } = useModuleClient(mod);

  const title = mod ? (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Icon name={page?.icon ?? mod.manifest.icon ?? "square"} size={16} style={{ color: "var(--accent)" }} />
      {mod.manifest.name}
      {page && mod.manifest.pages.length === 1 && page.name !== mod.manifest.name ? <span className="soft">· {page.name}</span> : null}
    </span>
  ) : (
    "module"
  );

  let body: ReactNode;
  if (modules.isPending) body = null;
  else if (!mod) body = <Empty icon="warning-diamond" title="module not found">{`"${id}" is not installed.`} <Link href="/modules/">modules</Link></Empty>;
  else if (!mod.enabled) body = <Empty icon="power-off" title="module disabled">enable {mod.manifest.name} under <Link href="/modules/">modules</Link>.</Empty>;
  else if (mod.error) body = <Empty icon="bug" title="module error">{mod.error}</Empty>;
  else if (error) body = <Empty icon="bug" title="failed to load">{error.message}</Empty>;
  else if (!client) body = <div className="soft pixel" style={{ fontSize: 12 }}>loading<span className="blink">…</span></div>;
  else {
    const Comp = (pageId ? client.pages?.[pageId] : undefined) as ComponentType<ModulePageProps> | undefined;
    body = Comp ? (
      <ModuleProvider mod={mod}>
        <PageErrorBoundary key={`${mod.id}:${pageId}`}>
          <Comp pageId={pageId!} params={params} />
        </PageErrorBoundary>
      </ModuleProvider>
    ) : (
      <Empty icon="warning-diamond" title="page not found">{`${mod.manifest.name} has no page "${pageId}".`}</Empty>
    );
  }

  return (
    <Shell title={title}>
      {mod && mod.manifest.pages.length > 1 ? (
        <Tabs className="mb-4">
          {mod.manifest.pages.map((p) => (
            <Tab key={p.id} active={p.id === pageId} onClick={() => router.replace(`/m/?id=${mod.id}&page=${p.id}`)}>
              {p.icon ? <Icon name={p.icon} size={13} /> : null}
              {p.name}
            </Tab>
          ))}
        </Tabs>
      ) : null}
      <div className={mod && mod.manifest.pages.length > 1 ? "win win-flat" : ""} style={mod && mod.manifest.pages.length > 1 ? { padding: 14 } : undefined}>
        {body}
      </div>
    </Shell>
  );
}

class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <Empty icon="bug" title="page crashed">{this.state.error.message}</Empty>;
    return this.props.children;
  }
}
