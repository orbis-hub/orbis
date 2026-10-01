"use client";

import type { InstalledModule, WidgetInstance } from "@orbis/sdk";
import type { WidgetProps } from "@orbis/sdk/client";
import { Button, Icon, Menu, Window } from "@orbis/ui";
import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ModuleProvider, useModuleClient } from "@/lib/module-host";
import { schemaDefaults } from "../SchemaForm";

type Props = {
  instance: WidgetInstance;
  mod: InstalledModule | undefined;
  editing: boolean;
  onConfigure: () => void;
  onRemove: () => void;
};

export function WidgetFrame({ instance, mod, editing, onConfigure, onRemove }: Props) {
  const def = mod?.manifest.widgets.find((w) => w.id === instance.widget);
  const title = instance.config.title ? String(instance.config.title) : (def?.name ?? instance.widget);
  const chromeless = def?.chromeless && !editing;
  const body = <WidgetBody instance={instance} mod={mod} editing={editing} />;

  const menu = editing ? (
    <Menu
      trigger={
        <Button icon size="sm" variant="ghost" aria-label="widget menu" onMouseDown={(e) => e.stopPropagation()}>
          <Icon name="more-horizontal" size={14} />
        </Button>
      }
      items={[
        { label: "configure", icon: "sliders", onSelect: onConfigure, disabled: !def?.configSchema && !mod?.manifest.widgets.length },
        { sep: true, label: "" },
        { label: "remove", icon: "trash", danger: true, onSelect: onRemove },
      ]}
    />
  ) : null;

  if (chromeless) {
    return <div className="widget">{body}</div>;
  }
  return (
    <div className="widget">
      <Window title={<span className="widget-handle" style={{ display: "block" }}>{title}</span>} right={menu} titleProps={{ className: "win-title widget-handle" }} bodyClassName="widget-body">
        {body}
      </Window>
    </div>
  );
}

function WidgetBody({ instance, mod, editing }: { instance: WidgetInstance; mod: InstalledModule | undefined; editing: boolean }) {
  const { client, error } = useModuleClient(mod);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ width: e.contentRect.width, height: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let content: ReactNode;
  if (!mod) content = <Problem icon="warning-diamond" text={`module "${instance.module}" is not installed`} />;
  else if (!mod.enabled) content = <Problem icon="power-off" text={`${mod.manifest.name} is disabled`} />;
  else if (mod.error) content = <Problem icon="bug" text={mod.error} />;
  else if (error) content = <Problem icon="bug" text={`failed to load ${mod.manifest.name}: ${error.message}`} />;
  else if (!client) content = <div className="soft pixel" style={{ fontSize: 12, padding: 8 }}>loading<span className="blink">…</span></div>;
  else {
    const Comp = client.widgets?.[instance.widget] as ComponentType<WidgetProps> | undefined;
    if (!Comp) content = <Problem icon="warning-diamond" text={`widget "${instance.widget}" not found in ${mod.manifest.name}`} />;
    else {
      const def = mod.manifest.widgets.find((w) => w.id === instance.widget);
      const config = { ...schemaDefaults(def?.configSchema as never), ...instance.config };
      content = (
        <ModuleProvider mod={mod}>
          <WidgetErrorBoundary key={`${mod.id}@${mod.version}`}>
            <Comp instance={instance} config={config} size={size} editing={editing} />
          </WidgetErrorBoundary>
        </ModuleProvider>
      );
    }
  }
  return (
    <div ref={ref} style={{ height: "100%", width: "100%", minHeight: 40 }}>
      {content}
    </div>
  );
}

function Problem({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="soft" style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, padding: 4 }}>
      <Icon name={icon} size={16} style={{ flex: "none", marginTop: 2 }} />
      <span style={{ overflowWrap: "anywhere" }}>{text}</span>
    </div>
  );
}

class WidgetErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <Problem icon="bug" text={`widget crashed: ${this.state.error.message}`} />;
    return this.props.children;
  }
}
