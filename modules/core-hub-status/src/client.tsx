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

/** height of one `.soft` line at --fs-meta (12px × 1.4) */
const LINE = 17;
/** label/value line + bar of one metric row (without its sub line) */
const ROW_H = LINE + 3 + 6;

function Metric({ label, value, pct, sub, showSub = true }: { label: string; value: string; pct?: number | null; sub?: string; showSub?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }} title={showSub ? undefined : sub}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, minWidth: 0 }}>
        <span className="soft" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", flex: "none" }}>{value}</span>
      </div>
      {pct !== undefined && pct !== null ? <Bar value={pct} /> : null}
      {sub && showSub ? <div className="soft" style={{ fontSize: "var(--fs-meta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={sub}>{sub}</div> : null}
    </div>
  );
}

function OverviewWidget({ config, size }: WidgetProps<{ showModules?: boolean }>) {
  const s = useStats();
  const { t, gb, mb, up, load } = useFmt();
  if (!s) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;
  const rows = [
    { label: t("metric.cpu"), value: `${s.cpuPercent}%`, pct: s.cpuPercent, sub: `${t("sub.cores", { count: s.cores })}${s.load ? ` · ${t("sub.load", { load: load(s.load[0]) })}` : ""}${s.tempC !== null ? ` · ${s.tempC}°C` : ""}` },
    { label: t("metric.memory"), value: `${s.memPercent}%`, pct: s.memPercent, sub: `${t("sub.of", { used: gb(s.memUsed), total: gb(s.memTotal) })} · ${t("sub.hub", { size: mb(s.processRss) })}` },
    ...(s.diskPercent !== null ? [{ label: t("metric.disk"), value: `${s.diskPercent}%`, pct: s.diskPercent, sub: t("sub.of", { used: gb(s.diskUsed ?? 0), total: gb(s.diskTotal ?? 0) }) }] : []),
  ];
  // size is 0×0 until the frame has measured itself; until then assume the 3×3 default (≈140px high)
  const h = size.height > 0 ? size.height : 140;
  // the sub lines ("12 cores · load 0.00", "3.1 gb of 16 gb") only when every row fits with them (a 4-row widget);
  // below that they move into the row's tooltip, and rows that still do not fit are dropped from the bottom
  const showSub = h >= rows.length * (ROW_H + 3 + LINE) + 8 * rows.length + LINE;
  const gap = showSub ? 8 : 6;
  const shown = showSub ? rows : rows.slice(0, Math.max(1, Math.floor((h + gap) / (ROW_H + gap))));
  const rowsH = shown.length * (showSub ? ROW_H + 3 + LINE : ROW_H) + (shown.length - 1) * gap;
  const showUptime = h - rowsH - gap >= LINE;
  const footer = [t("sub.up", { uptime: up(s.uptimeSec) }), ...(config.showModules !== false ? [t("sub.modules", { count: s.modules })] : []), ...(s.dbBytes ? [t("sub.db", { size: mb(s.dbBytes) })] : [])].join(" · ");
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap, minWidth: 0, overflow: "hidden" }} title={showUptime ? undefined : footer}>
      {shown.map((m) => (
        <Metric key={m.label} label={m.label} value={m.value} pct={m.pct} sub={m.sub} showSub={showSub} />
      ))}
      {showUptime ? (
        <div className="soft" style={{ fontSize: "var(--fs-meta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={footer}>
          {footer}
        </div>
      ) : null}
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
  // the number takes what is left under the label line (and above the bar), capped by the width (pixel font ≈ 0.7em per glyph)
  const measured = size.width > 0 && size.height > 0;
  const big = measured ? Math.max(20, Math.min(size.height - LINE - 4 - (g.pct !== null ? 10 : 0), size.width / Math.max(3, g.value.length * 0.7))) : 28;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, minWidth: 0, overflow: "hidden" }}>
      <div className="soft" style={{ fontSize: "var(--fs-meta)", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }} title={g.label}>
        <Icon name={g.icon} size={12} style={{ flex: "none" }} /> <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.label}</span>
      </div>
      <div className="pixel" style={{ fontSize: big, lineHeight: 1, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden" }}>{g.value}</div>
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
        <div className="soft" style={{ fontSize: "var(--fs-meta)", marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
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
