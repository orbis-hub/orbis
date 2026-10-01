"use client";

import type { Device } from "@orbis/sdk";
import { Button, Chip, Empty, Icon, Input, Menu, Select, useToast, Window } from "@orbis/ui";
import { useState } from "react";
import { Shell } from "@/components/Shell";
import { useDeviceMutations, useDevices, useModules } from "@/lib/queries";

export default function DevicesPage() {
  const devices = useDevices();
  const modules = useModules();
  const m = useDeviceMutations();
  const toast = useToast();
  const [ip, setIp] = useState("");
  const [label, setLabel] = useState("");
  const [filter, setFilter] = useState("");

  const list = (devices.data ?? []).filter((d) => !filter || `${d.ip} ${d.hostname ?? ""} ${d.vendor ?? ""} ${d.label ?? ""} ${d.mac ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const claimable = (modules.data ?? []).filter((x) => x.enabled && (x.manifest.permissions.includes("devices:claim") || x.manifest.discovery));

  return (
    <Shell
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon name="wifi" size={16} style={{ color: "var(--accent)" }} /> devices
        </span>
      }
      actions={
        <Button size="sm" loading={m.scan.isPending} onClick={() => m.scan.mutate(undefined, { onError: (e) => toast(`scan: ${e.message}`, "bad"), onSuccess: () => toast("scan started", "ok") })}>
          <Icon name="search" size={14} /> scan network
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Input placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 260 }} />
          <span className="soft" style={{ fontSize: 11 }}>
            {list.length} device{list.length === 1 ? "" : "s"} · {list.filter((d) => d.online).length} online
          </span>
        </div>
        {devices.isPending ? null : list.length === 0 ? (
          <Empty icon="wifi" title="no devices yet">
            run a network scan (the hub needs to be on the same network, in docker use <code>network_mode: host</code>) or add a device by ip below.
          </Empty>
        ) : (
          <Window tight>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr className="pixel" style={{ fontSize: 11, color: "var(--ink-soft)", textAlign: "left" }}>
                  <th style={th}></th>
                  <th style={th}>device</th>
                  <th style={th}>ip</th>
                  <th style={{ ...th, display: "var(--col-wide, table-cell)" }}>mac / vendor</th>
                  <th style={{ ...th, display: "var(--col-wide, table-cell)" }}>services</th>
                  <th style={th}>module</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <DeviceRow key={d.id} d={d} claimable={claimable.map((x) => ({ id: x.id, name: x.manifest.name }))} />
                ))}
              </tbody>
            </table>
            <style>{`@media (max-width: 760px) { table { --col-wide: none; } }`}</style>
          </Window>
        )}
        <Window title="add device manually" dashed>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              m.add.mutate(
                { ip: ip.trim(), label: label.trim() || undefined },
                {
                  onSuccess: () => {
                    setIp("");
                    setLabel("");
                  },
                  onError: (err) => toast(err.message, "bad"),
                },
              );
            }}
            style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            <Input placeholder="192.168.1.50" value={ip} onChange={(e) => setIp(e.target.value)} style={{ maxWidth: 180 }} required />
            <Input placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 220 }} />
            <Button type="submit" loading={m.add.isPending}>
              <Icon name="plus" size={12} /> add
            </Button>
          </form>
        </Window>
      </div>
    </Shell>
  );
}

const th: React.CSSProperties = { padding: "6px 10px", borderBottom: "1.5px solid var(--line)", background: "var(--paper-2)", fontWeight: 400 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px dashed var(--line)", verticalAlign: "top" };

function DeviceRow({ d, claimable }: { d: Device; claimable: Array<{ id: string; name: string }> }) {
  const m = useDeviceMutations();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(d.label ?? "");
  const name = d.label || d.hostname || d.vendor || d.ip;
  return (
    <tr>
      <td style={{ ...td, width: 20 }}>
        <i className="status-dot" title={d.online ? "online" : "offline"} style={{ background: d.online ? "var(--ok)" : "var(--off)" }} />
      </td>
      <td style={td}>
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              m.update.mutate({ id: d.id, label: label.trim() || null }, { onSuccess: () => setEditing(false), onError: (err) => toast(err.message, "bad") });
            }}
            style={{ display: "flex", gap: 4 }}
          >
            <Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus style={{ padding: "2px 6px" }} />
            <Button size="sm" type="submit">
              ok
            </Button>
          </form>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>{name}</span>
              <button type="button" className="soft" onClick={() => setEditing(true)} aria-label="rename" style={{ display: "inline-flex" }}>
                <Icon name="edit" size={11} />
              </button>
            </div>
            {d.hostname && d.label ? <div className="soft" style={{ fontSize: 11 }}>{d.hostname}</div> : null}
          </div>
        )}
      </td>
      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{d.ip}</td>
      <td style={{ ...td, display: "var(--col-wide, table-cell)" }}>
        <div style={{ fontSize: 11 }}>{d.mac ?? "—"}</div>
        <div className="soft" style={{ fontSize: 11 }}>{d.vendor ?? ""}</div>
      </td>
      <td style={{ ...td, display: "var(--col-wide, table-cell)" }}>
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {d.services.slice(0, 4).map((s, i) => (
            <Chip key={i} title={`${s.kind} ${s.name}${s.port ? `:${s.port}` : ""}`} style={{ fontSize: 10 }}>
              {s.name.replace(/^_/, "").replace(/\._tcp.*$/, "")}
            </Chip>
          ))}
          {d.services.length > 4 ? <Chip style={{ fontSize: 10 }}>+{d.services.length - 4}</Chip> : null}
        </div>
      </td>
      <td style={td}>
        <Select value={d.claimedBy ?? ""} onChange={(e) => m.update.mutate({ id: d.id, claimedBy: e.target.value || null }, { onError: (err) => toast(err.message, "bad") })} style={{ padding: "2px 24px 2px 6px", fontSize: 11, minWidth: 110 }}>
          <option value="">— unassigned —</option>
          {claimable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          {d.claimedBy && !claimable.some((c) => c.id === d.claimedBy) ? <option value={d.claimedBy}>{d.claimedBy}</option> : null}
        </Select>
      </td>
      <td style={{ ...td, width: 30 }}>
        <Menu
          trigger={
            <Button icon size="sm" variant="ghost" aria-label="device menu">
              <Icon name="more-vertical" size={12} />
            </Button>
          }
          items={[
            { label: `last seen ${new Date(d.lastSeen).toLocaleString()}`, disabled: true },
            { sep: true, label: "" },
            { label: "forget device", icon: "trash", danger: true, onSelect: () => m.remove.mutate(d.id, { onError: (err) => toast(err.message, "bad") }) },
          ]}
        />
      </td>
    </tr>
  );
}
