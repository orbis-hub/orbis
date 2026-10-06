import { useEffect, useMemo, useState } from "react";
import { defineClient, useModuleApi, useModuleEvents, useModuleQuery, useT, type PageProps, type SettingsProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Select, Switch, Window, cx } from "@orbis/ui";
import type { Entity } from "./server";

type Status = { connected: boolean; error: string | null; url: string; entities: number; configured: boolean };

/* ---------- live entity state: fetch once, then patch from "state" events ---------- */

function useEntities(ids: string[]) {
  const key = ids.filter(Boolean).join(",");
  const q = useModuleQuery<Entity[]>(`/entities?ids=${encodeURIComponent(key)}`, { enabled: key.length > 0, refetchOn: ["states"] });
  const [live, setLive] = useState<Record<string, Entity>>({});
  useEffect(() => {
    if (q.data) setLive(Object.fromEntries(q.data.map((e) => [e.id, e])));
  }, [q.data]);
  useModuleEvents("state", (p) => {
    const e = p as Entity;
    if (ids.includes(e.id)) setLive((prev) => ({ ...prev, [e.id]: e }));
  });
  return { entities: live, loading: q.loading && !q.data, error: q.error, refetch: q.refetch };
}

function useStatus() {
  return useModuleQuery<Status>("/status", { intervalMs: 20_000, refetchOn: ["states"] });
}

const domainIcon = (e: Entity | undefined) => {
  if (!e) return "square";
  switch (e.domain) {
    case "light": return e.state === "on" ? "lightbulb" : "lightbulb-off";
    case "switch": case "input_boolean": return e.state === "on" ? "power" : "power-off";
    case "climate": return "thermometer";
    case "sensor": case "binary_sensor": return "zap";
    case "media_player": return "music";
    case "cover": return "arrows-vertical";
    case "lock": return e.state === "locked" ? "lock" : "key";
    case "scene": return "sparkles";
    case "script": case "automation": return "script";
    case "person": case "device_tracker": return "user";
    case "weather": return "cloud-sun";
    default: return "home";
  }
};
const isOn = (e: Entity | undefined) => !!e && ["on", "open", "unlocked", "playing", "home", "heat", "cool"].includes(e.state);
const fmtValue = (e: Entity, decimals = 1) => (Number.isFinite(Number(e.state)) ? `${Number(e.state).toFixed(decimals)}${e.unit ? ` ${e.unit}` : ""}` : e.state.replace(/_/g, " "));

function NotReady({ status, entity }: { status: Status | undefined; entity?: string }) {
  const t = useT();
  if (!status) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  if (!status.configured) return <Empty icon="home" title={t("notReady.notSetup")}>{t("notReady.notSetupHint")}</Empty>;
  if (!status.connected) return <Empty icon="home" title={t("notReady.notConnected")}>{status.error ?? t("notReady.connecting")}</Empty>;
  if (!entity) return <Empty icon="home" title={t("notReady.pickEntity")}>{t("notReady.pickEntityHint")}</Empty>;
  return <Empty icon="warning-diamond" title={t("notReady.unknownEntity")}>{entity}</Empty>;
}

/* ---------- widgets ---------- */

function ToggleWidget({ config, size }: WidgetProps<{ entity?: string; name?: string }>) {
  const api = useModuleApi();
  const t = useT();
  const status = useStatus();
  const { entities } = useEntities(config.entity ? [config.entity] : []);
  const e = config.entity ? entities[config.entity] : undefined;
  if (!e) return <NotReady status={status.data} entity={config.entity} />;
  const on = isOn(e);
  const brightness = e.domain === "light" && on ? Math.round(((e.attributes.brightness as number) ?? 0) / 2.55) : null;
  const big = Math.max(24, Math.min(size.height * 0.4, size.width * 0.3));
  return (
    <button
      type="button"
      onClick={() => void api("/toggle", { method: "POST", json: { entity: e.id } })}
      style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer", color: on ? "var(--accent)" : "var(--ink-soft)" }}
      aria-pressed={on}
    >
      <Icon name={domainIcon(e)} size={big} />
      <div className="pixel" style={{ fontSize: 13, color: "var(--ink)" }}>{config.name ?? e.name}</div>
      <div style={{ fontSize: 11 }}>{on ? (brightness !== null ? t("widget.toggle.onBrightness", { brightness }) : e.state.replace(/_/g, " ")) : e.state.replace(/_/g, " ")}</div>
      {e.domain === "light" && on && size.height > 120 ? (
        <input
          type="range"
          min={1}
          max={100}
          value={brightness ?? 100}
          onClick={(ev) => ev.stopPropagation()}
          onChange={(ev) => void api("/call", { method: "POST", json: { domain: "light", service: "turn_on", entity: e.id, data: { brightness_pct: Number(ev.target.value) } } })}
          style={{ width: "80%", accentColor: "var(--accent)" }}
        />
      ) : null}
    </button>
  );
}

