import { useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, useModuleSettings, useT, type PageProps, type SettingsProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Window, WeatherIcon as UiWeatherIcon, describeWmo } from "@orbis/ui";
import type { WeatherData } from "./server";

// icons + wmo mapping come from @orbis/ui (same pixel glyphs as vensin.dev)
const describe = (code: number, isDay = true) => describeWmo(code, isDay);
function WeatherIcon({ code, isDay = true, size = 32 }: { code: number; isDay?: boolean; size?: number }) {
  return <UiWeatherIcon name={describe(code, isDay).icon} size={size} />;
}
/** same buckets as describeWmo, but as a translation key so the label follows the hub language */
function conditionKey(code: number): string {
  if (code === 0) return "condition.clear";
  if (code === 1) return "condition.mostly_clear";
  if (code === 2) return "condition.partly_cloudy";
  if (code === 3) return "condition.overcast";
  if (code === 45 || code === 48) return "condition.fog";
  if (code >= 51 && code <= 57) return "condition.drizzle";
  if (code >= 61 && code <= 67) return "condition.rain";
  if (code >= 71 && code <= 77) return "condition.snow";
  if (code >= 80 && code <= 82) return "condition.rain_showers";
  if (code === 85 || code === 86) return "condition.snow_showers";
  if (code >= 95) return "condition.thunderstorm";
  return "condition.cloudy";
}

const deg = (u: string) => (u === "imperial" ? "°F" : "°C");
const spd = (u: string) => (u === "imperial" ? "mph" : "km/h");
const r = (n: number) => Math.round(n);

function useWeather(location: string | undefined) {
  return useModuleQuery<WeatherData | { error: string }>(`/now${location ? `?location=${encodeURIComponent(location)}` : ""}`, { refetchOn: ["updated"], intervalMs: 5 * 60_000 });
}

function Status({ q }: { q: { loading: boolean; error: Error | null; data: unknown } }) {
  const t = useT();
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("status.fetching")}<span className="blink">…</span></span>;
  if (q.error) return <span style={{ color: "var(--dnd)", fontSize: 12 }}>{q.error.message}</span>;
  const d = q.data as { error?: string } | undefined;
  if (d && "error" in d && d.error) return <span style={{ color: "var(--dnd)", fontSize: 12 }}>{d.error}</span>;
  return null;
}

/* ---------- widgets ---------- */

function CurrentWidget({ config, size }: WidgetProps<{ location?: string; details?: boolean }>) {
  const t = useT();
  const q = useWeather(config.location || undefined);
  const d = q.data && !("error" in q.data) ? q.data : null;
  if (!d) return <Status q={q} />;
  const c = d.current;
  const big = Math.max(22, Math.min(size.height * 0.36, size.width / 5));
  const compact = size.height < 120;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "var(--accent)", display: "inline-flex" }}>
          <WeatherIcon code={c.code} isDay={c.isDay} size={big * 1.1} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="pixel" style={{ fontSize: big, lineHeight: 1 }}>
            {r(c.temp)}
            <span style={{ fontSize: big * 0.5 }}>{deg(d.units)}</span>
          </div>
          <div className="soft" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t(conditionKey(c.code))} · {d.location.name}
          </div>
        </div>
      </div>
      {config.details !== false && !compact ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
          <Chip style={{ fontSize: 10 }}>{t("current.feels", { temp: r(c.feelsLike) })}</Chip>
          <Chip style={{ fontSize: 10 }}><Icon name="wind" size={10} /> {r(c.wind)} {spd(d.units)}</Chip>
          <Chip style={{ fontSize: 10 }}>{t("current.humidity", { value: c.humidity })}</Chip>
          {d.daily[0] ? <Chip style={{ fontSize: 10 }}>{r(d.daily[0].min)}° / {r(d.daily[0].max)}°</Chip> : null}
        </div>
      ) : null}
    </div>
  );
}

function ForecastWidget({ config, size }: WidgetProps<{ location?: string; days?: number }>) {
  const t = useT();
  const { locale } = useModule();
  const q = useWeather(config.location || undefined);
  const d = q.data && !("error" in q.data) ? q.data : null;
  if (!d) return <Status q={q} />;
  const days = d.daily.slice(0, Math.max(2, Math.min(7, config.days ?? 5)));
  const iconSize = Math.max(16, Math.min(28, size.height * 0.25));
  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: `repeat(${days.length}, 1fr)`, gap: 4, alignItems: "stretch" }}>
      {days.map((day, i) => (
        <div key={day.date} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, borderLeft: i ? "1px dashed var(--line)" : undefined, padding: "2px 2px", minWidth: 0 }}>
          <span className="pixel soft" style={{ fontSize: 11 }}>{i === 0 ? t("common.today") : new Date(day.date).toLocaleDateString(locale, { weekday: "short" })}</span>
          <span style={{ color: "var(--accent)", display: "inline-flex" }}>
            <WeatherIcon code={day.code} size={iconSize} />
          </span>
          <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            {r(day.max)}° <span className="soft">{r(day.min)}°</span>
          </span>
          {day.precipProb >= 20 ? <span className="soft" style={{ fontSize: 10 }}>☂ {day.precipProb}%</span> : null}
        </div>
      ))}
    </div>
  );
}

/* ---------- page ---------- */

