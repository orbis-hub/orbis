import { useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Bars, BarsLegend, Button, Chip, Empty, Icon, Input, Kbd, useToast } from "@orbis/ui";
import type { Activity, Source, WeekStats } from "./server";

type Status = { strava: { connected: boolean; configured?: boolean; athlete?: string | null; lastSync?: string | null }; units: "metric" | "imperial"; weekStart: string };
type Metric = "distance" | "duration" | "calories" | "count";
type WeekConfig = { metric?: Metric; types?: string[]; compare?: boolean };
type RecentConfig = { count?: number; types?: string[] };

const METRICS: Metric[] = ["distance", "duration", "calories", "count"];
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
  const t = useT();
  const { locale } = useModule();
  const st = useStatus().data;
  const q = useModuleQuery<WeekStats>(`/week${typesParam(config.types)}`, { refetchOn: ["changed"], intervalMs: 5 * 60_000 });
  const metric = config.metric ?? "distance";
  const imperial = st?.units === "imperial";
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("loading")}</span>;
  const w = q.data;
  if (!w) return <Empty icon="heart" title={t("widget.week.noData")} />;
  if (!w.totals.thisWeek.count && !w.totals.lastWeek.count) return <Empty icon="heart" title={t("widget.week.empty")}>{t("widget.week.emptyHint")}</Empty>;
  const todayIdx = w.days.indexOf(new Date().toLocaleDateString("sv-SE"));
  const series = [{ values: w.thisWeek[metric], label: t("series.thisWeek") }, ...(config.compare !== false ? [{ values: w.lastWeek[metric], label: t("series.lastWeek"), dashed: true }] : [])];
  const diff = w.totals.thisWeek[metric] - w.totals.lastWeek[metric];
  const vs = config.compare !== false && w.totals.lastWeek[metric] ? t("week.vsLastWeek", { diff: `${diff >= 0 ? "+" : "−"}${fmtMetric(metric, Math.abs(diff), imperial)}` }) : null;
  // size is 0×0 until the frame has measured itself; until then assume the 3×3 default (≈140px high)
  const h = size.height > 0 ? size.height : 140;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4, minWidth: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <span className="pixel" style={{ fontSize: h < 150 ? 16 : 20, fontWeight: 600, whiteSpace: "nowrap", flex: "none" }}>{fmtMetric(metric, w.totals.thisWeek[metric], imperial)}</span>
        {vs ? <span className="soft" style={{ fontSize: "var(--fs-meta)", color: diff >= 0 ? "var(--ok-ink)" : undefined, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={vs}>{vs}</span> : null}
      </div>
      {/* the bars take what is left under the number line (≈24px) and above the weekday labels (≈19px) */}
      <Bars series={series} labels={w.days.map((d) => new Date(d).toLocaleDateString(locale, { weekday: "narrow" }))} highlight={todayIdx} height={Math.max(30, h - 70)} format={(v) => fmtMetric(metric, v, imperial)} />
    </div>
  );
}

function ActivityRow({ a, imperial, dense, onDelete }: { a: Activity; imperial: boolean; dense?: boolean; onDelete?: () => void }) {
  const t = useT();
  const { locale } = useModule();
  const pace = fmtPace(a.distance_m, a.duration_s, a.type, imperial);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: dense ? "3px 0" : "6px 0", borderBottom: "1px dashed var(--line)", minWidth: 0 }}>
      <Icon name={typeIcon(a.type)} size={dense ? 12 : 16} style={{ flex: "none" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: dense ? 12 : 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.name ?? a.type}>{a.name ?? a.type}</div>
        <div className="soft" style={{ fontSize: "var(--fs-meta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{new Date(a.start).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })} · {a.type}{a.source !== "strava" ? ` · ${a.source}` : ""}</div>
      </div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", flex: "none", whiteSpace: "nowrap" }}>
        <div style={{ fontSize: dense ? 12 : 14, fontWeight: 600 }}>{a.distance_m ? fmtDist(a.distance_m, imperial) : fmtDur(a.duration_s)}</div>
        <div className="soft" style={{ fontSize: "var(--fs-meta)" }}>{a.distance_m ? fmtDur(a.duration_s) : a.calories ? `${Math.round(a.calories)} kcal` : ""}{pace ? ` · ${pace}` : ""}</div>
      </div>
      {onDelete ? <Button size="sm" variant="ghost" onClick={onDelete} aria-label={t("action.delete")}><Icon name="trash" size={12} /></Button> : null}
    </div>
  );
}

function RecentWidget({ config, size }: WidgetProps<RecentConfig>) {
  const t = useT();
  const st = useStatus().data;
  const q = useModuleQuery<Activity[]>(`/activities?limit=${config.count ?? 5}${config.types?.length ? `&types=${encodeURIComponent(config.types.join(","))}` : ""}`, { refetchOn: ["changed"] });
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("loading")}</span>;
  if (!q.data?.length) return <Empty icon="heart" title={t("widget.recent.empty")} />;
  return <div className="scroll-y" style={{ height: "100%", overflowX: "hidden", minWidth: 0 }}>{q.data.map((a) => <ActivityRow key={a.id} a={a} imperial={st?.units === "imperial"} dense={size.height < 200} />)}</div>;
}

