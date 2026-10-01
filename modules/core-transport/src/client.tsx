import { useEffect, useRef, useState } from "react";
import { defineClient, useModuleApi, useModuleQuery, type PageProps, type SettingsProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Select } from "@orbis/ui";
import type { Departure, Stop } from "./server";

type Config = { stopId?: string; stopName?: string; count?: number; lines?: string[]; walkMinutes?: number; products?: string[] };
type Board = { stopId: string; departures: Departure[]; fetchedAt: string };

const minsUntil = (iso: string | null, now: number) => (iso ? Math.round((new Date(iso).getTime() - now) / 60_000) : null);

/** stop search with debounce, used in the widget config and on the page */
function StopSearch({ onPick, initial }: { onPick: (s: Stop) => void; initial?: string }) {
  const api = useModuleApi();
  const [q, setQ] = useState(initial ?? "");
  const [res, setRes] = useState<Stop[]>([]);
  const [busy, setBusy] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(t.current);
    if (q.trim().length < 2) {
      setRes([]);
      return;
    }
    t.current = setTimeout(async () => {
      setBusy(true);
      try {
        setRes(await api<Stop[]>(`/stops?q=${encodeURIComponent(q.trim())}`));
      } catch {
        setRes([]);
      } finally {
        setBusy(false);
      }
    }, 350);
  }, [q, api]);
  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="stop name, e.g. Würzburg Hbf" />
        {busy ? <span className="spinner" /> : null}
      </div>
      {res.length ? (
        <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 60, padding: 2, maxHeight: 220, overflow: "auto" }}>
          {res.map((s) => (
            <button key={s.id} type="button" className="menu-item" onClick={() => { onPick(s); setRes([]); setQ(s.name); }}>
              <Icon name="map-pin" size={12} />
              <span style={{ flex: 1 }}>{s.name}</span>
              <span className="soft" style={{ fontSize: 10 }}>{s.products.slice(0, 3).join(" ")}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function useBoard(stopId: string | undefined, refreshMs = 60_000) {
  return useModuleQuery<Board | { error: string }>(`/departures/${encodeURIComponent(stopId ?? "")}`, { enabled: !!stopId, intervalMs: refreshMs });
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

function DepRow({ d, now, dense }: { d: Departure; now: number; dense?: boolean }) {
  const m = minsUntil(d.when ?? d.plannedWhen, now);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: dense ? "2px 0" : "5px 0", borderBottom: "1px dashed var(--line)", opacity: d.cancelled ? 0.5 : 1 }}>
      <span className="pixel" style={{ minWidth: 34, fontSize: dense ? 12 : 14, textAlign: "center", border: "1.5px solid var(--line)", padding: "0 4px", background: "var(--paper-2)" }}>{d.line}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: dense ? 12 : 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: d.cancelled ? "line-through" : undefined }}>{d.direction}</div>
        {!dense && d.platform ? <div className="soft" style={{ fontSize: 10 }}>platform {d.platform}</div> : null}
      </div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        <div style={{ fontSize: dense ? 13 : 15, fontWeight: 600, color: d.cancelled ? "var(--dnd)" : m !== null && m <= 1 ? "var(--accent)" : undefined }}>{d.cancelled ? "✕" : m === null ? "–" : m <= 0 ? "now" : `${m}'`}</div>
        {d.delayMin ? <div style={{ fontSize: 10, color: d.delayMin > 0 ? "var(--dnd)" : "var(--ok)" }}>{d.delayMin > 0 ? `+${d.delayMin}` : d.delayMin}</div> : null}
      </div>
    </div>
  );
}

