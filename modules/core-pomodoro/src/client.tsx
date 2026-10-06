import { useEffect, useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleEvents, useModuleQuery, useT, type WidgetProps } from "@orbis/sdk/client";
import { Button, Icon } from "@orbis/ui";
import type { TimerState } from "./server";

type Config = { focusMinutes?: number; breakMinutes?: number; longBreakMinutes?: number; roundsBeforeLong?: number; showRounds?: boolean };

/** dark ink on the pink accent: 4.6:1 light / 6.1:1 dark theme (white on it was 2.8:1 / 2.1:1) */
const INK_ON_ACCENT = "#3b2c3a";

function TimerWidget({ config, size }: WidgetProps<Config>) {
  const api = useModuleApi();
  const t = useT();
  const { timezone } = useModule();
  const q = useModuleQuery<TimerState>("/state", { intervalMs: 60_000 });
  const [st, setSt] = useState<TimerState | undefined>();
  useEffect(() => setSt(q.data), [q.data]);
  useModuleEvents("timer", (p) => setSt(p as TimerState));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!st?.running) return;
    const iv = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(iv);
  }, [st?.running]);
  const [label, setLabel] = useState("");
  if (!st) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("common.loading")}</span>;

  const left = st.running && st.endsAt ? Math.max(0, new Date(st.endsAt).getTime() - Date.now()) : st.remainingMs;
  const m = Math.floor(left / 60_000), s = Math.floor((left % 60_000) / 1000);
  const pct = st.totalMs ? ((st.totalMs - left) / st.totalMs) * 100 : 0;
  // the default 3×3 widget is short: smaller digits and tighter gaps so the "focused today" line is never clipped
  const compact = size.height < 200;
  const big = Math.max(22, Math.min(size.height * (compact ? 0.26 : 0.4), size.width / 4));
  const { focusMinutes, breakMinutes, longBreakMinutes, roundsBeforeLong } = config;
  const call = (path: string, extra?: Record<string, unknown>) => api(path, { method: "POST", json: { config: { focusMinutes, breakMinutes, longBreakMinutes, roundsBeforeLong }, tz: timezone, ...extra } }).then((r) => setSt(r as TimerState));
  const rounds = config.roundsBeforeLong ?? 4;
  const focus = st.mode === "focus";
  const fresh = !st.running && left === st.totalMs;
  const labelVisible = fresh && size.height > 160;
  const roundsDone = st.round > 0 && st.round % rounds === 0 ? rounds : st.round % rounds;

  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: compact ? 3 : 6, textAlign: "center", overflow: "hidden" }}>
      <div className="pixel" style={{ fontSize: 12, color: focus ? "var(--accent-ink)" : "var(--accent-2)", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{focus ? t("widget.timer.focus") : st.mode === "long" ? t("widget.timer.longBreak") : t("widget.timer.break")}{st.label ? ` · ${st.label}` : ""}</div>
      <div className="pixel" style={{ fontSize: big, lineHeight: 1, fontVariantNumeric: "tabular-nums", color: left === 0 ? "var(--ok)" : undefined }}>{m}:{String(s).padStart(2, "0")}</div>
      <div className="progress" style={{ width: "80%", height: 6 }}><i style={{ width: `${pct}%`, background: focus ? "var(--accent)" : "var(--accent-2)", transition: "width 0.5s linear" }} /></div>
      {config.showRounds !== false ? (
        <div style={{ display: "flex", gap: 4 }} title={t("widget.timer.rounds", { done: roundsDone, total: rounds })}>
          {Array.from({ length: rounds }, (_, i) => <i key={i} style={{ width: 8, height: 8, border: "1.5px solid var(--line)", background: i < roundsDone ? "var(--accent)" : "transparent", display: "inline-block" }} />)}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        {st.running ? (
          <Button onClick={() => call("/pause")}><Icon name="pause" size={14} /> {t("widget.timer.pause")}</Button>
        ) : (
          <Button variant="primary" style={{ color: INK_ON_ACCENT }} onClick={() => call("/start", labelVisible ? { label } : {})}><Icon name="play" size={14} /> {fresh ? t("widget.timer.start") : t("widget.timer.resume")}</Button>
        )}
        <Button icon size="sm" variant="ghost" onClick={() => call("/skip")} aria-label={t("widget.timer.skipBlock")} title={t("widget.timer.skip")}><Icon name="forward" size={14} /></Button>
        <Button icon size="sm" variant="ghost" onClick={() => call("/reset")} aria-label={t("widget.timer.reset")} title={t("widget.timer.reset")}><Icon name="reload" size={14} /></Button>
      </div>
      {labelVisible ? (
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder={t("widget.timer.labelPlaceholder")} style={{ maxWidth: 220, padding: "3px 6px", fontSize: "var(--fs-meta)", textAlign: "center" }} />
      ) : null}
      <div className="soft" style={{ fontSize: "var(--fs-meta)", flexShrink: 0 }}>{t("widget.timer.focusedToday", { count: st.todayFocusMinutes })}</div>
    </div>
  );
}

export default defineClient({ widgets: { timer: TimerWidget } });