function WeatherPage(_p: PageProps) {
  const t = useT();
  const { locale } = useModule();
  const locs = useModuleQuery<Array<{ id: string; name: string }>>("/locations", { refetchOn: ["updated"] });
  const [loc, setLoc] = useState<string | undefined>(undefined);
  const q = useWeather(loc);
  const d = q.data && !("error" in q.data) ? q.data : null;
  const hm = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {(locs.data ?? []).map((l, i) => (
          <Button key={l.id} size="sm" aria-pressed={loc ? loc === l.id : i === 0} onClick={() => setLoc(l.id)}>
            <Icon name="map-pin" size={12} /> {l.name}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} loading={q.loading} aria-label={t("common.refresh")}><Icon name="reload" size={12} /></Button>
        {d ? <span className="soft" style={{ fontSize: 10 }}>{t("page.updated", { time: new Date(d.fetchedAt).toLocaleTimeString(locale) })}</span> : null}
      </div>
      {!d ? (
        <Status q={q} />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
            <Window title={t("page.now", { name: d.location.name })}>
              <div style={{ height: 150 }}>
                <CurrentWidget config={{ location: loc, details: true }} size={{ width: 300, height: 150 }} instance={{} as never} editing={false} />
              </div>
            </Window>
            <Window title={t("page.next_hours")} tight>
              <div className="scroll-x" style={{ display: "flex", gap: 2, padding: 10 }}>
                {d.hourly.slice(0, 24).map((h) => (
                  <div key={h.time} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, minWidth: 40 }}>
                    <span className="soft" style={{ fontSize: 10 }}>{t("page.hour", { hour: new Date(h.time).getHours() })}</span>
                    <span style={{ color: "var(--accent-2)", display: "inline-flex" }}><WeatherIcon code={h.code} size={16} /></span>
                    <span style={{ fontSize: 11 }}>{r(h.temp)}°</span>
                    <span className="soft" style={{ fontSize: 9 }}>{h.precipProb ? `${h.precipProb}%` : ""}</span>
                  </div>
                ))}
              </div>
            </Window>
          </div>
          <Window title={t("page.seven_days")}>
            <div style={{ height: 120 }}>
              <ForecastWidget config={{ location: loc, days: 7 }} size={{ width: 700, height: 120 }} instance={{} as never} editing={false} />
            </div>
            <div className="soft" style={{ fontSize: 10, marginTop: 8, display: "flex", gap: 12 }}>
              {d.daily[0] ? <span>☀ {hm(d.daily[0].sunrise)}</span> : null}
              {d.daily[0] ? <span>☾ {hm(d.daily[0].sunset)}</span> : null}
              <span style={{ marginLeft: "auto" }}>{t("page.source")}</span>
            </div>
          </Window>
        </>
      )}
    </div>
  );
}

/* ---------- custom settings UI with geocoding ---------- */

function WeatherSettings({ value, onChange }: SettingsProps) {
  const api = useModuleApi();
  const t = useT();
  const [, setSettings] = useModuleSettings();
  void setSettings;
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ name: string; country: string; region?: string; lat: number; lon: number }>>([]);
  const [busy, setBusy] = useState(false);
  const locations = (Array.isArray(value.locations) ? value.locations : []) as string[];
  const set = (patch: Record<string, unknown>) => onChange({ ...value, ...patch });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label={t("settings.locations")} hint={t("settings.locations_hint")}>
        {locations.length === 0 ? <div className="soft" style={{ fontSize: 12 }}>{t("settings.locations_empty")}</div> : null}
        {locations.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Input value={l} onChange={(e) => set({ locations: locations.map((x, j) => (j === i ? e.target.value : x)) })} />
            <Button icon size="sm" variant="ghost" onClick={() => set({ locations: locations.filter((_, j) => j !== i) })} aria-label={t("common.remove")}><Icon name="close" size={12} /></Button>
          </div>
        ))}
      </Field>
      <Field label={t("settings.add_place")}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setResults(await api(`/geocode?q=${encodeURIComponent(q)}`));
            } finally {
              setBusy(false);
            }
          }}
          style={{ display: "flex", gap: 6 }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("settings.city_placeholder")} />
          <Button type="submit" size="sm" loading={busy}><Icon name="search" size={12} /></Button>
        </form>
        {results.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
            {results.map((r2, i) => (
              <button
                key={i}
                type="button"
                className="menu-item"
                style={{ border: "1px dashed var(--line)" }}
                onClick={() => {
                  const id = r2.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `loc${locations.length + 1}`;
                  set({ locations: [...locations, `${id}=${r2.name}@${r2.lat.toFixed(3)},${r2.lon.toFixed(3)}`] });
                  setResults([]);
                  setQ("");
                }}
              >
                <Icon name="map-pin" size={12} /> {r2.name}
                <span className="soft">{[r2.region, r2.country].filter(Boolean).join(", ")}</span>
              </button>
            ))}
          </div>
        ) : null}
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label={t("settings.units")}>
          <select className="input" value={String(value.units ?? "metric")} onChange={(e) => set({ units: e.target.value })}>
            <option value="metric">{t("settings.units_metric")}</option>
            <option value="imperial">{t("settings.units_imperial")}</option>
          </select>
        </Field>
        <Field label={t("settings.refresh")}>
          <Input type="number" min={5} max={120} value={Number(value.refreshMinutes ?? 15)} onChange={(e) => set({ refreshMinutes: Number(e.target.value) })} />
        </Field>
      </div>
      {locations.length === 0 ? <Empty icon="cloud-sun">{t("settings.no_location")}</Empty> : null}
    </div>
  );
}

export default defineClient({
  widgets: { current: CurrentWidget, forecast: ForecastWidget },
  pages: { weather: WeatherPage },
  settings: WeatherSettings,
});
