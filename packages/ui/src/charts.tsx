import type { ReactNode } from "react";

export type BarSeries = { values: number[]; color?: string; label?: string; dashed?: boolean };
export type BarsProps = {
  /** one or more series of the same length, drawn side by side per column */
  series: BarSeries[];
  /** x labels, one per column */
  labels?: string[];
  height?: number;
  /** format a value for the title tooltip and the optional value row */
  format?: (v: number) => string;
  /** show the formatted value of the first series above each column */
  showValues?: boolean;
  /** highlight one column (e.g. today) */
  highlight?: number;
  max?: number;
  className?: string;
  /** rendered under the chart, e.g. a legend */
  footer?: ReactNode;
};

/**
 * Pixel bar chart in the orbis style: hard borders, no antialiasing tricks, one color per series.
 * Good enough for "this week vs last week"; not a charting library.
 */
export function Bars({ series, labels, height = 80, format = (v) => String(Math.round(v)), showValues, highlight, max, className, footer }: BarsProps) {
  const n = Math.max(...series.map((s) => s.values.length), labels?.length ?? 0);
  const top = max ?? Math.max(1, ...series.flatMap((s) => s.values));
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height }}>
        {Array.from({ length: n }, (_, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2, height: "100%", justifyContent: "flex-end" }}>
            {showValues ? <span className="soft" style={{ fontSize: 9, textAlign: "center", lineHeight: 1 }}>{series[0] && series[0].values[i] ? format(series[0].values[i]!) : ""}</span> : null}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 1, flex: 1, minHeight: 0 }}>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                const h = v <= 0 ? 0 : Math.max(2, Math.round((v / top) * 100));
                return (
                  <div
                    key={si}
                    title={`${labels?.[i] ?? i}${s.label ? ` · ${s.label}` : ""}: ${format(v)}`}
                    style={{
                      flex: 1,
                      height: `${h}%`,
                      background: v <= 0 ? "transparent" : (s.color ?? (si === 0 ? "var(--accent)" : "var(--paper-2)")),
                      border: v <= 0 ? "none" : `1.5px ${s.dashed ? "dashed" : "solid"} var(--line)`,
                      boxShadow: v > 0 && highlight === i && si === 0 ? "2px 2px 0 var(--line)" : undefined,
                      transition: "height .2s steps(4)",
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {labels ? (
        <div style={{ display: "flex", gap: 4 }}>
          {labels.map((l, i) => (
            <span key={i} className="pixel" style={{ flex: 1, textAlign: "center", fontSize: 9, color: highlight === i ? "var(--accent)" : "var(--ink-soft, inherit)", opacity: highlight === i ? 1 : 0.7 }}>{l}</span>
          ))}
        </div>
      ) : null}
      {footer}
    </div>
  );
}

/** inline legend to pair with <Bars> */
export function BarsLegend({ series }: { series: Array<Pick<BarSeries, "label" | "color" | "dashed">> }) {
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 10 }} className="soft">
      {series.map((s, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <i style={{ width: 8, height: 8, display: "inline-block", background: s.color ?? (i === 0 ? "var(--accent)" : "var(--paper-2)"), border: `1.5px ${s.dashed ? "dashed" : "solid"} var(--line)` }} />
          {s.label ?? `series ${i + 1}`}
        </span>
      ))}
    </div>
  );
}

/** tiny sparkline, same idea: a row of thin columns without labels */
export function Sparkline({ values, height = 24, color }: { values: number[]; height?: number; color?: string }) {
  const top = Math.max(1, ...values);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height }}>
      {values.map((v, i) => <div key={i} style={{ flex: 1, height: `${Math.max(v > 0 ? 8 : 0, Math.round((v / top) * 100))}%`, background: color ?? "var(--accent)" }} />)}
    </div>
  );
}
