import { useEffect, useState } from "react";
import { defineClient, useModule, useT, type WidgetProps } from "@orbis/sdk/client";

type Config = { showSeconds?: boolean; showDate?: boolean; hour12?: boolean; timezone?: string; label?: string };

function useNow(tickMs: number) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return now;
}

function DigitalClock({ config, size }: WidgetProps<Config>) {
  const t = useT();
  // empty = hub default: the hub's timezone and formatting locale, not the browser's
  const { locale, timezone } = useModule();
  const now = useNow(config.showSeconds ? 1000 : 10_000);
  const tz = config.timezone?.trim() || timezone || undefined;
  let time = "";
  let date = "";
  try {
    time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: config.showSeconds ? "2-digit" : undefined, hour12: config.hour12 ?? false, timeZone: tz }).format(now);
    date = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(now);
  } catch {
    time = t("error.badTimezone");
  }
  // scale the digits with the widget: roughly 1/4 of the height, capped by width (size is 0×0 before the frame measured itself)
  const px = size.height > 0 ? Math.max(18, Math.min(size.height * 0.42, size.width / (config.showSeconds ? 5.2 : 3.6))) : 29;
  // label and date truncate with an ellipsis instead of wrapping under the digits
  const line = { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "lowercase" } as const;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, textAlign: "center", minWidth: 0, overflow: "hidden" }}>
      {config.label ? <div className="soft" style={{ fontSize: "var(--fs-meta)", ...line }} title={config.label}>{config.label}</div> : null}
      <div className="pixel" style={{ fontSize: px, lineHeight: 1, letterSpacing: "0.04em", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        {time}
      </div>
      {config.showDate !== false ? <div className="soft" style={{ fontSize: `max(var(--fs-meta), ${Math.round(px * 0.28)}px)`, ...line }} title={date}>{date}</div> : null}
    </div>
  );
}

export default defineClient({
  widgets: { digital: DigitalClock },
});
