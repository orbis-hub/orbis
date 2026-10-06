import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, useT, type PageProps, type SettingsProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Select, Switch, isDarkTheme } from "@orbis/ui";
import type { Departure, Stop } from "./server";
import { formatKm, placeLabel, type LatLon, type Place, type TripRoute } from "./lib";

type Config = { stopId?: string; stopName?: string; count?: number; lines?: string[]; walkMinutes?: number; products?: string[]; showMap?: boolean };
type Board = { stopId: string; departures: Departure[]; fetchedAt: string };
type QueryError = Error & { data?: { retryAt?: string } };

const PRODUCTS = ["bus", "tram", "subway", "suburban", "regional", "national"];
const MAP_MIN_COLS = 4;

/** server error strings that have a translation (one per provider family) */
const ERROR_KEYS: Record<string, string> = { "transport api unavailable": "error.unavailable", "vgn api unavailable": "error.vgnUnavailable" };
const errorLabel = (t: (k: string) => string, msg: string): string => (ERROR_KEYS[msg] ? t(ERROR_KEYS[msg]!) : msg);

const minsUntil = (iso: string | null, now: number) => (iso ? Math.round((new Date(iso).getTime() - now) / 60_000) : null);

/** translated product name, or the raw hafas product when we have no string for it */
function productName(t: (k: string) => string, p: string): string {
  const v = t(`product.${p}`);
  return v === `product.${p}` ? p : v;
}

function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** error text for a failed board, with the retry hint when the hub is backing off */
function useErrorText() {
  const t = useT();
  const now = useNow(1000);
  return (err: QueryError | null | undefined, data?: unknown): string | null => {
    const msg = (data && typeof data === "object" && "error" in data ? String((data as { error: string }).error) : null) ?? err?.message ?? null;
    if (!msg) return null;
    const retryAt = err?.data?.retryAt ?? (data as { retryAt?: string } | undefined)?.retryAt;
    const secs = retryAt ? Math.max(0, Math.ceil((new Date(retryAt).getTime() - now) / 1000)) : null;
    const base = errorLabel(t, msg);
    return secs ? `${base} · ${t("retryIn", { count: secs })}` : base;
  };
}

/* ---------- leaflet (cdn, lazy, once) ---------- */

type LLayer = { addTo(target: unknown): LLayer; remove(): void; bindTooltip(text: string, opts?: Record<string, unknown>): LLayer; bindPopup(html: string): LLayer; getBounds?: () => LBounds };
type LBounds = { extend(x: LatLon | LBounds): LBounds; isValid(): boolean };
type LMap = { setView(c: LatLon, zoom: number): LMap; fitBounds(b: LBounds, opts?: Record<string, unknown>): LMap; invalidateSize(): void; remove(): void; getZoom(): number };
type LFeatureGroup = LLayer & { clearLayers(): void; addLayer(l: LLayer): void; getBounds(): LBounds };
type Leaflet = {
  map(el: HTMLElement, opts?: Record<string, unknown>): LMap;
  tileLayer(url: string, opts?: Record<string, unknown>): LLayer;
  circleMarker(c: LatLon, opts?: Record<string, unknown>): LLayer;
  polyline(c: LatLon[], opts?: Record<string, unknown>): LLayer & { getBounds(): LBounds };
  featureGroup(layers?: LLayer[]): LFeatureGroup;
  latLngBounds(points: LatLon[]): LBounds;
};

const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
let leafletPromise: Promise<Leaflet> | null = null;

function loadLeaflet(): Promise<Leaflet> {
  const w = window as unknown as { L?: Leaflet };
  if (w.L && typeof w.L.map === "function") return Promise.resolve(w.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise<Leaflet>((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = LEAFLET_CSS;
      css.crossOrigin = "";
      document.head.appendChild(css);
    }
    const s = document.createElement("script");
    s.src = LEAFLET_JS;
    s.async = true;
    s.crossOrigin = "";
    const timer = setTimeout(() => fail(new Error("leaflet load timeout")), 15_000);
    const fail = (err: Error) => {
      clearTimeout(timer);
      leafletPromise = null;
      s.remove();
      reject(err);
    };
    s.onload = () => {
      clearTimeout(timer);
      if (w.L && typeof w.L.map === "function") resolve(w.L);
      else fail(new Error("leaflet missing after load"));
    };
    s.onerror = () => fail(new Error("leaflet failed to load"));
    document.head.appendChild(s);
  });
  return leafletPromise;
}