function FitnessPage(_p: PageProps) {
  const t = useT();
  const api = useModuleApi();
  const toast = useToast();
  const { hubUrl, token, locale } = useModule();
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
      toast(r.error ?? t("toast.synced", { added: r.added ?? 0, seen: r.seen ?? 0 }), r.error ? "bad" : undefined);
    } finally {
      setSyncing(false);
    }
  };
  // secrets come back once on create / rotate (and in the list for admins); members only ever see the hint
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const remember = (s: Source) => s.secret && setSecrets((m) => ({ ...m, [s.id]: s.secret! }));
  const addSource = async () => {
    try {
      const s = await api<Source>("/sources", { method: "POST", json: { name: newSrc || "apple health" } });
      remember(s);
      setNewSrc("");
      setShowSecret(s.id);
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };
  const rotate = async (id: string) => {
    try {
      remember(await api<Source>(`/sources/${id}/rotate`, { method: "POST" }));
      toast(t("toast.newSecret"));
      setShowSecret(id);
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };
  const remove = async (id: string) => {
    try {
      await api(`/sources/${id}`, { method: "DELETE" });
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };
  const w = week.data;
  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", alignItems: "start" }}>
      <div className="win" style={{ gridColumn: "1 / -1" }}>
        <div className="win-title">
          <span className="dots"><i /><i /><i /></span><span className="title">{t("page.weekTitle")}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {METRICS.map((m) => <Button key={m} size="sm" variant={metric === m ? "primary" : "default"} onClick={() => setMetric(m)}>{t(`metric.${m}`)}</Button>)}
          </span>
        </div>
        <div className="win-body">
          {w ? (
            <>
              <div style={{ display: "flex", gap: 24, marginBottom: 8, flexWrap: "wrap" }}>
                <Stat label={t("stat.thisWeek")} value={fmtMetric(metric, w.totals.thisWeek[metric], imperial)} />
                <Stat label={t("stat.lastWeek")} value={fmtMetric(metric, w.totals.lastWeek[metric], imperial)} soft />
                <Stat label={t("stat.workouts")} value={`${w.totals.thisWeek.count}`} soft />
                <Stat label={t("stat.time")} value={fmtDur(w.totals.thisWeek.duration)} soft />
              </div>
              <Bars height={120} series={[{ values: w.thisWeek[metric], label: t("series.thisWeek") }, { values: w.lastWeek[metric], label: t("series.lastWeek"), dashed: true }]} labels={w.days.map((d) => new Date(d).toLocaleDateString(locale, { weekday: "short" }))} highlight={w.days.indexOf(new Date().toLocaleDateString("sv-SE"))} showValues format={(v) => fmtMetric(metric, v, imperial)} footer={<BarsLegend series={[{ label: t("series.thisWeek") }, { label: t("series.lastWeek"), dashed: true }]} />} />
            </>
          ) : <span className="soft pixel">{t("loading")}</span>}
        </div>
      </div>

      <div className="win">
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">{t("page.strava")}</span>{st.data?.strava.connected ? <Chip tone="ok" style={{ marginLeft: "auto", fontSize: "var(--fs-min)" }}>{t("strava.connected")}</Chip> : null}</div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
          {st.data?.strava.connected ? (
            <>
              <div>{st.data.strava.athlete ? <>{t("strava.loggedInAs")} <b>{st.data.strava.athlete}</b>. </> : null}<span className="soft">{t("strava.lastSync", { time: st.data.strava.lastSync ? new Date(st.data.strava.lastSync).toLocaleTimeString(locale) : t("strava.never") })}</span></div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Button size="sm" loading={syncing} onClick={() => void sync(false)}><Icon name="reload" size={12} /> {t("action.syncNow")}</Button>
                <Button size="sm" variant="ghost" loading={syncing} onClick={() => void sync(true)}>{t("action.pullYear")}</Button>
                <Button size="sm" variant="ghost" onClick={() => void api("/strava/logout", { method: "POST" })}>{t("action.disconnect")}</Button>
              </div>
            </>
          ) : st.data?.strava.configured ? (
            <>
              <div>{t("strava.configured")}</div>
              <a className="btn btn-primary btn-sm" href={loginHref} style={{ alignSelf: "flex-start" }}><Icon name="external-link" size={12} /> {t("action.connectStrava")}</a>
            </>
          ) : (
            <div className="soft">
              {t("strava.setup.before")} <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer">strava.com/settings/api</a>{t("strava.setup.setThe")} <b>{t("strava.setup.callbackDomain")}</b> {t("strava.setup.toHost")} <code>192.168.1.20</code> {t("strava.setup.or")} <code>orbis.local</code>{t("strava.setup.then")}
            </div>
          )}
        </div>
      </div>

      <div className="win">
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">{t("page.ingest")}</span></div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
          <div className="soft">{t("ingest.hint")}</div>
          {sources.data?.map((s) => (
            <div key={s.id} className="win" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <b>{s.name}</b>
                <span className="soft" style={{ fontSize: "var(--fs-meta)" }}>{t("source.count", { count: s.count })}{s.last_at ? ` · ${t("source.last", { time: new Date(s.last_at).toLocaleString(locale) })}` : ""}</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                  <Button size="sm" variant="ghost" onClick={() => setShowSecret(showSecret === s.id ? null : s.id)}>{showSecret === s.id ? t("action.hide") : t("action.showSetup")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void rotate(s.id)} title={t("action.rotate")}><Icon name="reload" size={12} /></Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(s.id)} aria-label={t("action.delete")}><Icon name="trash" size={12} /></Button>
                </span>
              </div>
              {showSecret === s.id ? (
                <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div><span className="soft">{t("setup.url")}</span><br /><code style={{ userSelect: "all", wordBreak: "break-all" }}>{base}/api/m/fitness/ingest/{s.id}</code></div>
                  <div><span className="soft">{t("setup.header")}</span><br />{s.secret ?? secrets[s.id] ? <code style={{ userSelect: "all", wordBreak: "break-all" }}>Authorization: Bearer {s.secret ?? secrets[s.id]}</code> : <span className="soft">{t("source.secretHidden")}</span>}</div>
                  <div className="soft">
                    {t("setup.body.intro")} <code>type</code>, <code>start</code> {t("setup.body.iso")}, <code>duration</code> {t("setup.body.min")} {t("setup.body.or")} <code>duration_s</code>, <code>distance</code> {t("setup.body.m")} {t("setup.body.or")} <code>distanceKm</code>, <code>calories</code>, {t("setup.body.optional")} <code>id</code> {t("setup.body.outro")}
                  </div>
                  <div className="soft">
                    <b>{t("setup.shortcut.title")}</b> <Kbd>Find Workouts</Kbd> {t("setup.shortcut.sort")} → <Kbd>Repeat with Each</Kbd> → <Kbd>Get Contents of URL</Kbd> {t("setup.shortcut.rest")}
                  </div>
                  <pre className="win" style={{ fontSize: "var(--fs-meta)", padding: 8, overflow: "auto", margin: 0 }}>{`curl -X POST ${base}/api/m/fitness/ingest/${s.id} \\
  -H "Authorization: Bearer ${s.secret ?? secrets[s.id] ?? "<secret>"}" -H "content-type: application/json" \\
  -d '{"type":"run","start":"${new Date().toISOString()}","duration":32,"distanceKm":5.2,"calories":340}'`}</pre>
                </div>
              ) : null}
            </div>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); void addSource(); }} style={{ display: "flex", gap: 6 }}>
            <Input value={newSrc} onChange={(e) => setNewSrc(e.target.value)} placeholder={t("source.placeholder")} />
            <Button type="submit" size="sm"><Icon name="plus" size={12} /> {t("action.addSource")}</Button>
          </form>
        </div>
      </div>

      <div className="win" style={{ gridColumn: "1 / -1" }}>
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">{t("page.activities", { count: acts.data?.length ?? 0 })}</span></div>
        <div className="win-body">
          {!acts.data?.length ? <span className="soft" style={{ fontSize: 12 }}>{t("page.activitiesEmpty")}</span> : acts.data.map((a) => <ActivityRow key={a.id} a={a} imperial={imperial} onDelete={() => void api(`/activities/${a.id}`, { method: "DELETE" })} />)}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, soft }: { label: string; value: string; soft?: boolean }) {
  return (
    <div>
      <div className="soft" style={{ fontSize: "var(--fs-meta)" }}>{label}</div>
      <div className="pixel" style={{ fontSize: soft ? 16 : 22, opacity: soft ? 0.8 : 1 }}>{value}</div>
    </div>
  );
}

export default defineClient({
  widgets: { week: WeekWidget, recent: RecentWidget },
  pages: { fitness: FitnessPage },
});