function DeparturesWidget({ config, size }: WidgetProps<Config>) {
  const q = useBoard(config.stopId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!config.stopId) return <Empty icon="bus" title="pick a stop">⋯ → configure</Empty>;
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  if (!q.data || "error" in q.data) return <Empty icon="warning-diamond" title="no data">{(q.data as { error?: string } | undefined)?.error ?? q.error?.message}</Empty>;
  const deps = filterDeps(q.data.departures, config, now);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="soft" style={{ fontSize: 11, display: "flex", justifyContent: "space-between" }}>
        <span><Icon name="map-pin" size={10} /> {config.stopName ?? config.stopId}</span>
        {config.walkMinutes ? <span>{config.walkMinutes} min walk</span> : null}
      </div>
      <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {deps.length === 0 ? <div className="soft" style={{ fontSize: 12 }}>nothing in the next hour</div> : deps.map((d) => <DepRow key={d.tripId} d={d} now={now} dense={size.height < 160} />)}
      </div>
    </div>
  );
}

/** widget config with a proper stop search instead of typing ids */
function DeparturesConfig({ value, onChange }: SettingsProps) {
  const v = value as Config;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="stop" hint={v.stopId ? `selected: ${v.stopName ?? v.stopId}` : "search by name"}>
        <StopSearch initial={v.stopName} onPick={(s) => onChange({ ...v, stopId: s.id, stopName: s.name })} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="departures"><Input type="number" min={1} max={20} value={v.count ?? 6} onChange={(e) => onChange({ ...v, count: Number(e.target.value) })} /></Field>
        <Field label="minutes to walk"><Input type="number" min={0} max={60} value={v.walkMinutes ?? 0} onChange={(e) => onChange({ ...v, walkMinutes: Number(e.target.value) })} /></Field>
      </div>
      <Field label="only these lines" hint="comma separated, e.g. 6, 14, S1"><Input value={(v.lines ?? []).join(", ")} onChange={(e) => onChange({ ...v, lines: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></Field>
      <Field label="products">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["bus", "tram", "subway", "suburban", "regional", "national"].map((p) => {
            const on = (v.products ?? []).includes(p);
            return <Button key={p} size="sm" aria-pressed={on} onClick={() => onChange({ ...v, products: on ? (v.products ?? []).filter((x) => x !== p) : [...(v.products ?? []), p] })}>{p}</Button>;
          })}
        </div>
      </Field>
    </div>
  );
}

function DeparturesPage(_p: PageProps) {
  const [stop, setStop] = useState<Stop | null>(null);
  const q = useBoard(stop?.id, 30_000);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
      <StopSearch onPick={setStop} />
      {stop ? (
        <div className="win">
          <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">{stop.name}</span>{q.data && !("error" in q.data) ? <Chip style={{ fontSize: 10 }}>updated {new Date(q.data.fetchedAt).toLocaleTimeString()}</Chip> : null}</div>
          <div className="win-body">
            {q.loading && !q.data ? <span className="soft pixel">loading…</span> : !q.data || "error" in q.data ? <span style={{ color: "var(--dnd)" }}>{(q.data as { error?: string } | undefined)?.error}</span> : q.data.departures.length === 0 ? <span className="soft">nothing in the next hour</span> : q.data.departures.slice(0, 25).map((d) => <DepRow key={d.tripId} d={d} now={now} />)}
          </div>
        </div>
      ) : (
        <Empty icon="bus" title="search a stop">then add it as a widget with the stop search in the widget config.</Empty>
      )}
      <p className="soft" style={{ fontSize: 11 }}>data from the public transport.rest apis (hafas). germany-wide via db, plus vbb/bvg/öbb under module settings. be nice to the api: the hub caches every board for a minute.</p>
    </div>
  );
}

function TransportSettings({ value, onChange }: SettingsProps) {
  const providers = useModuleQuery<Array<{ id: string; name: string }>>("/providers");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="provider">
        <Select value={String(value.provider ?? "db")} onChange={(e) => onChange({ ...value, provider: e.target.value })}>
          {(providers.data ?? [{ id: "db", name: "Deutsche Bahn" }]).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </Field>
      <Field label="refresh every (seconds)"><Input type="number" min={30} max={600} value={Number(value.refreshSeconds ?? 60)} onChange={(e) => onChange({ ...value, refreshSeconds: Number(e.target.value) })} /></Field>
    </div>
  );
}

export default defineClient({
  widgets: { departures: DeparturesWidget },
  pages: { departures: DeparturesPage },
  settings: TransportSettings,
  widgetConfig: { departures: DeparturesConfig },
});