function Sparkline({ points, width, height }: { points: Array<{ t: string; v: number }>; width: number; height: number }) {
  if (points.length < 2) return null;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  // pixel-ish: 2px squares along the line
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} shapeRendering="crispEdges" style={{ display: "block" }}>
      {points.map((p, i) => {
        const x = Math.round(i * step);
        const y = Math.round(height - 2 - ((p.v - min) / span) * (height - 4));
        return <rect key={i} x={x} y={y} width={2} height={2} fill="var(--accent-2)" />;
      })}
    </svg>
  );
}

function SensorWidget({ config, size }: WidgetProps<{ entity?: string; name?: string; decimals?: number; sparkline?: boolean }>) {
  const status = useStatus();
  const { entities } = useEntities(config.entity ? [config.entity] : []);
  const e = config.entity ? entities[config.entity] : undefined;
  const hist = useModuleQuery<Array<{ t: string; v: number }>>(`/history/${encodeURIComponent(config.entity ?? "")}`, { enabled: !!config.entity && config.sparkline !== false && !!e && Number.isFinite(Number(e.state)), intervalMs: 10 * 60_000 });
  if (!e) return <NotReady status={status.data} entity={config.entity} />;
  const big = Math.max(20, Math.min(size.height * 0.4, size.width / 4));
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
      <div className="soft" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name={domainIcon(e)} size={12} /> {config.name ?? e.name}
      </div>
      <div className="pixel" style={{ fontSize: big, lineHeight: 1 }}>{fmtValue(e, config.decimals ?? 1)}</div>
      {config.sparkline !== false && hist.data?.length ? <Sparkline points={hist.data} width={Math.max(40, size.width - 8)} height={Math.max(16, Math.min(40, size.height * 0.25))} /> : null}
    </div>
  );
}

