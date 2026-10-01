import { useEffect, useState } from "react";
import { defineClient, useModuleApi, useModuleEvents, useModuleQuery, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Icon, Input, Switch, Window } from "@orbis/ui";
import type { Device, ShellyDevice } from "./server";

function useShellys() {
  const q = useModuleQuery<ShellyDevice[]>("/devices", { intervalMs: 30_000 });
  const [live, setLive] = useState<ShellyDevice[] | undefined>();
  useEffect(() => setLive(q.data), [q.data]);
  useModuleEvents("state", (p) => setLive(p as ShellyDevice[]));
  return { list: live ?? q.data ?? [], loading: q.loading && !q.data, refetch: q.refetch };
}

function SwitchWidget({ config, size }: WidgetProps<{ device?: string; channel?: number; name?: string }>) {
  const api = useModuleApi();
  const { list, loading } = useShellys();
  const d = list.find((x) => x.id === config.device);
  const ch = d?.channels.find((c) => c.id === (config.channel ?? 0));
  if (loading) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  if (!config.device) return <Empty icon="plug" title="pick a device">⋯ → configure, ids are on the shelly page.</Empty>;
  if (!d) return <Empty icon="warning-diamond" title="unknown device">{config.device}</Empty>;
  if (!d.online) return <Empty icon="plug" title={`${d.name} offline`}>{d.error}</Empty>;
  if (!ch) return <Empty icon="plug" title="no such channel" />;
  const big = Math.max(24, Math.min(size.height * 0.4, size.width * 0.3));
  return (
    <button type="button" onClick={() => void api("/switch", { method: "POST", json: { device: d.id, channel: ch.id, on: !ch.on } })} aria-pressed={ch.on} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, color: ch.on ? "var(--accent)" : "var(--ink-soft)" }}>
      <Icon name={ch.on ? "power" : "power-off"} size={big} />
      <div className="pixel" style={{ fontSize: 13, color: "var(--ink)" }}>{config.name ?? d.name}{d.channels.length > 1 ? ` · ${ch.id + 1}` : ""}</div>
      <div style={{ fontSize: 11 }}>{ch.on ? "on" : "off"}{ch.power != null ? ` · ${Math.round(ch.power)} W` : ""}</div>
    </button>
  );
}

function PowerWidget() {
  const { list, loading } = useShellys();
  if (loading) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  if (!list.length) return <Empty icon="plug" title="no shellys">assign devices on the shelly page.</Empty>;
  const total = list.reduce((a, d) => a + d.channels.reduce((b, c) => b + (c.power ?? 0), 0), 0);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="pixel" style={{ fontSize: 20 }}>{Math.round(total)} W <span className="soft" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>total</span></div>
      <div className="scroll-y" style={{ flex: 1 }}>
        {list.map((d) => (
          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", borderBottom: "1px dashed var(--line)", fontSize: 12, opacity: d.online ? 1 : 0.5 }}>
            <i className="status-dot" style={{ background: d.online ? (d.channels.some((c) => c.on) ? "var(--accent)" : "var(--ok)") : "var(--off)", borderWidth: 0, width: 8, height: 8 }} />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{d.online ? `${Math.round(d.channels.reduce((a, c) => a + (c.power ?? 0), 0))} W` : "offline"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShellyPage(_p: PageProps) {
  const api = useModuleApi();
  const { list, refetch } = useShellys();
  const sugg = useModuleQuery<Device[]>("/suggested", { refetchOn: ["state"], intervalMs: 30_000 });
  const [ip, setIp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {(sugg.data ?? []).length ? (
        <Window title="found on your network" dashed>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(sugg.data ?? []).map((d) => (
              <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <Icon name="plug" size={14} style={{ color: "var(--accent)" }} />
                <span style={{ flex: 1 }}>{d.hostname ?? d.ip} <span className="soft">{d.ip}{d.vendor ? ` · ${d.vendor}` : ""}</span></span>
                <Button size="sm" onClick={() => api("/claim", { method: "POST", json: { deviceId: d.id } }).then(() => { refetch(); sugg.refetch(); })}>use it</Button>
              </div>
            ))}
          </div>
        </Window>
      ) : null}
      <Window title={`shellys (${list.length})`}>
        {list.length === 0 ? <Empty icon="plug" title="no shellys yet">scan the network under <b>devices</b> (they announce themselves via mdns) or add one by ip below.</Empty> : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {list.map((d) => (
            <div key={d.id} style={{ border: "1.5px solid var(--line)", padding: 10, display: "flex", flexDirection: "column", gap: 6, opacity: d.online ? 1 : 0.6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <i className="status-dot" style={{ background: d.online ? "var(--ok)" : "var(--dnd)", borderWidth: 0, width: 8, height: 8 }} />
                <span className="pixel" style={{ fontSize: 13 }}>{d.name}</span>
                <Chip style={{ fontSize: 10 }}>{d.model ?? "?"}</Chip>
                <Chip style={{ fontSize: 10 }}>gen {d.gen}</Chip>
                <Chip style={{ fontSize: 10 }}>{d.ip}</Chip>
                {d.temperature != null ? <Chip style={{ fontSize: 10 }}>{d.temperature.toFixed(0)}°C</Chip> : null}
                <button type="button" className="soft" style={{ fontSize: 10, fontFamily: "var(--font-mono)", textDecoration: "underline dotted", marginLeft: "auto" }} onClick={() => { void navigator.clipboard?.writeText(d.id); setCopied(d.id); setTimeout(() => setCopied(null), 1200); }}>{copied === d.id ? "copied ✓" : `id: ${d.id}`}</button>
                <Button icon size="sm" variant="ghost" aria-label="remove" onClick={() => api("/release", { method: "POST", json: { deviceId: d.id } }).then(refetch)}><Icon name="close" size={12} /></Button>
              </div>
              {d.error ? <div style={{ color: "var(--dnd)", fontSize: 11 }}>{d.error}</div> : null}
              {d.channels.map((c) => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                  <Switch checked={c.on} disabled={!d.online} onChange={(e) => void api("/switch", { method: "POST", json: { device: d.id, channel: c.id, on: e.target.checked } })} aria-label={`channel ${c.id}`} />
                  <span>channel {c.id}</span>
                  {c.power != null ? <span className="soft">{Math.round(c.power)} W</span> : null}
                  {c.energyWh != null ? <span className="soft">· {(c.energyWh / 1000).toFixed(2)} kWh</span> : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </Window>
      <Window title="add by ip" dashed>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await api("/add-ip", { method: "POST", json: { ip } });
              setIp("");
              refetch();
            } catch (ex) {
              setErr((ex as Error).message);
            }
          }}
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.60" style={{ maxWidth: 200 }} required />
          <Button type="submit" size="sm">add</Button>
          {err ? <span style={{ color: "var(--dnd)", fontSize: 11 }}>{err}</span> : null}
        </form>
      </Window>
    </div>
  );
}

export default defineClient({ widgets: { switch: SwitchWidget, power: PowerWidget }, pages: { shelly: ShellyPage } });
