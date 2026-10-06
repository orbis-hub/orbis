import { useEffect, useState } from "react";
import { defineClient, useModule, useModuleEvents, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Chip, Icon, Window } from "@orbis/ui";
import type { Stats } from "./server";

/** locale-aware size / uptime formatters */
function useFmt() {
  const t = useT();
  const { locale } = useModule();
  const num = (v: number, digits: number) => v.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return {
    t,
    gb: (b: number) => t("unit.gb", { value: num(b / 1024 / 1024 / 1024, 1) }),
    mb: (b: number) => t("unit.mb", { value: Math.round(b / 1024 / 1024) }),
    up: (sec: number) => (sec > 86400 ? t("time.dh", { d: Math.floor(sec / 86400), h: Math.floor((sec % 86400) / 3600) }) : sec > 3600 ? t("time.hm", { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) }) : t("time.m", { m: Math.floor(sec / 60) })),
    load: (v: number) => num(v, 2),
  };
}

function useStats() {
  const q = useModuleQuery<Stats>("/stats", { intervalMs: 30_000 });
  const [live, setLive] = useState<Stats | undefined>();
  useModuleEvents("stats", (p) => setLive(p as Stats));
  return live ?? q.data;
}

function Bar({ value, tone }: { value: number; tone?: string }) {
  return (
    <div className="progress" style={{ height: 6 }}>
      <i style={{ width: `${Math.min(100, value)}%`, background: tone ?? (value > 90 ? "var(--dnd)" : value > 70 ? "var(--idle)" : "var(--accent)") }} />
    </div>
  );
}

function Metric({ label, value, pct, sub }: { label: string; value: string; pct?: number | null; sub?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span className="soft">{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
      </div>
      {pct !== undefined && pct !== null ? <Bar value={pct} /> : null}
      {sub ? <div className="soft" style={{ fontSize: 10 }}>{sub}</div> : null}
    </div>
  );
}

function OverviewWidget({ config }: WidgetProps<{ showModules?: boolean }>) {
  const s = useStats();
  const { t, gb, mb, up, load } = useFmt();
  if (!s) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 8 }}>
      <Metric label={t("metric.cpu")} value={`${s.cpuPercent}%`} pct={s.cpuPercent} sub={`${t("sub.cores", { count: s.cores })}${s.load ? ` · ${t("sub.load", { load: load(s.load[0]) })}` : ""}${s.tempC !== null ? ` · ${s.tempC}°C` : ""}`} />
      <Metric label={t("metric.memory")} value={`${s.memPercent}%`} pct={s.memPercent} sub={`${t("sub.of", { used: gb(s.memUsed), total: gb(s.memTotal) })} · ${t("sub.hub", { size: mb(s.processRss) })}`} />
      {s.diskPercent !== null ? <Metric label={t("metric.disk")} value={`${s.diskPercent}%`} pct={s.diskPercent} sub={t("sub.of", { used: gb(s.diskUsed ?? 0), total: gb(s.diskTotal ?? 0) })} /> : null}
      <div className="soft" style={{ fontSize: 11, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span>{t("sub.up", { uptime: up(s.uptimeSec) })}</span>
        {config.showModules !== false ? <span>· {t("sub.modules", { count: s.modules })}</span> : null}
        {s.dbBytes ? <span>· {t("sub.db", { size: mb(s.dbBytes) })}</span> : null}
      </div>
    </div>
  );
}

function GaugeWidget({ config, size }: WidgetProps<{ metric?: string }>) {
  const s = useStats();
  const { t, up, load } = useFmt();
  if (!s) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  const m = config.metric ?? "cpu";
  const map: Record<string, { label: string; value: string; pct: number | null; icon: string }> = {
    cpu: { label: t("metric.cpu"), value: `${s.cpuPercent}%`, pct: s.cpuPercent, icon: "cpu" },
    memory: { label: t("metric.memory"), value: `${s.memPercent}%`, pct: s.memPercent, icon: "chip" },
    disk: { label: t("metric.disk"), value: s.diskPercent !== null ? `${s.diskPercent}%` : "–", pct: s.diskPercent, icon: "hdd" },
    uptime: { label: t("metric.uptime"), value: up(s.uptimeSec), pct: null, icon: "clock" },
    temperature: { label: t("metric.cpuTemp"), value: s.tempC !== null ? `${s.tempC}°C` : t("common.na"), pct: s.tempC !== null ? Math.min(100, s.tempC) : null, icon: "thermometer" },
    load: { label: t("metric.load1m"), value: s.load ? load(s.load[0]) : t("common.na"), pct: s.load ? Math.min(100, (s.load[0] / s.cores) * 100) : null, icon: "zap" },
  };
  const g = map[m] ?? map.cpu!;
  const big = Math.max(20, Math.min(size.height * 0.4, size.width / Math.max(3, g.value.length * 0.7)));
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 6 }}>
      <div className="soft" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name={g.icon} size={12} /> {g.label}
      </div>
      <div className="pixel" style={{ fontSize: big, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{g.value}</div>
      {g.pct !== null ? <Bar value={g.pct} /> : null}
    </div>
  );
}

