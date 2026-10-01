"use client";

import type { InstalledModule, WidgetInstance } from "@orbis/sdk";
import type { SettingsProps } from "@orbis/sdk/client";
import { Button, Field, Input, Modal } from "@orbis/ui";
import { useEffect, useState, type ComponentType } from "react";
import { ModuleProvider, useModuleClient } from "@/lib/module-host";
import { SchemaForm, schemaDefaults, type JsonSchema } from "../SchemaForm";

export function WidgetConfigModal({ instance, mod, onClose, onSave }: { instance: WidgetInstance | null; mod: InstalledModule | undefined; onClose: () => void; onSave: (config: Record<string, unknown>) => Promise<void> }) {
  const [value, setValue] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const def = mod?.manifest.widgets.find((w) => w.id === instance?.widget);
  const { client } = useModuleClient(mod);
  useEffect(() => {
    if (instance) setValue({ ...schemaDefaults(def?.configSchema as JsonSchema | undefined), ...instance.config });
  }, [instance, def]);
  if (!instance || !mod) return null;
  const Custom = client?.widgetConfig?.[instance.widget] as ComponentType<SettingsProps> | undefined;
  const schema = (def?.configSchema ?? { type: "object", properties: {} }) as JsonSchema;
  return (
    <Modal open onClose={onClose} title={`configure · ${def?.name ?? instance.widget}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="title" hint="shown in the widget's title bar (empty = default)">
          <Input value={String(value.title ?? "")} onChange={(e) => setValue({ ...value, title: e.target.value || undefined })} placeholder={def?.name} />
        </Field>
        <hr className="dotted-hr" style={{ margin: 0 }} />
        <ModuleProvider mod={mod}>{Custom ? <Custom value={value} onChange={setValue} /> : <SchemaForm schema={schema} value={value} onChange={setValue} idPrefix={`w-${instance.id}`} />}</ModuleProvider>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(value);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