const TILES = {
  light: { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', subdomains: "abc" },
  dark: { url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>', subdomains: "abcd" },
};

/** re-renders when the hub switches between light and dark */
function useDark(): boolean {
  const [dark, setDark] = useState(() => isDarkTheme());
  useEffect(() => {
    const update = () => setDark(isDarkTheme());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", update);
    };
  }, []);
  return dark;
}

const fmtTime = (iso: string | null, locale: string) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "");

/** the stop as a marker, plus one polyline + stopover dots per drawn route; degrades to a text hint without leaflet */
function RouteMap({ stop, routes, height }: { stop: Stop; routes: TripRoute[]; height: number | string }) {
  const t = useT();
  const { locale } = useModule();
  const dark = useDark();
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ L: Leaflet; map: LMap; tiles: LLayer | null; routeLayer: LFeatureGroup; stopLayer: LFeatureGroup } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let alive = true;
    loadLeaflet()
      .then((L) => {
        if (!alive || !el.current) return;
        const map = L.map(el.current, { zoomControl: true, attributionControl: true });
        const routeLayer = L.featureGroup().addTo(map) as LFeatureGroup;
        const stopLayer = L.featureGroup().addTo(map) as LFeatureGroup;
        mapRef.current = { L, map, tiles: null, routeLayer, stopLayer };
        setState("ready");
      })
      .catch(() => alive && setState("failed"));
    return () => {
      alive = false;
      mapRef.current?.map.remove();
      mapRef.current = null;
    };
  }, []);

  // tiles follow the theme
  useEffect(() => {
    const m = mapRef.current;
    if (!m || state !== "ready") return;
    m.tiles?.remove();
    const tile = dark ? TILES.dark : TILES.light;
    m.tiles = m.L.tileLayer(tile.url, { attribution: tile.attribution, subdomains: tile.subdomains, maxZoom: 19 }).addTo(m.map);
  }, [dark, state]);

  // stop marker + routes
  useEffect(() => {
    const m = mapRef.current;
    if (!m || state !== "ready") return;
    const { L, map, routeLayer, stopLayer } = m;
    routeLayer.clearLayers();
    stopLayer.clearLayers();
    const points: LatLon[] = [];
    for (const r of routes) {
      if (r.polyline.length >= 2) {
        routeLayer.addLayer(L.polyline(r.polyline, { color: r.color, weight: 4, opacity: 0.9, lineJoin: "round" }).bindTooltip(`${r.line}${r.direction ? ` → ${r.direction}` : ""}`, { sticky: true }));
        points.push(...r.polyline);
      }
      for (const s of r.stopovers) {
        if (s.lat == null || s.lon == null) continue;
        const time = fmtTime(s.departure ?? s.arrival, locale);
        routeLayer.addLayer(L.circleMarker([s.lat, s.lon], { radius: 3.5, color: r.color, fillColor: dark ? "#111" : "#fff", fillOpacity: 1, weight: 2, opacity: s.cancelled ? 0.4 : 1 }).bindTooltip(`${s.name}${time ? ` · ${time}` : ""}`, { direction: "top", offset: [0, -4] }));
        points.push([s.lat, s.lon]);
      }
    }
    if (stop.lat != null && stop.lon != null) {
      const here: LatLon = [stop.lat, stop.lon];
      // leaflet puts this straight into an svg `fill` attribute, where css variables are not allowed
      const accent = (el.current && getComputedStyle(el.current).getPropertyValue("--accent").trim()) || "#e33";
      stopLayer.addLayer(L.circleMarker(here, { radius: 8, color: dark ? "#fff" : "#111", fillColor: accent, fillOpacity: 1, weight: 2 }).bindTooltip(stop.name, { permanent: routes.length === 0, direction: "top", offset: [0, -8] }));
      points.push(here);
    }
    if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [24, 24], maxZoom: 15 });
    else if (points.length === 1) map.setView(points[0]!, 15);
    else map.setView([51.1, 10.4], 5);
    setTimeout(() => mapRef.current?.map.invalidateSize(), 0);
  }, [routes, stop, state, dark, locale]);

  // the dashboard resizes widgets; keep leaflet in sync
  useEffect(() => {
    if (!el.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => mapRef.current?.map.invalidateSize());
    ro.observe(el.current);
    return () => ro.disconnect();
  }, []);

  if (state === "failed") {
    return (
      <div className="soft" style={{ height, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, border: "1px dashed var(--line)", fontSize: 12, padding: 8, textAlign: "center" }}>
        <Icon name="map-pin" size={12} /> {t("map.unavailable")}
      </div>
    );
  }
  return (
    <div style={{ position: "relative", height, isolation: "isolate", zIndex: 0, border: "1px solid var(--line)", background: "var(--paper-2)" }}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} />
      {state === "loading" ? <span className="soft pixel" style={{ position: "absolute", left: 8, top: 6, fontSize: 11 }}>{t("map.loading")}</span> : null}
    </div>
  );
}

