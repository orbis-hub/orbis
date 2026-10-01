import { useEffect, useState } from "react";
import { defineClient, useModuleApi, useModuleEvents, useModuleQuery, type WidgetProps } from "@orbis/sdk/client";
import { Button, Icon } from "@orbis/ui";
import type { TimerState } from "./server";

type Config = { focusMinutes?: number; breakMinutes?: number; longBreakMinutes?: number; roundsBeforeLong?: number; showRounds?: boolean };

function TimerWidget({ config, size }: WidgetProps<Config>) {
  const api = useModuleApi();
  const q = useModuleQuery<TimerState>("/state", { intervalMs: 60_000 });
  const [st, setSt] = useState<TimerState | undefined>();
  useEffect(() => setSt(q.data), [q.data]);
  useModuleEvents("timer", (p) => setSt(p as TimerState));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!st?.running) return;
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [st?.running]);
  const [label, setLabel] = useState("");
  if (!st) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;

  const left = st.running && st.endsAt ? Math.max(0, new Date(st.endsAt).getTime() - Date.now()) : st.remainingMs;
  const m = Math.floor(left / 60_000), s = Math.floor((left % 60_000) / 1000);
  const pct = st.totalMs ? ((st.totalMs - left) / st.totalMs) * 100 : 0;
  const big = Math.max(28, Math.min(size.height * 0.4, size.width / 4));
  const call = (path: string, extra?: Record<string, unknown>) => api(path, { method: "POST", json: { config, ...extra } }).then((r) => setSt(r as TimerState));
  const rounds = config.roundsBeforeLong ?? 4;
  const focus = st.mode === "focus";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, textAlign: "center" }}>
      <div className="pixel" style={{ fontSize: 12, color: focus ? "var(--accent)" : "var(--accent-2)" }}>{focus ? "focus" : st.mode === "long" ? "long break" : "break"}{st.label ? ` · ${st.label}` : ""}</div>
      <div className="pixel" style={{ fontSize: big, lineHeight: 1, fontVariantNumeric: "tabular-nums", color: left === 0 ? "var(--ok)" : undefined }}>{m}:{String(s).padStart(2, "0")}</div>
      <div className="progress" style={{ width: "80%", height: 6 }}><i style={{ width: `${pct}%`, background: focus ? "var(--accent)" : "var(--accent-2)", transition: "width 0.5s linear" }} /></div>
      {config.showRounds !== false ? (
        <div style={{ display: "flex", gap: 4 }} title={`${st.round % rounds} of ${rounds} rounds`}>
          {Array.from({ length: rounds }, (_, i) => <i key={i} style={{ width: 8, height: 8, border: "1.5px solid var(--line)", background: i < st.round % rounds || (st.round > 0 && st.round % rounds === 0) ? "var(--accent)" : "transparent", display: "inline-block" }} />)}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        {st.running ? (
          <Button onClick={() => call("/pause")}><Icon name="pause" size={14} /> pause</Button>
        ) : (
          <Button variant="primary" onClick={() => call("/start", { label })}><Icon name="play" size={14} /> {left === st.totalMs ? "start" : "resume"}</Button>
        )}
        <Button icon size="sm" variant="ghost" onClick={() => call("/skip")} aria-label="skip block" title="skip"><Icon name="forward" size={14} /></Button>
        <Button icon size="sm" variant="ghost" onClick={() => call("/reset")} aria-label="reset" title="reset"><Icon name="reload" size={14} /></Button>
      </div>
      {!st.running && left === st.totalMs && size.height > 160 ? (
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="what are you working on?" style={{ maxWidth: 220, padding: "3px 6px", fontSize: 11, textAlign: "center" }} />
      ) : null}
      <div className="soft" style={{ fontSize: 10 }}>{st.todayFocusMinutes} min focused today</div>
    </div>
  );
}

export default defineClient({ widgets: { timer: TimerWidget } });
