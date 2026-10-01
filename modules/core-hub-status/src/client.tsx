import { useEffect, useState } from "react";
import { defineClient, useModuleEvents, useModuleQuery, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Chip, Icon, Window } from "@orbis/ui";
import type { Stats } from "./server";

const gb = (b: number) => `${(b / 1024 / 1024 / 1024).toFixed(1)} gb`;
const mb = (b: number) => `${Math.round(b / 1024 / 1024)} mb`;
const up = (sec: number) => (sec > 86400 ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h` : sec > 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`);

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
  if (!s) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 8 }}>
      <Metric label="cpu" value={`${s.cpuPercent}%`} pct={s.cpuPercent} sub={`${s.cores} cores · load ${s.load[0].toFixed(2)}${s.tempC !== null ? ` · ${s.tempC}°C` : ""}`} />
      <Metric label="memory" value={`${s.memPercent}%`} pct={s.memPercent} sub={`${gb(s.memUsed)} of ${gb(s.memTotal)} · hub ${mb(s.processRss)}`} />
      {s.diskPercent !== null ? <Metric label="disk" value={`${s.diskPercent}%`} pct={s.diskPercent} sub={`${gb(s.diskUsed ?? 0)} of ${gb(s.diskTotal ?? 0)}`} /> : null}
      <div className="soft" style={{ fontSize: 11, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span>up {up(s.uptimeSec)}</span>
        {config.showModules !== false ? <span>· {s.modules} modules</span> : null}
        {s.dbBytes ? <span>· db {mb(s.dbBytes)}</span> : null}
      </div>
    </div>
  );
}

function GaugeWidget({ config, size }: WidgetProps<{ metric?: string }>) {
  const s = useStats();
  if (!s) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  const m = config.metric ?? "cpu";
  const map: Record<string, { label: string; value: string; pct: number | null; icon: string }> = {
    cpu: { label: "cpu", value: `${s.cpuPercent}%`, pct: s.cpuPercent, icon: "cpu" },
    memory: { label: "memory", value: `${s.memPercent}%`, pct: s.memPercent, icon: "chip" },
    disk: { label: "disk", value: s.diskPercent !== null ? `${s.diskPercent}%` : "–", pct: s.diskPercent, icon: "hdd" },
    uptime: { label: "uptime", value: up(s.uptimeSec), pct: null, icon: "clock" },
    temperature: { label: "cpu temp", value: s.tempC !== null ? `${s.tempC}°C` : "n/a", pct: s.tempC !== null ? Math.min(100, s.tempC) : null, icon: "thermometer" },
    load: { label: "load 1m", value: s.load[0].toFixed(2), pct: Math.min(100, (s.load[0] / s.cores) * 100), icon: "zap" },
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
  const hist = useModuleQuery<Array<{ t: string; cpu: number; mem: number }>>("/history", { intervalMs: 15_000 });
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!s) return <span className="soft pixel">loading…</span>;
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
      <Window title="this hub">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <Chip>{s.hostname}</Chip><Chip>{s.platform} {s.arch}</Chip><Chip>node {s.node}</Chip><Chip>orbis {s.hubVersion}</Chip>
          </div>
          <Metric label="cpu" value={`${s.cpuPercent}%`} pct={s.cpuPercent} sub={`${s.cores} cores · load ${s.load.map((x) => x.toFixed(2)).join(" / ")}${s.tempC !== null ? ` · ${s.tempC}°C` : ""}`} />
          <Metric label="memory" value={`${s.memPercent}%`} pct={s.memPercent} sub={`${gb(s.memUsed)} of ${gb(s.memTotal)} · hub process ${mb(s.processRss)}`} />
          {s.diskPercent !== null ? <Metric label="disk (data dir)" value={`${s.diskPercent}%`} pct={s.diskPercent} sub={`${gb(s.diskUsed ?? 0)} of ${gb(s.diskTotal ?? 0)}`} /> : null}
          <div className="soft" style={{ fontSize: 12 }}>system up {up(s.uptimeSec)} · hub up {up(s.processUptimeSec)} · {s.modules} modules loaded{s.dbBytes ? ` · database ${mb(s.dbBytes)}` : ""}</div>
        </div>
      </Window>
      <Window title="last 30 minutes">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} shapeRendering="crispEdges" style={{ display: "block", border: "1.5px solid var(--line)", background: "var(--paper-2)" }}>
          {path("mem", "var(--accent-2)")}
          {path("cpu", "var(--accent)")}
        </svg>
        <div className="soft" style={{ fontSize: 11, marginTop: 6, display: "flex", gap: 12 }}>
          <span><i className="status-dot" style={{ background: "var(--accent)", borderWidth: 0, width: 8, height: 8 }} /> cpu</span>
          <span><i className="status-dot" style={{ background: "var(--accent-2)", borderWidth: 0, width: 8, height: 8 }} /> memory</span>
          <span style={{ marginLeft: "auto" }}>sampled every 5 s</span>
        </div>
      </Window>
    </div>
  );
}

export default defineClient({
  widgets: { overview: OverviewWidget, gauge: GaugeWidget },
  pages: { status: StatusPage },
});
