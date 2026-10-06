import { defineModule } from "@orbis/sdk/server";

type Settings = { locations?: string[]; units?: "metric" | "imperial"; refreshMinutes?: number };
type Location = { id: string; name: string; lat: number; lon: number };

export type WeatherData = {
  location: Location;
  units: "metric" | "imperial";
  fetchedAt: string;
  current: { temp: number; feelsLike: number; humidity: number; wind: number; windDir: number; code: number; isDay: boolean; precipitation: number };
  hourly: Array<{ time: string; temp: number; code: number; precipProb: number }>;
  daily: Array<{ date: string; min: number; max: number; code: number; precipProb: number; sunrise: string; sunset: string }>;
};

function parseLocations(s: Settings): Location[] {
  const out: Location[] = [];
  for (const raw of s.locations ?? []) {
    const m = String(raw).match(/^\s*([a-z0-9_-]+)\s*=\s*(.+?)\s*@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/i);
    if (m) out.push({ id: m[1]!.toLowerCase(), name: m[2]!, lat: Number(m[3]), lon: Number(m[4]) });
  }
  return out;
}

export default defineModule<Settings>({
  setup(ctx) {
    const cache = new Map<string, WeatherData>();
    let inflight = new Map<string, Promise<WeatherData>>();

    const locations = (): Location[] => {
      const list = parseLocations(ctx.settings.get());
      if (list.length) return list;
      // fall back to the hub's default location if the user never configured one
      const hubLoc = ctx.storage.get<Location>("hubLocation");
      return hubLoc ? [hubLoc] : [{ id: "default", name: "Würzburg", lat: 49.79, lon: 9.95 }];
    };
    const units = () => ctx.settings.get().units ?? "metric";

    async function fetchWeather(loc: Location): Promise<WeatherData> {
      const u = units();
      const q = new URLSearchParams({
        latitude: String(loc.lat),
        longitude: String(loc.lon),
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m",
        hourly: "temperature_2m,weather_code,precipitation_probability",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
        timezone: "auto",
        forecast_days: "7",
        temperature_unit: u === "imperial" ? "fahrenheit" : "celsius",
        wind_speed_unit: u === "imperial" ? "mph" : "kmh",
        precipitation_unit: u === "imperial" ? "inch" : "mm",
      });
      const res = await ctx.fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
      const j = (await res.json()) as {
        current: Record<string, number>;
        hourly: { time: string[]; temperature_2m: number[]; weather_code: number[]; precipitation_probability: number[] };
        daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[]; sunrise: string[]; sunset: string[] };
      };
      const nowIdx = Math.max(0, j.hourly.time.findIndex((t) => new Date(t).getTime() > Date.now()) - 1);
      const data: WeatherData = {
        location: loc,
        units: u,
        fetchedAt: new Date().toISOString(),
        current: {
          temp: j.current.temperature_2m!,
          feelsLike: j.current.apparent_temperature!,
          humidity: j.current.relative_humidity_2m!,
          wind: j.current.wind_speed_10m!,
          windDir: j.current.wind_direction_10m!,
          code: j.current.weather_code!,
          isDay: j.current.is_day === 1,
          precipitation: j.current.precipitation!,
        },
        hourly: j.hourly.time.slice(nowIdx, nowIdx + 24).map((time, i) => ({ time, temp: j.hourly.temperature_2m[nowIdx + i]!, code: j.hourly.weather_code[nowIdx + i]!, precipProb: j.hourly.precipitation_probability[nowIdx + i] ?? 0 })),
        daily: j.daily.time.map((date, i) => ({ date, min: j.daily.temperature_2m_min[i]!, max: j.daily.temperature_2m_max[i]!, code: j.daily.weather_code[i]!, precipProb: j.daily.precipitation_probability_max[i] ?? 0, sunrise: j.daily.sunrise[i]!, sunset: j.daily.sunset[i]! })),
      };
      cache.set(loc.id, data);
      ctx.storage.set(`cache:${loc.id}`, data);
      ctx.events.publish("updated", { location: loc.id });
      return data;
    }

    function get(locId: string | undefined, force = false): Promise<WeatherData> {
      const locs = locations();
      const loc = (locId && locs.find((l) => l.id === locId)) || locs[0]!;
      const hit = cache.get(loc.id) ?? ctx.storage.get<WeatherData>(`cache:${loc.id}`);
      const maxAge = (ctx.settings.get().refreshMinutes ?? 15) * 60_000;
      if (hit && !force && Date.now() - new Date(hit.fetchedAt).getTime() < maxAge && hit.units === units() && hit.location.lat === loc.lat && hit.location.lon === loc.lon) {
        cache.set(loc.id, hit);
        return Promise.resolve(hit);
      }
      let p = inflight.get(loc.id);
      if (!p) {
        p = fetchWeather(loc).finally(() => inflight.delete(loc.id));
        inflight.set(loc.id, p);
      }
      return p;
    }

    const refreshAll = async () => {
      for (const l of locations()) {
        try {
          await get(l.id, true);
        } catch (err) {
          ctx.logger.warn(`refresh failed for ${l.id}: ${(err as Error).message}`);
        }
      }
    };
    const schedule = () => ctx.scheduler.every("refresh", (ctx.settings.get().refreshMinutes ?? 15) * 60_000, refreshAll, { immediate: true });
    schedule();
    ctx.settings.onChange(() => {
      cache.clear();
      inflight = new Map();
      schedule();
    });

    ctx.http.get("/locations", (c) => c.json(locations()));
    ctx.http.get("/now", async (c) => {
      try {
        return c.json(await get(c.req.query("location") || undefined, c.req.query("force") === "1"));
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    });
    ctx.http.get("/geocode", async (c) => {
      const q = c.req.query("q");
      if (!q) return c.json([]);
      const lang = ctx.i18n.language.split("-")[0] || "en";
      const res = await ctx.fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=${encodeURIComponent(lang)}&format=json`, { signal: AbortSignal.timeout(10_000) });
      const j = (await res.json()) as { results?: Array<{ name: string; country: string; admin1?: string; latitude: number; longitude: number }> };
      return c.json((j.results ?? []).map((r) => ({ name: r.name, country: r.country, region: r.admin1, lat: r.latitude, lon: r.longitude })));
    });

    ctx.logger.info("weather ready");

    // e-ink: reuse the cached data; the hub calls this for every render
    einkRender = async (req) => {
      const t = ctx.i18n.t;
      const cfg = req.config as { location?: string; days?: number; details?: boolean };
      const d = await get(cfg.location || undefined);
      const deg = d.units === "imperial" ? "°F" : "°C";
      const icon = (code: number, day = true) => {
        if (code === 0 || code === 1) return day ? "sun" : "moon";
        if (code === 2) return day ? "cloud-sun" : "cloud-moon";
        if (code === 3) return "cloud";
        if (code === 45 || code === 48) return "fog";
        if (code <= 57) return "drizzle";
        if (code <= 67 || (code >= 80 && code <= 82)) return "rain";
        if (code <= 77 || code === 85 || code === 86) return "snow";
        if (code >= 95) return "thunder";
        return "cloud";
      };
      if (req.widget === "forecast") {
        const days = d.daily.slice(0, Math.max(2, Math.min(7, cfg.days ?? 5)));
        return {
          type: "row",
          grow: 1,
          gap: 4,
          children: days.map((day, i) => ({
            type: "col" as const,
            grow: 1,
            align: "center" as const,
            justify: "center" as const,
            gap: 2,
            children: [
              { type: "text" as const, text: i === 0 ? t("common.today") : new Date(day.date).toLocaleDateString(req.locale, { weekday: "short" }).toLowerCase(), size: 13, gray: 0.5 },
              { type: "weather-icon" as const, name: icon(day.code), size: Math.max(20, Math.min(40, req.width / days.length - 12)) },
              { type: "text" as const, text: `${Math.round(day.max)}° ${Math.round(day.min)}°`, size: 14, pixel: false },
              ...(day.precipProb >= 20 ? [{ type: "text" as const, text: `☂ ${day.precipProb}%`, size: 11, pixel: false, gray: 0.5 }] : []),
            ],
          })),
        };
      }
      const c = d.current;
      const big = Math.max(24, Math.min(req.height * 0.5, req.width / 4));
      return {
        type: "row",
        grow: 1,
        align: "center",
        gap: 12,
        children: [
          { type: "weather-icon", name: icon(c.code, c.isDay), size: big * 1.1 },
          {
            type: "col",
            grow: 1,
            justify: "center",
            gap: 2,
            children: [
              { type: "text", text: `${Math.round(c.temp)}${deg}`, size: big },
              { type: "text", text: t("eink.feels", { name: d.location.name, temp: Math.round(c.feelsLike) }), size: 12, pixel: false, gray: 0.4 },
              ...(cfg.details !== false && d.daily[0]
                ? [{ type: "text" as const, text: t("eink.details", { min: Math.round(d.daily[0].min), max: Math.round(d.daily[0].max), wind: Math.round(c.wind), unit: d.units === "imperial" ? "mph" : "km/h", humidity: c.humidity }), size: 11, pixel: false, gray: 0.5 }]
                : []),
            ],
          },
        ],
      };
    };
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => Promise<import("@orbis/sdk/server").EinkTree>) | null = null;