function ClimateWidget({ config, size }: WidgetProps<{ entity?: string; name?: string; step?: number }>) {
  const api = useModuleApi();
  const t = useT();
  const status = useStatus();
  const { entities } = useEntities(config.entity ? [config.entity] : []);
  const e = config.entity ? entities[config.entity] : undefined;
  if (!e) return <NotReady status={status.data} entity={config.entity} />;
  const target = Number(e.attributes.temperature ?? NaN);
  const current = Number(e.attributes.current_temperature ?? NaN);
  const modes = (e.attributes.hvac_modes as string[] | undefined) ?? [];
  const step = config.step ?? 0.5;
  const setTarget = (temp: number) => void api("/call", { method: "POST", json: { domain: "climate", service: "set_temperature", entity: e.id, data: { temperature: Math.round(temp * 2) / 2 } } });
  const big = Math.max(20, Math.min(size.height * 0.35, size.width / 5));
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 6 }}>
      <div className="soft" style={{ fontSize: 11 }}>{config.name ?? e.name} · {e.state.replace(/_/g, " ")}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button icon onClick={() => Number.isFinite(target) && setTarget(target - step)} aria-label={t("widget.climate.lower")}><Icon name="minus" size={16} /></Button>
        <div style={{ textAlign: "center", flex: 1 }}>
          <div className="pixel" style={{ fontSize: big, lineHeight: 1 }}>{Number.isFinite(target) ? `${target.toFixed(1)}°` : "–"}</div>
          {Number.isFinite(current) ? <div className="soft" style={{ fontSize: 11 }}>{t("widget.climate.now", { temp: current.toFixed(1) })}</div> : null}
        </div>
        <Button icon onClick={() => Number.isFinite(target) && setTarget(target + step)} aria-label={t("widget.climate.raise")}><Icon name="plus" size={16} /></Button>
      </div>
      {modes.length > 1 && size.height > 130 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
          {modes.map((m) => (
            <Button key={m} size="sm" aria-pressed={e.state === m} onClick={() => void api("/call", { method: "POST", json: { domain: "climate", service: "set_hvac_mode", entity: e.id, data: { hvac_mode: m } } })}>{m}</Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ScenesWidget({ config }: WidgetProps<{ entities?: string[] }>) {
  const api = useModuleApi();
  const status = useStatus();
  const ids = config.entities ?? [];
  const { entities } = useEntities(ids);
  if (!ids.length) return <NotReady status={status.data} />;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignContent: "flex-start", height: "100%", overflow: "auto" }}>
      {ids.map((id) => {
        const e = entities[id];
        const domain = id.split(".")[0] ?? "scene";
        return (
          <Button key={id} onClick={() => void api("/call", { method: "POST", json: { domain, service: domain === "script" ? "turn_on" : domain === "automation" ? "trigger" : "turn_on", entity: id } })}>
            <Icon name={domainIcon(e) ?? "sparkles"} size={14} /> {e?.name ?? id.split(".")[1]}
          </Button>
        );
      })}
    </div>
  );
}

function GroupWidget({ config }: WidgetProps<{ entities?: string[]; title?: string }>) {
  const api = useModuleApi();
  const status = useStatus();
  const ids = config.entities ?? [];
  const { entities } = useEntities(ids);
  if (!ids.length) return <NotReady status={status.data} />;
  return (
    <div className="scroll-y" style={{ height: "100%" }}>
      {ids.map((id) => {
        const e = entities[id];
        if (!e) return <div key={id} className="soft" style={{ fontSize: 11, padding: "4px 0" }}>{id}</div>;
        const toggleable = ["light", "switch", "input_boolean", "fan", "cover", "lock", "automation", "media_player"].includes(e.domain);
        return (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px dashed var(--line)" }}>
            <Icon name={domainIcon(e)} size={14} style={{ color: isOn(e) ? "var(--accent)" : "var(--ink-soft)", flex: "none" }} />
            <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
            {toggleable ? <Switch checked={isOn(e)} onChange={() => void api("/toggle", { method: "POST", json: { entity: e.id } })} aria-label={e.name} /> : <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{fmtValue(e)}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- page: browse entities, copy ids, toggle ---------- */

const DOMAINS = ["light", "switch", "sensor", "binary_sensor", "climate", "media_player", "cover", "lock", "scene", "script", "automation", "person", "weather", "input_boolean"];

function EntitiesPage(_p: PageProps) {
  const api = useModuleApi();
  const t = useT();
  const status = useStatus();
  const [q, setQ] = useState("");
  const [domain, setDomain] = useState("");
  const list = useModuleQuery<Entity[]>(`/entities?${new URLSearchParams({ ...(q ? { q } : {}), ...(domain ? { domain } : {}), limit: "300" })}`, { refetchOn: ["states"], enabled: !!status.data?.connected });
  const [live, setLive] = useState<Record<string, Entity>>({});
  useModuleEvents("state", (p) => setLive((prev) => ({ ...prev, [(p as Entity).id]: p as Entity })));
  const rows = useMemo(() => (list.data ?? []).map((e) => live[e.id] ?? e), [list.data, live]);
  const [copied, setCopied] = useState<string | null>(null);

  if (!status.data?.connected) {
    return (
      <Window title={t("page.entities.title")}>
        <NotReady status={status.data} />
        {status.data?.configured ? <p className="soft" style={{ fontSize: 11, marginTop: 8 }}>{t("page.entities.url", { url: status.data.url })}</p> : null}
      </Window>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Input placeholder={t("page.entities.search")} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        <Select value={domain} onChange={(e) => setDomain(e.target.value)} style={{ width: "auto" }}>
          <option value="">{t("page.entities.allDomains")}</option>
          {DOMAINS.map((d) => <option key={d} value={d}>{d}</option>)}
        </Select>
        <Chip tone="ok">{t("page.entities.live", { count: status.data.entities })}</Chip>
        <span className="soft" style={{ fontSize: 11 }}>{t("page.entities.copyHint")}</span>
      </div>
      <Window tight>
        <div className="scroll-y" style={{ maxHeight: "70vh" }}>
          {rows.length === 0 ? <div className="empty">{t("page.entities.nothingMatches")}</div> : null}
          {rows.map((e) => {
            const toggleable = ["light", "switch", "input_boolean", "fan", "cover", "lock", "automation", "media_player"].includes(e.domain);
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderBottom: "1px dashed var(--line)", fontSize: 12 }}>
                <Icon name={domainIcon(e)} size={14} style={{ color: isOn(e) ? "var(--accent)" : "var(--ink-soft)", flex: "none" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</div>
                  <button
                    type="button"
                    className={cx("soft")}
                    style={{ fontSize: 10, fontFamily: "var(--font-mono)", textDecoration: "underline dotted" }}
                    onClick={() => {
                      void navigator.clipboard?.writeText(e.id);
                      setCopied(e.id);
                      setTimeout(() => setCopied(null), 1200);
                    }}
                  >
                    {copied === e.id ? t("page.entities.copied") : e.id}
                  </button>
                </div>
                <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 60, textAlign: "right" }}>{fmtValue(e)}</span>
                {toggleable ? <Switch checked={isOn(e)} onChange={() => void api("/toggle", { method: "POST", json: { entity: e.id } })} aria-label={e.name} /> : <span style={{ width: 34 }} />}
              </div>
            );
          })}
        </div>
      </Window>
    </div>
  );
}

function HaSettings({ value, onChange }: SettingsProps) {
  const t = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label={t("settings.url")} hint={t("settings.urlHint")}>
        <Input value={String(value.url ?? "")} onChange={(e) => onChange({ ...value, url: e.target.value.trim() })} placeholder="http://homeassistant.local:8123" inputMode="url" />
      </Field>
      <Field label={t("settings.token")} hint={t("settings.tokenHint")}>
        <Input type="password" value={String(value.token ?? "")} onChange={(e) => onChange({ ...value, token: e.target.value.trim() })} autoComplete="off" />
      </Field>
      <p className="soft" style={{ fontSize: 11 }}>{t("settings.info")}</p>
    </div>
  );
}

export default defineClient({
  widgets: { toggle: ToggleWidget, sensor: SensorWidget, climate: ClimateWidget, scenes: ScenesWidget, group: GroupWidget },
  pages: { entities: EntitiesPage },
  settings: HaSettings,
});