/* ---------- routes on demand ---------- */

type RouteState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; route: TripRoute };

function useRoutes(stopId: string | undefined) {
  const api = useModuleApi();
  const [routes, setRoutes] = useState<Record<string, RouteState>>({});
  useEffect(() => setRoutes({}), [stopId]);
  const toggle = useCallback(
    (d: Departure) => {
      setRoutes((cur) => {
        if (cur[d.tripId]) {
          const next = { ...cur };
          delete next[d.tripId];
          return next;
        }
        void api<TripRoute>(`/trip?id=${encodeURIComponent(d.tripId)}&line=${encodeURIComponent(d.line)}`)
          .then((route) => setRoutes((c) => (c[d.tripId] ? { ...c, [d.tripId]: { status: "ok", route: { ...route, color: d.color || route.color } } } : c)))
          .catch((err: Error) => setRoutes((c) => (c[d.tripId] ? { ...c, [d.tripId]: { status: "error", message: err.message } } : c)));
        return { ...cur, [d.tripId]: { status: "loading" } };
      });
    },
    [api],
  );
  const clear = useCallback(() => setRoutes({}), []);
  const drawn = useMemo(() => Object.values(routes).flatMap((r) => (r.status === "ok" ? [r.route] : [])), [routes]);
  return { routes, drawn, toggle, clear };
}

/* ---------- stop search ---------- */

type Near = { at: LatLon; label: string };

