"use client";

import { Checkbox, Field, Input, Select, Textarea } from "@orbis/ui";
import { useT } from "@/lib/i18n";

/**
 * Minimal JSON-schema → form renderer for module/widget settings.
 * Supports: object with properties of type string (enum, format textarea/password/secret/color/url), number/integer, boolean, array of strings (comma separated).
 * `format: "secret"` = a credential: rendered masked, and the hub strips it from the settings members receive.
 */
export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  enumNames?: string[];
  format?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  placeholder?: string;
  order?: string[];
};

export function schemaDefaults(schema: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(schema?.properties ?? {})) if (p.default !== undefined) out[k] = p.default;
  return out;
}

export function SchemaForm({ schema, value, onChange, idPrefix = "sf" }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; idPrefix?: string }) {
  const t = useT();
  const props = schema.properties ?? {};
  const keys = schema.order ?? Object.keys(props);
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  if (keys.length === 0) return <div className="empty">{t("form.nothing")}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {keys.map((k) => {
        const p = props[k];
        if (!p) return null;
        const id = `${idPrefix}-${k}`;
        const type = Array.isArray(p.type) ? p.type[0] : p.type;
        const v = value[k] ?? p.default;
        const label = p.title ?? k;
        if (type === "boolean") {
          return (
            <Field key={k} hint={p.description}>
              <Checkbox id={id} checked={!!v} onChange={(e) => set(k, e.target.checked)} label={label} />
            </Field>
          );
        }
        if (p.enum) {
          return (
            <Field key={k} label={label} hint={p.description} htmlFor={id}>
              <Select id={id} value={String(v ?? "")} onChange={(e) => set(k, coerce(e.target.value, p.enum!))}>
                {v === undefined ? <option value="">—</option> : null}
                {p.enum.map((opt, i) => (
                  <option key={String(opt)} value={String(opt)}>
                    {p.enumNames?.[i] ?? String(opt)}
                  </option>
                ))}
              </Select>
            </Field>
          );
        }
        if (type === "number" || type === "integer") {
          return (
            <Field key={k} label={label} hint={p.description} htmlFor={id}>
              <Input id={id} type="number" value={v === undefined || v === null ? "" : String(v)} min={p.minimum} max={p.maximum} step={p.step ?? (type === "integer" ? 1 : "any")} onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />
            </Field>
          );
        }
        if (type === "array") {
          const arr = Array.isArray(v) ? (v as unknown[]) : [];
          return (
            <Field key={k} label={label} hint={p.description ?? t("form.commaSeparated")} htmlFor={id}>
              <Input id={id} value={arr.join(", ")} onChange={(e) => set(k, e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} placeholder={p.placeholder} />
            </Field>
          );
        }
        if (p.format === "textarea" || p.format === "multiline") {
          return (
            <Field key={k} label={label} hint={p.description} htmlFor={id}>
              <Textarea id={id} value={String(v ?? "")} onChange={(e) => set(k, e.target.value)} placeholder={p.placeholder} />
            </Field>
          );
        }
        // "secret" marks credentials the hub never hands to members (#38); shown masked like "password"
        const inputType = p.format === "password" || p.format === "secret" ? "password" : p.format === "color" ? "color" : p.format === "url" || p.format === "uri" ? "url" : p.format === "time" ? "time" : p.format === "date" ? "date" : "text";
        return (
          <Field key={k} label={label} hint={p.description} htmlFor={id}>
            <Input id={id} type={inputType} value={String(v ?? "")} onChange={(e) => set(k, e.target.value)} placeholder={p.placeholder} autoComplete={inputType === "password" ? "new-password" : undefined} />
          </Field>
        );
      })}
    </div>
  );
}

function coerce(raw: string, options: unknown[]) {
  return options.find((o) => String(o) === raw) ?? raw;
}
