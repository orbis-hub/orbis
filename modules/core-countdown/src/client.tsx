import { useEffect, useState } from "react";
import { defineClient, useModule, useT, type WidgetProps } from "@orbis/sdk/client";
import { Empty, Icon } from "@orbis/ui";

type Config = { title?: string; date?: string; time?: string; yearly?: boolean; icon?: string; showUnits?: "auto" | "days" | "weeks" | "hours" };

function target(cfg: Config, now: Date): Date | null {
  if (!cfg.date) return null;
  const [y, m, d] = cfg.date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const [hh, mm] = (cfg.time ?? "00:00").split(":").map(Number);
  let t = new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
  if (cfg.yearly) {
    t = new Date(now.getFullYear(), m - 1, d, hh || 0, mm || 0, 0, 0);
    if (t.getTime() < now.getTime() - 86400_000) t = new Date(now.getFullYear() + 1, m - 1, d, hh || 0, mm || 0, 0, 0);
  }
  return t;
}

function CountdownWidget({ config, size }: WidgetProps<Config>) {
  const tr = useT();
  const { locale } = useModule();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const t = target(config, now);
  if (!t) return <Empty icon="hourglass" title={tr("widget.countdown.empty")}>{tr("widget.countdown.emptyHint")}</Empty>;
  const ms = t.getTime() - now.getTime();
  const past = ms < 0;
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86400_000);
  const hours = Math.floor((abs % 86400_000) / 3600_000);
  const weeks = Math.floor(days / 7);
  const mode = config.showUnits === "auto" || !config.showUnits ? (days === 0 ? "hours" : days > 21 ? "weeks" : "days") : config.showUnits;
  let big: string, unit: string;
  if (mode === "hours") {
    const h = days * 24 + hours;
    big = String(h);
    unit = tr("unit.hours", { count: h });
  } else if (mode === "weeks") {
    big = tr("unit.weeksDays", { weeks, days: days % 7 });
    unit = "";
  } else {
    big = String(days);
    unit = tr("unit.days", { count: days });
  }
  const today = days === 0 && !past && t.toDateString() === now.toDateString();
  const px = Math.max(22, Math.min(size.height * 0.45, size.width / Math.max(3, big.length * 0.9)));
  const years = config.yearly && config.date ? now.getFullYear() + (t.getFullYear() > now.getFullYear() ? 1 : 0) - Number(config.date.slice(0, 4)) : null;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, textAlign: "center" }}>
      <div className="soft" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name={config.icon || "hourglass"} size={12} style={{ color: "var(--accent)" }} /> {config.title || tr("defaultTitle")}
      </div>
      {today ? (
        <div className="pixel" style={{ fontSize: px * 0.8, lineHeight: 1, color: "var(--accent)" }}>{tr("today")}</div>
      ) : (
        <>
          <div className="pixel" style={{ fontSize: px, lineHeight: 1, fontVariantNumeric: "tabular-nums", color: past ? "var(--ink-soft)" : undefined }}>{big}</div>
          <div className="soft" style={{ fontSize: 11 }}>
            {unit ? `${unit} ` : ""}{past ? tr("ago") : tr("toGo")} · {t.toLocaleDateString(locale, { day: "numeric", month: "short", ...(config.yearly ? {} : { year: "numeric" }) })}
            {years !== null && years > 0 ? ` · ${tr("turns", { count: years })}` : ""}
          </div>
        </>
      )}
    </div>
  );
}

export default defineClient({ widgets: { countdown: CountdownWidget } });