function StatusPage(_p: PageProps) {
  const s = useStats();
  const { t, gb, mb, up, load } = useFmt();
  const hist = useModuleQuery<Array<{ t: string; cpu: number; mem: number }>>("/history", { intervalMs: 15_000 });
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(iv);
  }, []);
  if (!s) return <span className="soft pixel">{t("common.loading")}</span>;
  const pts = hist.data ?? [];
  const W = 600, H = 80;
  const path = (key: "cpu" | "mem", color: string) =>
    pts.length > 1 ? (
      <g fill={color}>
        {pts.map((p, i) => (
          <rect key={i} x={Math.round((i / (pts.length - 1)) * (W - 2))} y={Math.round(H - 2 - (p[key] / 100) * (H - 4))} width={2} height={2} />
        ))}
      </g>
    ) : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, alignItems: "start" }}>
      <Window title={t("page.status.thisHub")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <Chip>{s.hostname}</Chip><Chip>{s.platform} {s.arch}</Chip><Chip>node {s.node}</Chip><Chip>orbis {s.hubVersion}</Chip>
          </div>
          <Metric label={t("metric.cpu")} value={`${s.cpuPercent}%`} pct={s.cpuPercent} sub={`${t("sub.cores", { count: s.cores })}${s.load ? ` · ${t("sub.load", { load: s.load.map(load).join(" / ") })}` : ""}${s.tempC !== null ? ` · ${s.tempC}°C` : ""}`} />
          <Metric label={t("metric.memory")} value={`${s.memPercent}%`} pct={s.memPercent} sub={`${t("sub.of", { used: gb(s.memUsed), total: gb(s.memTotal) })} · ${t("sub.hubProcess", { size: mb(s.processRss) })}`} />
          {s.diskPercent !== null ? <Metric label={t("metric.diskDataDir")} value={`${s.diskPercent}%`} pct={s.diskPercent} sub={t("sub.of", { used: gb(s.diskUsed ?? 0), total: gb(s.diskTotal ?? 0) })} /> : null}
          <div className="soft" style={{ fontSize: 12 }}>{t("page.status.systemUp", { system: up(s.uptimeSec), hub: up(s.processUptimeSec) })} · {t("page.status.modulesLoaded", { count: s.modules })}{s.dbBytes ? ` · ${t("page.status.database", { size: mb(s.dbBytes) })}` : ""}</div>
        </div>
      </Window>
      <Window title={t("page.status.last30")}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} shapeRendering="crispEdges" style={{ display: "block", border: "1.5px solid var(--line)", background: "var(--paper-2)" }}>
          {path("mem", "var(--accent-2)")}
          {path("cpu", "var(--accent)")}
        </svg>
        <div className="soft" style={{ fontSize: 11, marginTop: 6, display: "flex", gap: 12 }}>
          <span><i className="status-dot" style={{ background: "var(--accent)", borderWidth: 0, width: 8, height: 8 }} /> {t("metric.cpu")}</span>
          <span><i className="status-dot" style={{ background: "var(--accent-2)", borderWidth: 0, width: 8, height: 8 }} /> {t("metric.memory")}</span>
          <span style={{ marginLeft: "auto" }}>{t("page.status.sampled")}</span>
        </div>
      </Window>
    </div>
  );
}

export default defineClient({
  widgets: { overview: OverviewWidget, gauge: GaugeWidget },
  pages: { status: StatusPage },
});