/** stop search with debounce, place line, and a "near me" button; used in the widget config and on the page */
function StopSearch({ onPick, initial, autoFocus }: { onPick: (s: Stop) => void; initial?: string; autoFocus?: boolean }) {
  const api = useModuleApi();
  const t = useT();
  const { locale, settings } = useModule();
  const homeCountry = settings.provider === "oebb" ? "at" : "de";
  const [q, setQ] = useState(initial ?? "");
  const [res, setRes] = useState<Stop[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [near, setNear] = useState<Near | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seq = useRef(0);

  const search = useCallback(
    async (query: string, at: LatLon | null) => {
      const id = ++seq.current;
      setBusy(true);
      try {
        const qs = new URLSearchParams();
        if (query.length >= 2) qs.set("q", query);
        if (at) qs.set("near", `${at[0].toFixed(5)},${at[1].toFixed(5)}`);
        const stops = await api<Stop[]>(`/stops?${qs}`);
        if (id !== seq.current) return;
        setRes(stops);
        setOpen(true);
        setNote(stops.length ? null : t("search.noResults"));
        // places the server could not wait for: fill them in one by one (its nominatim queue is serial anyway)
        for (const s of stops.slice(0, 8)) {
          if (s.place !== undefined || s.lat == null || s.lon == null) continue;
          try {
            const r = await api<{ place?: Place | null; pending?: boolean }>(`/place?lat=${s.lat}&lon=${s.lon}`);
            if (id !== seq.current) return;
            if (r.place !== undefined) setRes((cur) => cur.map((x) => (x.id === s.id ? { ...x, place: r.place } : x)));
          } catch {
            /* keep the row without a place */
          }
        }
      } catch (err) {
        if (id !== seq.current) return;
        setRes([]);
        setNote(errorLabel(t, (err as Error).message));
        setOpen(true);
      } finally {
        if (id === seq.current) setBusy(false);
      }
    },
    [api, t],
  );

  useEffect(() => {
    clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2 && !near) {
      setRes([]);
      setNote(null);
      return;
    }
    timer.current = setTimeout(() => void search(query, near?.at ?? null), 350);
    return () => clearTimeout(timer.current);
  }, [q, near, search]);

  const locate = () => {
    if (near) {
      setNear(null);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setNote(t("search.noGeo"));
      setOpen(true);
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoBusy(false);
        setNear({ at: [pos.coords.latitude, pos.coords.longitude], label: t("search.nearby") });
      },
      (err) => {
        setGeoBusy(false);
        setNote(err.code === err.PERMISSION_DENIED ? t("search.geoDenied") : t("search.noGeo"));
        setOpen(true);
      },
      { timeout: 8000, maximumAge: 5 * 60_000 },
    );
  };

  const pick = (s: Stop) => {
    onPick(s);
    setOpen(false);
    setRes([]);
    setQ(s.name);
  };

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Input value={q} autoFocus={autoFocus} onChange={(e) => setQ(e.target.value)} onFocus={() => res.length && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder={t("search.placeholder")} style={{ flex: 1 }} />
        <Button size="sm" aria-pressed={!!near} loading={geoBusy} onClick={locate} title={t("search.nearMe")} style={{ whiteSpace: "nowrap" }}>
          <Icon name="map-pin" size={12} /> {t("search.nearMe")}
        </Button>
        {busy ? <span className="spinner" /> : null}
      </div>
      {open && (res.length || note) ? (
        <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 60, padding: 2, maxHeight: 280, overflow: "auto" }}>
          {near && !q.trim() ? <div className="soft" style={{ fontSize: 10, padding: "4px 8px" }}>{near.label}</div> : null}
          {note && !res.length ? <div className="soft" style={{ fontSize: 12, padding: "6px 8px" }}>{note}</div> : null}
          {res.map((s) => {
            const label = placeLabel(s.place, { homeCountry, locale });
            return (
              <button key={s.id} type="button" className="menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)} style={{ alignItems: "flex-start" }}>
                <Icon name="map-pin" size={12} style={{ marginTop: 3 }} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                  <span className="soft" style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {label || (s.place === undefined && s.lat != null ? "…" : "")}
                    {s.distanceKm != null ? `${label ? " · " : ""}${t("search.distance", { distance: formatKm(s.distanceKm) })}` : ""}
                  </span>
                </span>
                {s.products.length ? (
                  <span style={{ display: "flex", gap: 3, marginTop: 2, flexShrink: 0 }}>
                    {s.products.slice(0, 3).map((p) => <Chip key={p} style={{ fontSize: 9, padding: "0 4px", lineHeight: "14px" }}>{productName(t, p)}</Chip>)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- board ---------- */

function useBoard(stopId: string | undefined, refreshMs = 60_000) {
  return useModuleQuery<Board | { error: string; retryAt?: string }>(`/departures/${encodeURIComponent(stopId ?? "")}`, { enabled: !!stopId, intervalMs: refreshMs });
}

function filterDeps(deps: Departure[], cfg: Config, now: number) {
  return deps
    .filter((d) => !cfg.lines?.length || cfg.lines.map((l) => l.toLowerCase()).includes(d.line.toLowerCase()))
    .filter((d) => !cfg.products?.length || cfg.products.includes(d.product))
    .filter((d) => {
      const m = minsUntil(d.when ?? d.plannedWhen, now);
      return m !== null && m >= (cfg.walkMinutes ?? 0) - 0.5;
    })
    .slice(0, cfg.count ?? 6);
}

function DepRow({ d, now, dense, route, onToggle }: { d: Departure; now: number; dense?: boolean; route?: RouteState; onToggle?: (d: Departure) => void }) {
  const t = useT();
  const m = minsUntil(d.when ?? d.plannedWhen, now);
  const clickable = !!onToggle;
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onToggle(d) : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(d); } } : undefined}
      aria-pressed={clickable ? !!route : undefined}
      title={clickable ? t("map.route") : undefined}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: dense ? "2px 0" : "5px 0", borderBottom: "1px dashed var(--line)", opacity: d.cancelled ? 0.5 : 1, background: route ? "var(--paper-2)" : undefined, cursor: clickable ? "pointer" : undefined }}
    >
      <span className="pixel" style={{ minWidth: 34, fontSize: dense ? 12 : 14, textAlign: "center", border: "1.5px solid var(--line)", borderLeft: `4px solid ${d.color}`, padding: "0 4px", background: "var(--paper-2)" }}>{d.line}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: dense ? 12 : 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: d.cancelled ? "line-through" : undefined }}>{d.direction}</div>
        {!dense ? (
          <div className="soft" style={{ fontSize: 10, display: "flex", gap: 8 }}>
            {d.platform ? <span>{t("platform", { platform: d.platform })}</span> : null}
            {d.cancelled ? <span style={{ color: "var(--dnd)" }}>{t("cancelled")}</span> : null}
            {route?.status === "loading" ? <span>{t("map.routeLoading")}</span> : route?.status === "error" ? <span style={{ color: "var(--dnd)" }}>{t("map.routeError")}</span> : route?.status === "ok" ? <span style={{ color: route.route.color }}>● {t("map.stops", { count: route.route.stopovers.length })}</span> : null}
          </div>
        ) : null}
      </div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        <div style={{ fontSize: dense ? 13 : 15, fontWeight: 600, color: d.cancelled ? "var(--dnd)" : m !== null && m <= 1 ? "var(--accent)" : undefined }}>{d.cancelled ? "✕" : m === null ? "–" : m <= 0 ? t("now") : `${m}'`}</div>
        {d.delayMin ? <div style={{ fontSize: 10, color: d.delayMin > 0 ? "var(--dnd)" : "var(--ok)" }}>{dense ? (d.delayMin > 0 ? `+${d.delayMin}` : d.delayMin) : d.delayMin > 0 ? t("delay", { count: d.delayMin }) : t("early", { count: d.delayMin })}</div> : null}
      </div>
    </div>
  );
}

