"use client";

import type { InstalledModule, WidgetInstance } from "@orbis/sdk";
import type { SettingsProps } from "@orbis/sdk/client";
import { Button, Field, Input, Modal } from "@orbis/ui";
import { useState, type ComponentType } from "react";
import { useT } from "@/lib/i18n";
import { ModuleProvider, useModuleClient } from "@/lib/module-host";
import { SchemaForm, schemaDefaults, type JsonSchema } from "../SchemaForm";

type Props = { instance: WidgetInstance | null; mod: InstalledModule | undefined; onClose: () => void; onSave: (config: Record<string, unknown>) => Promise<void> };

export function WidgetConfigModal({ instance, mod, onClose, onSave }: Props) {
  if (!instance || !mod) return null;
  // keyed by widget instance: a different widget gets a fresh form, no state sync in an effect
  return <WidgetConfigForm key={instance.id} instance={instance} mod={mod} onClose={onClose} onSave={onSave} />;
}

function WidgetConfigForm({ instance, mod, onClose, onSave }: { instance: WidgetInstance; mod: InstalledModule; onClose: () => void; onSave: Props["onSave"] }) {
  const t = useT();
  const def = mod.manifest.widgets.find((w) => w.id === instance.widget);
  const [value, setValue] = useState<Record<string, unknown>>(() => ({ ...schemaDefaults(def?.configSchema as JsonSchema | undefined), ...instance.config }));
  const [busy, setBusy] = useState(false);
  const { client } = useModuleClient(mod);
  const Custom = client?.widgetConfig?.[instance.widget] as ComponentType<SettingsProps> | undefined;
  const schema = (def?.configSchema ?? { type: "object", properties: {} }) as JsonSchema;
  return (
    <Modal open onClose={onClose} title={t("dashboard.configureTitle", { name: def?.name ?? instance.widget })} closeLabel={t("common.close")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label={t("dashboard.widgetTitle")} hint={t("dashboard.widgetTitleHint")}>
          <Input value={String(value.title ?? "")} onChange={(e) => setValue({ ...value, title: e.target.value || undefined })} placeholder={def?.name} />
        </Field>
        <hr className="dotted-hr" style={{ margin: 0 }} />
        <ModuleProvider mod={mod}>{Custom ? <Custom value={value} onChange={setValue} /> : <SchemaForm schema={schema} value={value} onChange={setValue} idPrefix={`w-${instance.id}`} />}</ModuleProvider>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
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
            {t("common.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
