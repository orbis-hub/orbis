import { useState } from "react";
import { defineClient, useModuleApi, useModuleQuery, useModuleSettings, type PageProps, type SettingsProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Window } from "@orbis/ui";
import type { WeatherData } from "./server";

/* WMO weather codes → icon + label */
function describe(code: number, isDay = true): { icon: string; label: string } {
  if (code === 0) return { icon: isDay ? "sun" : "moon", label: isDay ? "clear" : "clear night" };
  if (code <= 2) return { icon: isDay ? "cloud-sun" : "cloud-moon", label: "partly cloudy" };
  if (code === 3) return { icon: "cloud", label: "overcast" };
  if (code <= 48) return { icon: "cloud", label: "fog" };
  if (code <= 57) return { icon: "cloud", label: "drizzle" };
  if (code <= 67) return { icon: "cloud", label: "rain" };
  if (code <= 77) return { icon: "cloud", label: "snow" };
  if (code <= 82) return { icon: "cloud", label: "showers" };
  if (code <= 86) return { icon: "cloud", label: "snow showers" };
  return { icon: "zap", label: "thunderstorm" };
}

/** Hand-drawn 16×16 pixel icons for conditions the icon set lacks. */
const PIX: Record<string, string[]> = {
  rain: ["....######......", "..##......##....", ".#..........#...", "#............##.", "#..............#", "#..............#", ".##############.", "................", "..#...#...#.....", ".#...#...#......", "#...#...#.......", "................", "....#...#...#...", "...#...#...#....", "..#...#...#.....", "................"],
  snow: ["....######......", "..##......##....", ".#..........#...", "#............##.", "#..............#", "#..............#", ".##############.", "................", "..#.....#.....#.", ".###...###...###", "..#.....#.....#.", "................", "#.....#.....#...", "###..###...###..", "#.....#.....#...", "................"],
  drizzle: ["....######......", "..##......##....", ".#..........#...", "#............##.", "#..............#", "#..............#", ".##############.", "................", "...#....#....#..", "................", "......#....#....", "................", "...#....#....#..", "................", "................", "................"],
  fog: ["................", "................", "..############..", "................", ".##############.", "................", "...##########...", "................", ".##############.", "................", "..############..", "................", "....########....", "................", "................", "................"],
  storm: ["....######......", "..##......##....", ".#..........#...", "#............##.", "#..............#", "#..............#", ".##############.", "................", ".......###......", "......##........", ".....####.......", "........##......", ".......##.......", "......##........", ".....#..........", "................"],
};
function pixKey(code: number) {
  if (code >= 95) return "storm";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 85 && code <= 86) return "snow";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code === 45 || code === 48) return "fog";
  return null;
}

function WeatherIcon({ code, isDay = true, size = 32 }: { code: number; isDay?: boolean; size?: number }) {
  const key = pixKey(code);
  if (key && PIX[key]) {
    const grid = PIX[key]!;
    return (
      <svg viewBox="0 0 16 16" width={size} height={size} shapeRendering="crispEdges" fill="currentColor" aria-hidden>
        {grid.flatMap((row, y) => [...row].map((ch, x) => (ch === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null)))}
      </svg>
    );
  }
  return <Icon name={describe(code, isDay).icon} size={size} />;
}

const deg = (u: string) => (u === "imperial" ? "°F" : "°C");
const spd = (u: string) => (u === "imperial" ? "mph" : "km/h");
const r = (n: number) => Math.round(n);

function useWeather(location: string | undefined) {
  return useModuleQuery<WeatherData | { error: string }>(`/now${location ? `?location=${encodeURIComponent(location)}` : ""}`, { refetchOn: ["updated"], intervalMs: 5 * 60_000 });
}

function Status({ q }: { q: { loading: boolean; error: Error | null; data: unknown } }) {
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>fetching weather<span className="blink">…</span></span>;
  if (q.error) return <span style={{ color: "var(--dnd)", fontSize: 12 }}>{q.error.message}</span>;
  const d = q.data as { error?: string } | undefined;
  if (d && "error" in d && d.error) return <span style={{ color: "var(--dnd)", fontSize: 12 }}>{d.error}</span>;
  return null;
}

/* ---------- widgets ---------- */

function CurrentWidget({ config, size }: WidgetProps<{ location?: string; details?: boolean }>) {
  const q = useWeather(config.location || undefined);
  const d = q.data && !("error" in q.data) ? q.data : null;
  if (!d) return <Status q={q} />;
  const c = d.current;
  const info = describe(c.code, c.isDay);
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
            {info.label} · {d.location.name}
          </div>
        </div>
      </div>
      {config.details !== false && !compact ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
          <Chip style={{ fontSize: 10 }}>feels {r(c.feelsLike)}°</Chip>
          <Chip style={{ fontSize: 10 }}><Icon name="wind" size={10} /> {r(c.wind)} {spd(d.units)}</Chip>
          <Chip style={{ fontSize: 10 }}>{c.humidity}% rh</Chip>
          {d.daily[0] ? <Chip style={{ fontSize: 10 }}>{r(d.daily[0].min)}° / {r(d.daily[0].max)}°</Chip> : null}
        </div>
      ) : null}
    </div>
  );
}

