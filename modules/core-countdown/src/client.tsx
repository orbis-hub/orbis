import { useEffect, useState } from "react";
import { defineClient, useModule, useT, type WidgetProps } from "@orbis/sdk/client";
import { Empty, Icon } from "@orbis/ui";

type Config = { title?: string; date?: string; time?: string; yearly?: boolean; icon?: string; showUnits?: "auto" | "days" | "weeks" | "hours" };

/** "YYYY-MM-DD" → [y, m, d] when it is a real calendar date (2026-02-30 is not) */
export function parseDate(s: string | undefined): [number, number, number] | null {
  const m = s?.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(y, mo, 0).getDate()) return null;
  return [y, mo, d];
}

/** "HH:MM" (or "H:MM") → [h, m]; empty → midnight; "25:99" → null */
export function parseTime(s: string | undefined): [number, number] | null {
  if (!s?.trim()) return [0, 0];
  const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return [h, mi];
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** feb 29 in a non-leap year → feb 28 */
function dateIn(year: number, month: number, day: number, h: number, mi: number): Date {
  const t = new Date(year, month - 1, day, h, mi, 0, 0);
  return t.getMonth() !== month - 1 ? new Date(year, month - 1, day - 1, h, mi, 0, 0) : t;
}

/** target moment; `invalid` when the config holds a date/time that does not exist */
export function target(cfg: Config, now: Date): { t: Date } | { invalid: true } | null {
  if (!cfg.date?.trim()) return null;
  const date = parseDate(cfg.date);
  const time = parseTime(cfg.time);
  if (!date || !time) return { invalid: true };
  const [y, m, d] = date;
  const [hh, mm] = time;
  let t = dateIn(y, m, d, hh, mm);
  if (cfg.yearly) {
    // this year's date while it is still today or ahead, otherwise next year's
    t = dateIn(now.getFullYear(), m, d, hh, mm);
    if (startOfDay(t) < startOfDay(now)) t = dateIn(now.getFullYear() + 1, m, d, hh, mm);
  }
  return { t };
}

function CountdownWidget({ config, size }: WidgetProps<Config>) {
  const tr = useT();
  const { locale } = useModule();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const res = target(config, now);
  if (!res) return <Empty icon="hourglass" title={tr("widget.countdown.empty")}>{tr("widget.countdown.emptyHint")}</Empty>;
  if ("invalid" in res) return <Empty icon="hourglass" title={tr("widget.countdown.invalid")}>{tr("widget.countdown.emptyHint")}</Empty>;
  const t = res.t;
  // "today!" for the whole calendar day, compared by local date (not by milliseconds against the target time)
  const today = sameDay(t, now);
  const ms = t.getTime() - now.getTime();
  const past = !today && ms < 0;
  const abs = Math.abs(ms);
  // calendar-day distance for the day/week modes, so "tomorrow 00:00" is 1 day at 23:00 and not "1 hour"
  const dayDiff = Math.abs(Math.round((startOfDay(t).getTime() - startOfDay(now).getTime()) / 86400_000));
  let mode: "hours" | "days" | "weeks" = config.showUnits === "auto" || !config.showUnits ? (dayDiff === 0 ? "hours" : dayDiff > 21 ? "weeks" : "days") : config.showUnits;
  if (mode === "weeks" && dayDiff < 7) mode = "days"; // "0w 3d" is just "3 days"
  let big: string, unit: string;
  if (mode === "hours") {
    const h = Math.floor(abs / 3600_000);
    big = String(h);
    unit = tr("unit.hours", { count: h });
  } else if (mode === "weeks") {
    big = tr("unit.weeksDays", { weeks: Math.floor(dayDiff / 7), days: dayDiff % 7 });
    unit = "";
  } else {
    big = String(dayDiff);
    unit = tr("unit.days", { count: dayDiff });
  }
  const px = Math.max(22, Math.min(size.height * 0.45, size.width / Math.max(3, big.length * 0.9)));
  const years = config.yearly ? t.getFullYear() - parseDate(config.date)![0] : null;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, textAlign: "center" }}>
      <div className="soft" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name={config.icon || "hourglass"} size={12} style={{ color: "var(--accent)" }} /> {config.title || tr("defaultTitle")}
      </div>
      {today ? (
        <>
          <div className="pixel" style={{ fontSize: px * 0.8, lineHeight: 1, color: "var(--accent)" }}>{tr("today")}</div>
          {years !== null && years > 0 ? <div className="soft" style={{ fontSize: 11 }}>{tr("turns", { count: years })}</div> : null}
        </>
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