/* ---------- widget ---------- */

function DeparturesWidget({ config, size, instance }: WidgetProps<Config>) {
  const t = useT();
  const q = useBoard(config.stopId);
  const now = useNow(15_000);
  const errorText = useErrorText();
  const withMap = !!config.showMap && instance.w >= MAP_MIN_COLS;
  const { routes, drawn, toggle } = useRoutes(withMap ? config.stopId : undefined);
  const stop = useMemo<Stop | null>(() => {
    if (!config.stopId) return null;
    const loc = instance.config as { stopLat?: number; stopLon?: number };
    return { id: config.stopId, name: config.stopName ?? config.stopId, lat: loc.stopLat ?? null, lon: loc.stopLon ?? null, products: [] };
  }, [config.stopId, config.stopName, instance.config]);
  if (!config.stopId) return <Empty icon="bus" title={t("widget.pickStop")}>{t("widget.configureHint")}</Empty>;
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("loading")}</span>;
  if (!q.data || "error" in q.data) return <Empty icon="warning-diamond" title={t("noData")}>{errorText(q.error as QueryError, q.data)}</Empty>;
  const deps = filterDeps(q.data.departures, config, now);
  const dense = size.height < 160;
  const list = (
    <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
      {deps.length === 0 ? <div className="soft" style={{ fontSize: 12 }}>{t("nothingSoon")}</div> : deps.map((d) => <DepRow key={d.tripId} d={d} now={now} dense={dense} route={withMap ? routes[d.tripId] : undefined} onToggle={withMap ? toggle : undefined} />)}
    </div>
  );
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="soft" style={{ fontSize: 11, display: "flex", justifyContent: "space-between" }}>
        <span><Icon name="map-pin" size={10} /> {config.stopName ?? config.stopId}</span>
        {config.walkMinutes ? <span>{t("walk", { count: config.walkMinutes })}</span> : null}
      </div>
      {withMap && stop ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8 }}>
          <div style={{ flex: "1 1 55%", minWidth: 0, display: "flex", flexDirection: "column" }}>{list}</div>
          <div style={{ flex: "1 1 45%", minWidth: 0 }}>
            <RouteMap stop={stop} routes={drawn} height="100%" />
          </div>
        </div>
      ) : (
        list
      )}
    </div>
  );
}

