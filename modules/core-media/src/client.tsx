import { useEffect, useRef, useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleEvents, useModuleQuery, type PageProps, type SettingsProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Window, cx } from "@orbis/ui";
import type { Device, PlayerState, Track } from "./server";

type State = PlayerState & { configured: boolean; premium: boolean };

/* ---------- shared state hook: server pushes "state", progress is interpolated locally ---------- */

function usePlayer() {
  const q = useModuleQuery<State>("/state", { intervalMs: 15_000 });
  const [live, setLive] = useState<State | undefined>();
  useModuleEvents("state", (p) => setLive((prev) => ({ ...(prev ?? q.data ?? ({} as State)), ...(p as PlayerState) })));
  const s = live ?? q.data;
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!s) return;
    const base = s.progressMs;
    const at = new Date(s.updatedAt).getTime();
    const tick = () => setProgress(s.playing ? Math.min((s.track?.durationMs ?? Infinity), base + (Date.now() - at)) : base);
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [s?.updatedAt, s?.playing, s?.progressMs, s?.track?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return { state: s, progress, loading: q.loading && !s, error: q.error, refetch: q.refetch };
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const deviceIcon = (t: string) => ({ computer: "monitor", smartphone: "phone", speaker: "radio", tv: "tv", tablet: "tablet", avr: "radio", castaudio: "radio", castvideo: "tv", automobile: "car", gameconsole: "gamepad" }[t.toLowerCase()] ?? "music");

function ConnectHint({ state }: { state: State | undefined }) {
  const { hubUrl } = useModule();
  if (!state) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  if (!state.configured) {
    return (
      <Empty icon="music" title="spotify not set up">
        add your spotify client id under modules → media → settings.
      </Empty>
    );
  }
  return (
    <Empty icon="music" title="connect spotify">
      <a className="btn btn-primary" href={`${hubUrl}/api/m/media/spotify/login?return=${encodeURIComponent(window.location.href)}`}>
        <Icon name="link" size={12} /> connect
      </a>
    </Empty>
  );
}

/* ---------- controls ---------- */

function Controls({ state, size = "md" }: { state: State; size?: "sm" | "md" }) {
  const api = useModuleApi();
  const call = (path: string, json?: unknown) => api(path, { method: "POST", json }).catch(() => undefined);
  const dim = size === "sm" ? 14 : 18;
  const disabled = !state.premium;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }} title={disabled ? "controls need spotify premium" : undefined}>
      <Button icon size="sm" variant="ghost" aria-pressed={state.shuffle} onClick={() => call("/shuffle", { on: !state.shuffle })} aria-label="shuffle" disabled={disabled}><Icon name="shuffle" size={dim - 4} /></Button>
      <Button icon size={size === "sm" ? "sm" : "md"} variant="ghost" onClick={() => call("/previous")} aria-label="previous" disabled={disabled}><Icon name="forward" size={dim} style={{ transform: "scaleX(-1)" }} /></Button>
      <Button icon size={size === "sm" ? "sm" : "md"} variant={state.playing ? "default" : "primary"} onClick={() => call(state.playing ? "/pause" : "/play")} aria-label={state.playing ? "pause" : "play"} disabled={disabled}>
        <Icon name={state.playing ? "pause" : "play"} size={dim} />
      </Button>
      <Button icon size={size === "sm" ? "sm" : "md"} variant="ghost" onClick={() => call("/next")} aria-label="next" disabled={disabled}><Icon name="forward" size={dim} /></Button>
      <Button icon size="sm" variant="ghost" aria-pressed={state.repeat !== "off"} onClick={() => call("/repeat", { mode: state.repeat === "off" ? "context" : state.repeat === "context" ? "track" : "off" })} aria-label={`repeat: ${state.repeat}`} disabled={disabled}>
        <Icon name={state.repeat === "track" ? "repeat-1" : "repeat"} size={dim - 4} />
      </Button>
    </div>
  );
}

function Progress({ state, progress, onSeek }: { state: State; progress: number; onSeek?: (ms: number) => void }) {
  const dur = state.track?.durationMs ?? 0;
  const pct = dur ? Math.min(100, (progress / dur) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }} className="soft">
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(progress)}</span>
      <div
        className="progress"
        style={{ flex: 1, cursor: onSeek && state.premium ? "pointer" : undefined }}
        onClick={(e) => {
          if (!onSeek || !dur || !state.premium) return;
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * dur);
        }}
      >
        <i style={{ width: `${pct}%`, transition: "none" }} />
      </div>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(dur)}</span>
    </div>
  );
}