function ForecastWidget({ config, size }: WidgetProps<{ location?: string; days?: number }>) {
  const q = useWeather(config.location || undefined);
  const d = q.data && !("error" in q.data) ? q.data : null;
  if (!d) return <Status q={q} />;
  const days = d.daily.slice(0, Math.max(2, Math.min(7, config.days ?? 5)));
  const iconSize = Math.max(16, Math.min(28, size.height * 0.25));
  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: `repeat(${days.length}, 1fr)`, gap: 4, alignItems: "stretch" }}>
      {days.map((day, i) => (
        <div key={day.date} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, borderLeft: i ? "1px dashed var(--line)" : undefined, padding: "2px 2px", minWidth: 0 }}>
          <span className="pixel soft" style={{ fontSize: 11 }}>{i === 0 ? "today" : new Date(day.date).toLocaleDateString(undefined, { weekday: "short" })}</span>
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
  const locs = useModuleQuery<Array<{ id: string; name: string }>>("/locations", { refetchOn: ["updated"] });
  const [loc, setLoc] = useState<string | undefined>(undefined);
  const q = useWeather(loc);
  const d = q.data && !("error" in q.data) ? q.data : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {(locs.data ?? []).map((l, i) => (
          <Button key={l.id} size="sm" aria-pressed={loc ? loc === l.id : i === 0} onClick={() => setLoc(l.id)}>
            <Icon name="map-pin" size={12} /> {l.name}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} loading={q.loading} aria-label="refresh"><Icon name="reload" size={12} /></Button>
        {d ? <span className="soft" style={{ fontSize: 10 }}>updated {new Date(d.fetchedAt).toLocaleTimeString()}</span> : null}
      </div>
      {!d ? (
        <Status q={q} />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
            <Window title={`now · ${d.location.name}`}>
              <div style={{ height: 150 }}>
                <CurrentWidget config={{ location: loc, details: true }} size={{ width: 300, height: 150 }} instance={{} as never} editing={false} />
              </div>
            </Window>
            <Window title="next hours" tight>
              <div className="scroll-x" style={{ display: "flex", gap: 2, padding: 10 }}>
                {d.hourly.slice(0, 24).map((h) => (
                  <div key={h.time} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, minWidth: 40 }}>
                    <span className="soft" style={{ fontSize: 10 }}>{new Date(h.time).getHours()}h</span>
                    <span style={{ color: "var(--accent-2)", display: "inline-flex" }}><WeatherIcon code={h.code} size={16} /></span>
                    <span style={{ fontSize: 11 }}>{r(h.temp)}°</span>
                    <span className="soft" style={{ fontSize: 9 }}>{h.precipProb ? `${h.precipProb}%` : ""}</span>
                  </div>
                ))}
              </div>
            </Window>
          </div>
          <Window title="7 days">
            <div style={{ height: 120 }}>
              <ForecastWidget config={{ location: loc, days: 7 }} size={{ width: 700, height: 120 }} instance={{} as never} editing={false} />
            </div>
            <div className="soft" style={{ fontSize: 10, marginTop: 8, display: "flex", gap: 12 }}>
              {d.daily[0] ? <span>☀ {new Date(d.daily[0].sunrise).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
              {d.daily[0] ? <span>☾ {new Date(d.daily[0].sunset).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> : null}
              <span style={{ marginLeft: "auto" }}>data: open-meteo.com</span>
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
  const [, setSettings] = useModuleSettings();
  void setSettings;
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ name: string; country: string; region?: string; lat: number; lon: number }>>([]);
  const [busy, setBusy] = useState(false);
  const locations = (Array.isArray(value.locations) ? value.locations : []) as string[];
  const set = (patch: Record<string, unknown>) => onChange({ ...value, ...patch });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="locations" hint="first one is the default. widgets can pick another by id.">
        {locations.length === 0 ? <div className="soft" style={{ fontSize: 12 }}>none yet – search below</div> : null}
        {locations.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Input value={l} onChange={(e) => set({ locations: locations.map((x, j) => (j === i ? e.target.value : x)) })} />
            <Button icon size="sm" variant="ghost" onClick={() => set({ locations: locations.filter((_, j) => j !== i) })} aria-label="remove"><Icon name="close" size={12} /></Button>
          </div>
        ))}
      </Field>
      <Field label="add a place">
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
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="city name" />
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
        <Field label="units">
          <select className="input" value={String(value.units ?? "metric")} onChange={(e) => set({ units: e.target.value })}>
            <option value="metric">metric</option>
            <option value="imperial">imperial</option>
          </select>
        </Field>
        <Field label="refresh (min)">
          <Input type="number" min={5} max={120} value={Number(value.refreshMinutes ?? 15)} onChange={(e) => set({ refreshMinutes: Number(e.target.value) })} />
        </Field>
      </div>
      {locations.length === 0 ? <Empty icon="cloud-sun">without a location the hub's default (Würzburg) is used.</Empty> : null}
    </div>
  );
}

export default defineClient({
  widgets: { current: CurrentWidget, forecast: ForecastWidget },
  pages: { weather: WeatherPage },
  settings: WeatherSettings,
});