/** widget config with a proper stop search instead of typing ids */
function DeparturesConfig({ value, onChange }: SettingsProps) {
  const t = useT();
  const v = value as Config & { stopLat?: number; stopLon?: number };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label={t("config.stop")} hint={v.stopId ? t("config.selected", { name: v.stopName ?? v.stopId }) : t("config.searchByName")}>
        <StopSearch initial={v.stopName} onPick={(s) => onChange({ ...v, stopId: s.id, stopName: s.name, stopLat: s.lat ?? undefined, stopLon: s.lon ?? undefined })} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label={t("config.departures")}><Input type="number" min={1} max={20} value={v.count ?? 6} onChange={(e) => onChange({ ...v, count: Number(e.target.value) })} /></Field>
        <Field label={t("config.walkMinutes")}><Input type="number" min={0} max={60} value={v.walkMinutes ?? 0} onChange={(e) => onChange({ ...v, walkMinutes: Number(e.target.value) })} /></Field>
      </div>
      <Field label={t("config.lines")} hint={t("config.linesHint")}><Input value={(v.lines ?? []).join(", ")} onChange={(e) => onChange({ ...v, lines: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></Field>
      <Field label={t("config.products")}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PRODUCTS.map((p) => {
            const on = (v.products ?? []).includes(p);
            return <Button key={p} size="sm" aria-pressed={on} onClick={() => onChange({ ...v, products: on ? (v.products ?? []).filter((x) => x !== p) : [...(v.products ?? []), p] })}>{productName(t, p)}</Button>;
          })}
        </div>
      </Field>
      <Field label={t("config.showMap")} hint={t("config.showMapHint")}>
        <Switch checked={!!v.showMap} onChange={(e) => onChange({ ...v, showMap: e.target.checked })} />
      </Field>
    </div>
  );
}

/* ---------- page ---------- */

function DeparturesPage(_p: PageProps) {
  const t = useT();
  const { locale } = useModule();
  const [stop, setStop] = useState<Stop | null>(null);
  const [showMap, setShowMap] = useState(true);
  const q = useBoard(stop?.id, 30_000);
  const now = useNow(10_000);
  const errorText = useErrorText();
  const { routes, drawn, toggle, clear } = useRoutes(stop?.id);
  const board = q.data && !("error" in q.data) ? q.data : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 820 }}>
      <StopSearch onPick={setStop} autoFocus />
      {stop ? (
        <div className="win">
          <div className="win-title">
            <span className="dots"><i /><i /><i /></span>
            <span className="title" style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
              <span>{stop.name}</span>
              {stop.place ? <span className="soft" style={{ fontSize: 10, fontWeight: 400 }}>{placeLabel(stop.place, { locale })}</span> : null}
            </span>
            <span style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto" }}>
              {board ? <Chip style={{ fontSize: 10 }}>{t("updated", { time: new Date(board.fetchedAt).toLocaleTimeString(locale) })}</Chip> : null}
              {drawn.length ? <Button size="sm" onClick={clear}>{t("map.clearRoutes")}</Button> : null}
              <Button size="sm" aria-pressed={showMap} onClick={() => setShowMap((v) => !v)}><Icon name="map" size={12} /> {showMap ? t("map.hide") : t("map.show")}</Button>
            </span>
          </div>
          <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {showMap ? (
              <div>
                <RouteMap stop={stop} routes={drawn} height={320} />
                <div className="soft" style={{ fontSize: 10, marginTop: 4 }}>{t("map.routeHint")}</div>
              </div>
            ) : null}
            <div>
              {q.loading && !q.data ? (
                <span className="soft pixel">{t("loading")}</span>
              ) : !board ? (
                <span style={{ color: "var(--dnd)" }}>{errorText(q.error as QueryError, q.data)}</span>
              ) : board.departures.length === 0 ? (
                <span className="soft">{t("nothingSoon")}</span>
              ) : (
                board.departures.slice(0, 25).map((d) => <DepRow key={d.tripId} d={d} now={now} route={routes[d.tripId]} onToggle={toggle} />)
              )}
            </div>
          </div>
        </div>
      ) : (
        <Empty icon="bus" title={t("page.searchTitle")}>{t("page.searchHint")}</Empty>
      )}
      <p className="soft" style={{ fontSize: 11 }}>{t("page.footer")}</p>
    </div>
  );
}

/* ---------- settings ---------- */

function TransportSettings({ value, onChange }: SettingsProps) {
  const t = useT();
  const providers = useModuleQuery<Array<{ id: string; name: string }>>("/providers");
  /** translated label when we have one (`provider.<id>`), else the server's name */
  const providerLabel = (p: { id: string; name: string }) => {
    const v = t(`provider.${p.id}`);
    return v === `provider.${p.id}` ? p.name : v;
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label={t("settings.provider")}>
        <Select value={String(value.provider ?? "db")} onChange={(e) => onChange({ ...value, provider: e.target.value })}>
          {(providers.data ?? [{ id: "db", name: "Deutsche Bahn" }, { id: "vgn", name: "VGN" }]).map((p) => <option key={p.id} value={p.id}>{providerLabel(p)}</option>)}
        </Select>
      </Field>
      <Field label={t("settings.refresh")}><Input type="number" min={30} max={600} value={Number(value.refreshSeconds ?? 60)} onChange={(e) => onChange({ ...value, refreshSeconds: Number(e.target.value) })} /></Field>
    </div>
  );
}

export default defineClient({
  widgets: { departures: DeparturesWidget },
  pages: { departures: DeparturesPage },
  settings: TransportSettings,
  widgetConfig: { departures: DeparturesConfig },
});