function DevicePicker({ state, compact }: { state: State; compact?: boolean }) {
  const api = useModuleApi();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const d = state.device;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" className="chip" onClick={() => setOpen((v) => !v)} title="choose playback device" style={{ cursor: "pointer", gap: 6, maxWidth: compact ? 140 : 220 }}>
        <Icon name={deviceIcon(d?.type ?? "")} size={11} style={{ color: "var(--accent)" }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{d?.name ?? "no device"}</span>
        <Icon name="chevron-down" size={10} />
      </button>
      {open ? (
        <div className="menu" style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, minWidth: 200 }}>
          {state.devices.length === 0 ? <div className="menu-item soft">open spotify on a device first</div> : null}
          {state.devices.map((dev: Device) => (
            <button
              key={dev.id}
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                void api("/transfer", { method: "POST", json: { deviceId: dev.id, play: state.playing } });
              }}
              style={{ color: dev.active ? "var(--accent)" : undefined }}
            >
              <Icon name={deviceIcon(dev.type)} size={13} />
              <span style={{ flex: 1 }}>{dev.name}</span>
              {dev.volume !== null ? <span className="soft" style={{ fontSize: 10 }}>{dev.volume}%</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Volume({ state }: { state: State }) {
  const api = useModuleApi();
  const [v, setV] = useState(state.volume ?? 0);
  useEffect(() => setV(state.volume ?? 0), [state.volume]);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (state.volume === null) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }} title="volume">
      <Icon name={v === 0 ? "volume-x" : v < 50 ? "volume" : "volume-3"} size={12} className="soft" />
      <input
        type="range"
        min={0}
        max={100}
        value={v}
        disabled={!state.premium}
        onChange={(e) => {
          const n = Number(e.target.value);
          setV(n);
          clearTimeout(t.current);
          t.current = setTimeout(() => void api("/volume", { method: "POST", json: { percent: n } }), 250);
        }}
        style={{ width: 80, accentColor: "var(--accent)" }}
      />
    </div>
  );
}

/* ---------- widgets ---------- */

function NowPlayingWidget({ config, size }: WidgetProps<{ showDevice?: boolean; showControls?: boolean }>) {
  const { state, progress } = usePlayer();
  const api = useModuleApi();
  if (!state?.connected) return <ConnectHint state={state} />;
  const t = state.track;
  const compact = size.height < 150;
  const cover = Math.max(44, Math.min(size.height - 24, size.width * 0.3, 160));
  return (
    <div style={{ height: "100%", display: "flex", gap: 12, alignItems: "stretch" }}>
      <div style={{ width: cover, height: cover, flex: "none", border: "1.5px solid var(--line)", boxShadow: "3px 3px 0 var(--line)", background: "var(--paper-2)", alignSelf: "center", overflow: "hidden" }}>
        {t?.cover ? <img src={t.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", imageRendering: "auto", display: "block" }} /> : <Icon name="music" size={cover * 0.5} className="soft" style={{ margin: cover * 0.25 }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", gap: compact ? 2 : 6 }}>
        {t ? (
          <div style={{ minWidth: 0 }}>
            <div className="pixel" style={{ fontSize: compact ? 13 : 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</div>
            <div className="soft" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.artists.join(", ")}{!compact && t.album ? ` · ${t.album}` : ""}</div>
          </div>
        ) : (
          <div className="soft" style={{ fontSize: 12 }}>nothing playing{state.device ? ` on ${state.device.name}` : ""}</div>
        )}
        {t ? <Progress state={state} progress={progress} onSeek={(ms) => void api("/seek", { method: "POST", json: { positionMs: ms } })} /> : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {config.showControls !== false ? <Controls state={state} size={compact ? "sm" : "md"} /> : null}
          {config.showDevice !== false && !compact ? <DevicePicker state={state} compact /> : null}
        </div>
        {state.error ? <div style={{ color: "var(--dnd)", fontSize: 10 }}>{state.error}</div> : null}
      </div>
    </div>
  );
}

function DevicesWidget() {
  const { state } = usePlayer();
  const api = useModuleApi();
  if (!state?.connected) return <ConnectHint state={state} />;
  if (state.devices.length === 0) return <Empty icon="radio" title="no devices">open spotify somewhere and it shows up here.</Empty>;
  return (
    <div className="scroll-y" style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      {state.devices.map((d) => (
        <button key={d.id} type="button" className={cx("menu-item")} style={{ border: `1px ${d.active ? "solid var(--accent)" : "dashed var(--line)"}`, color: d.active ? "var(--accent)" : undefined, padding: "6px 10px" }} onClick={() => void api("/transfer", { method: "POST", json: { deviceId: d.id, play: state.playing } })}>
          <Icon name={deviceIcon(d.type)} size={14} />
          <span style={{ flex: 1, textAlign: "left" }}>{d.name}</span>
          {d.active ? <Chip tone="accent" style={{ fontSize: 9 }}>playing here</Chip> : null}
          {d.volume !== null ? <span className="soft" style={{ fontSize: 10 }}>{d.volume}%</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ---------- page ---------- */

function MediaPage(_p: PageProps) {
  const { state, progress } = usePlayer();
  const api = useModuleApi();
  const { hubUrl } = useModule();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ tracks: Track[]; albums: Simple[]; artists: Simple[]; playlists: Simple[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const playlists = useModuleQuery<Simple[]>("/playlists", { enabled: !!state?.connected });
  const recent = useModuleQuery<Array<Track & { context: { uri: string } | null }>>("/recent", { enabled: !!state?.connected, refetchOn: ["state"] });
  const queue = useModuleQuery<{ current: Track | null; queue: Track[] }>("/queue", { enabled: !!state?.connected, refetchOn: ["state"] });
  const play = (body: Record<string, unknown>) => api("/play", { method: "POST", json: body }).catch(() => undefined);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("spotify_error");
    if (p) alert(`spotify: ${p}`);
  }, []);

  if (!state?.connected) {
    return (
      <Window title="media">
        <ConnectHint state={state} />
        {state?.configured ? (
          <p className="soft" style={{ fontSize: 11, marginTop: 10 }}>
            spotify only accepts https redirect uris or <code>http://127.0.0.1</code>. if your hub runs on plain http in the lan, open the app once via <code>http://127.0.0.1:3001</code> on the hub machine to connect; the token is stored on the hub and works everywhere afterwards. redirect uri to register: <code>{hubUrl}/api/m/media/spotify/callback</code>
          </p>
        ) : null}
      </Window>
    );
  }
  const t = state.track;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(260px, 2fr)", gap: 14, alignItems: "start" }} className="media-page">
      <style>{`@media (max-width: 860px) { .media-page { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Window
          title="now playing"
          right={
            <>
              {state.account ? <Chip style={{ fontSize: 10 }}>{state.account.name}{state.premium ? "" : " · free"}</Chip> : null}
              <Button size="sm" variant="ghost" onClick={() => api("/spotify/logout", { method: "POST" })} aria-label="disconnect"><Icon name="unlink" size={12} /></Button>
            </>
          }
        >
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ width: 160, height: 160, flex: "none", border: "1.5px solid var(--line)", boxShadow: "4px 4px 0 var(--line)", background: "var(--paper-2)", overflow: "hidden" }}>
              {t?.cover ? <img src={t.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <Icon name="music" size={80} className="soft" style={{ margin: 40 }} />}
            </div>
            <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 10 }}>
              {t ? (
                <div>
                  <div className="pixel" style={{ fontSize: 20, lineHeight: 1.2 }}>{t.title}</div>
                  <div className="soft" style={{ fontSize: 12 }}>{t.artists.join(", ")} · {t.album}</div>
                </div>
              ) : (
                <div className="soft">nothing playing. pick a playlist or search.</div>
              )}
              {t ? <Progress state={state} progress={progress} onSeek={(ms) => void api("/seek", { method: "POST", json: { positionMs: ms } })} /> : null}
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <Controls state={state} />
                <Volume state={state} />
                <DevicePicker state={state} />
              </div>
              {!state.premium ? <div className="soft" style={{ fontSize: 10 }}>playback control needs spotify premium; the free plan can only show what plays.</div> : null}
              {state.error ? <div style={{ color: "var(--dnd)", fontSize: 11 }}>{state.error}</div> : null}
            </div>
          </div>
        </Window>

        <Window title="search">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!q.trim()) return;
              setSearching(true);
              try {
                setResults(await api(`/search?q=${encodeURIComponent(q.trim())}`));
              } finally {
                setSearching(false);
              }
            }}
            style={{ display: "flex", gap: 6 }}
          >
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="tracks, albums, artists, playlists…" />
            <Button type="submit" loading={searching}><Icon name="search" size={12} /></Button>
          </form>
          {results ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 12 }}>
              <List title="tracks" items={results.tracks.map((x) => ({ key: x.id, cover: x.cover, name: x.title, sub: x.artists.join(", "), onPlay: () => play({ uri: x.uri }), onQueue: () => api("/queue", { method: "POST", json: { uri: x.uri } }) }))} />
              <List title="albums" items={results.albums.map((x) => ({ key: x.id, cover: x.cover, name: x.name, sub: x.sub, onPlay: () => play({ contextUri: x.uri }) }))} />
              <List title="artists" items={results.artists.map((x) => ({ key: x.id, cover: x.cover, name: x.name, sub: "", onPlay: () => play({ contextUri: x.uri }) }))} />
              <List title="playlists" items={results.playlists.map((x) => ({ key: x.id, cover: x.cover, name: x.name, sub: x.sub, onPlay: () => play({ contextUri: x.uri }) }))} />
            </div>
          ) : null}
        </Window>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Window title="up next" tight>
          <div style={{ padding: 8 }}>
            {(queue.data?.queue ?? []).length === 0 ? <div className="soft" style={{ fontSize: 12, padding: 4 }}>queue is empty</div> : null}
            {(queue.data?.queue ?? []).slice(0, 10).map((x, i) => (
              <Row key={`${x.id}-${i}`} cover={x.cover} name={x.title} sub={x.artists.join(", ")} />
            ))}
          </div>
        </Window>
        <Window title="your playlists" tight>
          <div className="scroll-y" style={{ padding: 8, maxHeight: 320 }}>
            {(playlists.data ?? []).map((p) => (
              <Row key={p.id} cover={p.cover} name={p.name} sub={`${p.tracks} tracks`} onPlay={() => play({ contextUri: p.uri })} />
            ))}
          </div>
        </Window>
        <Window title="recently played" tight>
          <div className="scroll-y" style={{ padding: 8, maxHeight: 280 }}>
            {(recent.data ?? []).slice(0, 12).map((x) => (
              <Row key={x.id} cover={x.cover} name={x.title} sub={x.artists.join(", ")} onPlay={() => play(x.context ? { contextUri: x.context.uri, uri: undefined } : { uri: x.uri })} />
            ))}
          </div>
        </Window>
      </div>
    </div>
  );
}

type Simple = { id: string; name: string; uri: string; cover: string | null; sub: string; tracks?: number };

function Row({ cover, name, sub, onPlay, onQueue }: { cover: string | null; name: string; sub: string; onPlay?: () => void; onQueue?: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 2px", borderBottom: "1px dashed var(--line)" }}>
      <div style={{ width: 28, height: 28, flex: "none", background: "var(--paper-2)", border: "1px solid var(--line)", overflow: "hidden" }}>{cover ? <img src={cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : null}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
        {sub ? <div className="soft" style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div> : null}
      </div>
      {onQueue ? <Button icon size="sm" variant="ghost" onClick={onQueue} aria-label="add to queue" title="add to queue"><Icon name="plus" size={11} /></Button> : null}
      {onPlay ? <Button icon size="sm" variant="ghost" onClick={onPlay} aria-label="play"><Icon name="play" size={11} /></Button> : null}
    </div>
  );
}

function List({ title, items }: { title: string; items: Array<{ key: string; cover: string | null; name: string; sub: string; onPlay: () => void; onQueue?: () => void }> }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="pixel soft" style={{ fontSize: 11, marginBottom: 4 }}>{title}</div>
      {items.map((it) => (
        <Row key={it.key} cover={it.cover} name={it.name} sub={it.sub} onPlay={it.onPlay} onQueue={it.onQueue} />
      ))}
    </div>
  );
}

function MediaSettings({ value, onChange }: SettingsProps) {
  const { hubUrl } = useModule();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="spotify client id" hint="developer.spotify.com → dashboard → create app. no client secret needed (pkce).">
        <Input value={String(value.spotifyClientId ?? "")} onChange={(e) => onChange({ ...value, spotifyClientId: e.target.value.trim() })} placeholder="32 hex characters" autoComplete="off" />
      </Field>
      <div className="win win-dashed win-flat" style={{ padding: "8px 10px", fontSize: 11 }}>
        <div className="pixel" style={{ marginBottom: 4 }}>redirect uri to register in the spotify app</div>
        <code style={{ overflowWrap: "anywhere" }}>{hubUrl}/api/m/media/spotify/callback</code>
        <div className="soft" style={{ marginTop: 6 }}>spotify requires https, or http://127.0.0.1 for local testing. with a plain-http lan hub, connect once via 127.0.0.1 on the hub machine; the token then works from every device.</div>
      </div>
      <Field label="poll playback every (seconds)">
        <Input type="number" min={2} max={60} value={Number(value.pollSeconds ?? 5)} onChange={(e) => onChange({ ...value, pollSeconds: Number(e.target.value) })} />
      </Field>
    </div>
  );
}

export default defineClient({
  widgets: { "now-playing": NowPlayingWidget, devices: DevicesWidget },
  pages: { media: MediaPage },
  settings: MediaSettings,
});
