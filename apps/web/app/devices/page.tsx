"use client";

import type { Device } from "@orbis/sdk";
import { Button, Chip, Empty, Icon, Input, Menu, Select, useToast, Window } from "@orbis/ui";
import { useState } from "react";
import { Shell } from "@/components/Shell";
import { useT } from "@/lib/i18n";
import { useDeviceMutations, useDevices, useModules } from "@/lib/queries";

export default function DevicesPage() {
  const t = useT();
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
          <Icon name="wifi" size={16} style={{ color: "var(--accent-ink)" }} /> {t("devices.title")}
        </span>
      }
      actions={
        <Button size="sm" loading={m.scan.isPending} onClick={() => m.scan.mutate(undefined, { onError: (e) => toast(t("devices.scanError", { error: e.message }), "bad"), onSuccess: () => toast(t("devices.scanStarted"), "ok") })}>
          <Icon name="search" size={14} /> {t("devices.scan")}
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Input type="search" placeholder={t("devices.filter")} aria-label={t("devices.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 260 }} />
          <span className="soft" style={{ fontSize: "var(--fs-meta)" }}>
            {t("devices.count", { count: list.length })} · {t("devices.onlineCount", { count: list.filter((d) => d.online).length })}
          </span>
        </div>
        {devices.isPending ? null : list.length === 0 ? (
          <Empty icon="wifi" title={t("devices.empty.title")}>
            {t("devices.empty.before")} <code>network_mode: host</code>{t("devices.empty.after")}
          </Empty>
        ) : (
          <Window tight>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr className="pixel" style={{ fontSize: "var(--fs-meta)", color: "var(--ink-soft)", textAlign: "left" }}>
                  <th style={th}></th>
                  <th style={th}>{t("devices.col.device")}</th>
                  <th style={th}>{t("devices.col.ip")}</th>
                  <th style={{ ...th, display: "var(--col-wide, table-cell)" }}>{t("devices.col.macVendor")}</th>
                  <th style={{ ...th, display: "var(--col-wide, table-cell)" }}>{t("devices.col.services")}</th>
                  <th style={th}>{t("devices.col.module")}</th>
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
        <Window title={t("devices.addManually")} dashed>
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
            <Input placeholder="192.168.1.50" aria-label={t("devices.col.ip")} inputMode="decimal" value={ip} onChange={(e) => setIp(e.target.value)} style={{ maxWidth: 180 }} required />
            <Input placeholder={t("devices.labelPlaceholder")} aria-label={t("devices.labelPlaceholder")} value={label} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 220 }} />
            <Button type="submit" loading={m.add.isPending}>
              <Icon name="plus" size={12} /> {t("common.add")}
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
  const t = useT();
  const m = useDeviceMutations();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(d.label ?? "");
  const name = d.label || d.hostname || d.vendor || d.ip;
  return (
    <tr>
      <td style={{ ...td, width: 20 }}>
        <i className="status-dot" role="img" aria-label={d.online ? t("devices.online") : t("devices.offline")} title={d.online ? t("devices.online") : t("devices.offline")} style={{ background: d.online ? "var(--ok)" : "var(--off)" }} />
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
            <Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus aria-label={t("common.rename")} style={{ padding: "2px 6px" }} />
            <Button size="sm" type="submit">
              {t("common.ok")}
            </Button>
          </form>
        ) : (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>{name}</span>
              <button type="button" className="soft" onClick={() => setEditing(true)} aria-label={t("common.rename")} style={{ display: "inline-flex" }}>
                <Icon name="edit" size={11} />
              </button>
            </div>
            {d.hostname && d.label ? <div className="soft" style={{ fontSize: "var(--fs-meta)" }}>{d.hostname}</div> : null}
          </div>
        )}
      </td>
      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{d.ip}</td>
      <td style={{ ...td, display: "var(--col-wide, table-cell)" }}>
        <div style={{ fontSize: "var(--fs-meta)" }}>{d.mac ?? "—"}</div>
        <div className="soft" style={{ fontSize: "var(--fs-meta)" }}>{d.vendor ?? ""}</div>
      </td>
      <td style={{ ...td, display: "var(--col-wide, table-cell)" }}>
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {d.services.slice(0, 4).map((s, i) => (
            <Chip key={i} title={`${s.kind} ${s.name}${s.port ? `:${s.port}` : ""}`} style={{ fontSize: "var(--fs-meta)" }}>
              {s.name.replace(/^_/, "").replace(/\._tcp.*$/, "")}
            </Chip>
          ))}
          {d.services.length > 4 ? <Chip style={{ fontSize: "var(--fs-meta)" }}>+{d.services.length - 4}</Chip> : null}
        </div>
      </td>
      <td style={td}>
        <Select value={d.claimedBy ?? ""} aria-label={`${t("devices.col.module")}: ${name}`} onChange={(e) => m.update.mutate({ id: d.id, claimedBy: e.target.value || null }, { onError: (err) => toast(err.message, "bad") })} style={{ padding: "2px 24px 2px 6px", fontSize: "var(--fs-meta)", minWidth: 110 }}>
          <option value="">{t("devices.unassigned")}</option>
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
            <Button icon size="sm" variant="ghost" aria-label={t("devices.menu")}>
              <Icon name="more-vertical" size={12} />
            </Button>
          }
          items={[
            { label: t("devices.lastSeen", { time: new Date(d.lastSeen).toLocaleString() }), disabled: true },
            { sep: true, label: "" },
            { label: t("devices.forget"), icon: "trash", danger: true, onSelect: () => m.remove.mutate(d.id, { onError: (err) => toast(err.message, "bad") }) },
          ]}
        />
      </td>
    </tr>
  );
}
