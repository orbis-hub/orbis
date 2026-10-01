import { useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Bars, BarsLegend, Button, Chip, Empty, Icon, Input, Kbd, useToast } from "@orbis/ui";
import type { Activity, Source, WeekStats } from "./server";

type Status = { strava: { connected: boolean; configured?: boolean; athlete?: string | null; lastSync?: string | null }; units: "metric" | "imperial"; weekStart: string };
type Metric = "distance" | "duration" | "calories" | "count";
type WeekConfig = { metric?: Metric; types?: string[]; compare?: boolean };
type RecentConfig = { count?: number; types?: string[] };

const typeIcon = (t: string) => ({ run: "zap", ride: "wind", swim: "waves", hike: "tree-pine", walk: "human", row: "waves", ski: "snowflake", yoga: "sun", strength: "trophy" }[t] ?? "heart");
const fmtDist = (m: number, imperial: boolean, digits = 1) => (m ? `${(m / (imperial ? 1609.344 : 1000)).toFixed(digits)} ${imperial ? "mi" : "km"}` : "–");
const fmtDur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} h` : `${Math.round(s / 60)} min`);
const fmtPace = (m: number, s: number, type: string, imperial: boolean) => {
  if (!m || !s) return null;
  if (type === "ride") return `${((m / (imperial ? 1609.344 : 1000)) / (s / 3600)).toFixed(1)} ${imperial ? "mph" : "km/h"}`;
  const secPer = s / (m / (imperial ? 1609.344 : 1000));
  return `${Math.floor(secPer / 60)}:${String(Math.round(secPer % 60)).padStart(2, "0")} /${imperial ? "mi" : "km"}`;
};
const fmtMetric = (metric: Metric, v: number, imperial: boolean) => (metric === "distance" ? fmtDist(v, imperial) : metric === "duration" ? fmtDur(v) : metric === "calories" ? `${Math.round(v)} kcal` : `${v}`);
const typesParam = (types?: string[]) => (types?.length ? `?types=${encodeURIComponent(types.join(","))}` : "");

function useStatus() {
  return useModuleQuery<Status>("/status", { refetchOn: ["changed"] });
}

function WeekWidget({ config, size }: WidgetProps<WeekConfig>) {
  const st = useStatus().data;
  const q = useModuleQuery<WeekStats>(`/week${typesParam(config.types)}`, { refetchOn: ["changed"], intervalMs: 5 * 60_000 });
  const metric = config.metric ?? "distance";
  const imperial = st?.units === "imperial";
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  const w = q.data;
  if (!w) return <Empty icon="heart" title="no data" />;
  if (!w.totals.thisWeek.count && !w.totals.lastWeek.count) return <Empty icon="heart" title="no workouts yet">connect strava or post to the ingest url on the fitness page.</Empty>;
  const todayIdx = w.days.indexOf(new Date().toLocaleDateString("sv-SE"));
  const series = [{ values: w.thisWeek[metric], label: "this week" }, ...(config.compare !== false ? [{ values: w.lastWeek[metric], label: "last week", dashed: true }] : [])];
  const diff = w.totals.thisWeek[metric] - w.totals.lastWeek[metric];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="pixel" style={{ fontSize: size.height < 150 ? 16 : 20, fontWeight: 600 }}>{fmtMetric(metric, w.totals.thisWeek[metric], imperial)}</span>
        {config.compare !== false && w.totals.lastWeek[metric] ? <span className="soft" style={{ fontSize: 10, color: diff >= 0 ? "var(--ok)" : undefined }}>{diff >= 0 ? "+" : "−"}{fmtMetric(metric, Math.abs(diff), imperial)} vs last week</span> : null}
      </div>
      <Bars series={series} labels={w.days.map((d) => new Date(d).toLocaleDateString(undefined, { weekday: "narrow" }))} highlight={todayIdx} height={Math.max(30, size.height - 70)} format={(v) => fmtMetric(metric, v, imperial)} />
    </div>
  );
}

function ActivityRow({ a, imperial, dense, onDelete }: { a: Activity; imperial: boolean; dense?: boolean; onDelete?: () => void }) {
  const pace = fmtPace(a.distance_m, a.duration_s, a.type, imperial);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: dense ? "3px 0" : "6px 0", borderBottom: "1px dashed var(--line)" }}>
      <Icon name={typeIcon(a.type)} size={dense ? 12 : 16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: dense ? 12 : 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name ?? a.type}</div>
        <div className="soft" style={{ fontSize: 10 }}>{new Date(a.start).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · {a.type}{a.source !== "strava" ? ` · ${a.source}` : ""}</div>
      </div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        <div style={{ fontSize: dense ? 12 : 14, fontWeight: 600 }}>{a.distance_m ? fmtDist(a.distance_m, imperial) : fmtDur(a.duration_s)}</div>
        <div className="soft" style={{ fontSize: 10 }}>{a.distance_m ? fmtDur(a.duration_s) : a.calories ? `${Math.round(a.calories)} kcal` : ""}{pace ? ` · ${pace}` : ""}</div>
      </div>
      {onDelete ? <Button size="sm" variant="ghost" onClick={onDelete} aria-label="delete"><Icon name="trash" size={12} /></Button> : null}
    </div>
  );
}

function RecentWidget({ config, size }: WidgetProps<RecentConfig>) {
  const st = useStatus().data;
  const q = useModuleQuery<Activity[]>(`/activities?limit=${config.count ?? 5}${config.types?.length ? `&types=${encodeURIComponent(config.types.join(","))}` : ""}`, { refetchOn: ["changed"] });
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  if (!q.data?.length) return <Empty icon="heart" title="no workouts yet" />;
  return <div className="scroll-y" style={{ height: "100%" }}>{q.data.map((a) => <ActivityRow key={a.id} a={a} imperial={st?.units === "imperial"} dense={size.height < 200} />)}</div>;
}

function FitnessPage(_p: PageProps) {
  const api = useModuleApi();
  const toast = useToast();
  const { hubUrl, token } = useModule();
  const st = useStatus();
  const week = useModuleQuery<WeekStats>("/week", { refetchOn: ["changed"] });
  const acts = useModuleQuery<Activity[]>("/activities?limit=60", { refetchOn: ["changed"] });
  const sources = useModuleQuery<Source[]>("/sources", { refetchOn: ["changed"] });
  const [newSrc, setNewSrc] = useState("");
  const [metric, setMetric] = useState<Metric>("distance");
  const [showSecret, setShowSecret] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const imperial = st.data?.units === "imperial";
  const base = hubUrl.replace(/\/$/, "");
  const loginHref = `${base}/api/m/fitness/strava/login?return=${encodeURIComponent(window.location.href)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  const sync = async (full = false) => {
    setSyncing(true);
    try {
      const r = await api<{ added?: number; seen?: number; error?: string }>(`/strava/sync${full ? "?full=1" : ""}`, { method: "POST" });
      toast(r.error ?? `synced: ${r.added} new of ${r.seen}`, r.error ? "bad" : undefined);
    } finally {
      setSyncing(false);
    }
  };
  const addSource = async () => {
    const s = await api<Source>("/sources", { method: "POST", json: { name: newSrc || "apple health" } });
    setNewSrc("");
    setShowSecret(s.id);
  };
  const w = week.data;
  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", alignItems: "start" }}>
      <div className="win" style={{ gridColumn: "1 / -1" }}>
        <div className="win-title">
          <span className="dots"><i /><i /><i /></span><span className="title">this week vs last</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {(["distance", "duration", "calories", "count"] as Metric[]).map((m) => <Button key={m} size="sm" variant={metric === m ? "primary" : "default"} onClick={() => setMetric(m)}>{m === "duration" ? "time" : m === "count" ? "workouts" : m}</Button>)}
          </span>
        </div>
        <div className="win-body">
          {w ? (
            <>
              <div style={{ display: "flex", gap: 24, marginBottom: 8, flexWrap: "wrap" }}>
                <Stat label="this week" value={fmtMetric(metric, w.totals.thisWeek[metric], imperial)} />
                <Stat label="last week" value={fmtMetric(metric, w.totals.lastWeek[metric], imperial)} soft />
                <Stat label="workouts" value={`${w.totals.thisWeek.count}`} soft />
                <Stat label="time" value={fmtDur(w.totals.thisWeek.duration)} soft />
              </div>
              <Bars height={120} series={[{ values: w.thisWeek[metric], label: "this week" }, { values: w.lastWeek[metric], label: "last week", dashed: true }]} labels={w.days.map((d) => new Date(d).toLocaleDateString(undefined, { weekday: "short" }))} highlight={w.days.indexOf(new Date().toLocaleDateString("sv-SE"))} showValues format={(v) => fmtMetric(metric, v, imperial)} footer={<BarsLegend series={[{ label: "this week" }, { label: "last week", dashed: true }]} />} />
            </>
          ) : <span className="soft pixel">loading…</span>}
        </div>
      </div>

      <div className="win">
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">strava</span>{st.data?.strava.connected ? <Chip tone="ok" style={{ marginLeft: "auto", fontSize: 10 }}>connected</Chip> : null}</div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
          {st.data?.strava.connected ? (
            <>
              <div>{st.data.strava.athlete ? <>logged in as <b>{st.data.strava.athlete}</b>. </> : null}<span className="soft">last sync {st.data.strava.lastSync ? new Date(st.data.strava.lastSync).toLocaleTimeString() : "never"}</span></div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Button size="sm" loading={syncing} onClick={() => void sync(false)}><Icon name="reload" size={12} /> sync now</Button>
                <Button size="sm" variant="ghost" loading={syncing} onClick={() => void sync(true)}>pull last 12 months</Button>
                <Button size="sm" variant="ghost" onClick={() => void api("/strava/logout", { method: "POST" })}>disconnect</Button>
              </div>
            </>
          ) : st.data?.strava.configured ? (
            <>
              <div>client id + secret are set. connect your account to pull activities (read-only scope).</div>
              <a className="btn btn-primary btn-sm" href={loginHref} style={{ alignSelf: "flex-start" }}><Icon name="external-link" size={12} /> connect strava</a>
            </>
          ) : (
            <div className="soft">
              create an api application at <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer">strava.com/settings/api</a>, set the <b>authorization callback domain</b> to your hub's host (just the hostname, e.g. <code>192.168.1.20</code> or <code>orbis.local</code>), then paste client id + secret into the module settings.
            </div>
          )}
        </div>
      </div>

      <div className="win">
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">ingest sources</span></div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
          <div className="soft">anything that can do an http post can log a workout here: an apple shortcut, health auto export, a garmin script. one secret per source.</div>
          {sources.data?.map((s) => (
            <div key={s.id} className="win" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <b>{s.name}</b>
                <span className="soft" style={{ fontSize: 10 }}>{s.count} workouts{s.last_at ? ` · last ${new Date(s.last_at).toLocaleString()}` : ""}</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                  <Button size="sm" variant="ghost" onClick={() => setShowSecret(showSecret === s.id ? null : s.id)}>{showSecret === s.id ? "hide" : "show setup"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void api(`/sources/${s.id}/rotate`, { method: "POST" }).then(() => toast("new secret generated"))} title="rotate secret"><Icon name="reload" size={12} /></Button>
                  <Button size="sm" variant="ghost" onClick={() => void api(`/sources/${s.id}`, { method: "DELETE" })} aria-label="delete"><Icon name="trash" size={12} /></Button>
                </span>
              </div>
              {showSecret === s.id ? (
                <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div><span className="soft">url</span><br /><code style={{ userSelect: "all", wordBreak: "break-all" }}>{base}/api/m/fitness/ingest/{s.id}</code></div>
                  <div><span className="soft">header</span><br /><code style={{ userSelect: "all", wordBreak: "break-all" }}>Authorization: Bearer {s.secret}</code></div>
                  <div className="soft">body: json with <code>type</code>, <code>start</code> (iso), <code>duration</code> (min) or <code>duration_s</code>, <code>distance</code> (m) or <code>distanceKm</code>, <code>calories</code>, optional <code>id</code> so re-posts don't duplicate. an array of those works too.</div>
                  <div className="soft">
                    <b>apple health shortcut:</b> <Kbd>Find Workouts</Kbd> (sort by start date, limit 20) → <Kbd>Repeat with Each</Kbd> → <Kbd>Get Contents of URL</Kbd> with method POST, header above, request body json: type = Workout Type, start = Start Date, end = End Date, distanceKm = Distance, calories = Active Energy, id = Repeat Item (as text). run it by hand or as a daily automation.
                  </div>
                  <pre className="win" style={{ fontSize: 11, padding: 8, overflow: "auto", margin: 0 }}>{`curl -X POST ${base}/api/m/fitness/ingest/${s.id} \\
  -H "Authorization: Bearer ${s.secret}" -H "content-type: application/json" \\
  -d '{"type":"run","start":"${new Date().toISOString()}","duration":32,"distanceKm":5.2,"calories":340}'`}</pre>
                </div>
              ) : null}
            </div>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); void addSource(); }} style={{ display: "flex", gap: 6 }}>
            <Input value={newSrc} onChange={(e) => setNewSrc(e.target.value)} placeholder="source name, e.g. apple health" />
            <Button type="submit" size="sm"><Icon name="plus" size={12} /> add source</Button>
          </form>
        </div>
      </div>

      <div className="win" style={{ gridColumn: "1 / -1" }}>
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">activities ({acts.data?.length ?? 0})</span></div>
        <div className="win-body">
          {!acts.data?.length ? <span className="soft" style={{ fontSize: 12 }}>nothing yet.</span> : acts.data.map((a) => <ActivityRow key={a.id} a={a} imperial={imperial} onDelete={() => void api(`/activities/${a.id}`, { method: "DELETE" })} />)}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, soft }: { label: string; value: string; soft?: boolean }) {
  return (
    <div>
      <div className="soft" style={{ fontSize: 10 }}>{label}</div>
      <div className="pixel" style={{ fontSize: soft ? 16 : 22, opacity: soft ? 0.8 : 1 }}>{value}</div>
    </div>
  );
}

export default defineClient({
  widgets: { week: WeekWidget, recent: RecentWidget },
  pages: { fitness: FitnessPage },
});
