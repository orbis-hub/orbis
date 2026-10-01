import { useEffect, useRef, useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleEvents, useModuleQuery, type PageProps, type SettingsProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Field, Icon, Input, Window, cx, useToast } from "@orbis/ui";
import type { Device, PlayerState, ProviderInfo, Track } from "./server";

type State = PlayerState & { configured: boolean; premium: boolean; providers?: ProviderInfo[] };

/* ---------- providers + "play in this browser" ---------- */

function ProviderSwitch({ state }: { state: State | undefined }) {
  const api = useModuleApi();
  const list = state?.providers ?? [];
  if (list.filter((p) => p.available).length < 2 && state?.provider !== "ha") return null;
  return (
    <span style={{ display: "inline-flex", gap: 2 }} title="where orbis looks for the player">
      {list.map((p) => (
        <button key={p.id} type="button" className="chip" disabled={!p.available} title={p.reason} onClick={() => void api("/provider", { method: "POST", json: { id: p.id } })} style={{ cursor: p.available ? "pointer" : "not-allowed", opacity: p.available ? 1 : 0.5, borderColor: state?.provider === p.id ? "var(--accent)" : undefined, color: state?.provider === p.id ? "var(--accent)" : undefined, fontSize: 10 }}>
          {p.name}
        </button>
      ))}
    </span>
  );
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: new (opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SpotifyPlayer };
  }
}
type SpotifyPlayer = { connect(): Promise<boolean>; disconnect(): void; addListener(ev: string, cb: (e: { device_id?: string; message?: string }) => void): void; activateElement?: () => Promise<void> };
let sdkPromise: Promise<void> | null = null;
const loadSdk = () => {
  if (window.Spotify) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise<void>((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      const el = document.createElement("script");
      el.src = "https://sdk.scdn.co/spotify-player.js";
      el.async = true;
      el.onerror = () => reject(new Error("could not load the spotify sdk (ad blocker?)"));
      document.head.appendChild(el);
    });
  }
  return sdkPromise;
};

/** turns this tab into a spotify connect device via the web playback sdk (premium only) */
function BrowserPlayer({ state }: { state: State }) {
  const api = useModuleApi();
  const toast = useToast();
  const [status, setStatus] = useState<"off" | "loading" | "ready" | "error">("off");
  const [err, setErr] = useState<string | null>(null);
  const playerRef = useRef<SpotifyPlayer | null>(null);
  useEffect(() => () => playerRef.current?.disconnect(), []);
  if (state.provider !== "spotify" || !state.premium) return null;
  const start = async () => {
    setStatus("loading");
    setErr(null);
    try {
      await loadSdk();
      const name = `orbis (${/mobile|android|iphone|ipad/i.test(navigator.userAgent) ? "this phone" : "this browser"})`;
      const player = new window.Spotify!.Player({ name, getOAuthToken: (cb) => void api<{ token: string }>("/spotify/token").then((r) => cb(r.token)).catch(() => undefined), volume: 0.6 });
      player.addListener("ready", () => {
        setStatus("ready");
        toast(`${name} is now a spotify device`);
        setTimeout(() => void api("/refresh", { method: "POST" }), 800);
      });
      player.addListener("not_ready", () => setStatus("off"));
      for (const ev of ["initialization_error", "authentication_error", "account_error", "playback_error"]) player.addListener(ev, (e) => { setErr(e.message ?? ev); if (ev !== "playback_error") setStatus("error"); });
      await player.activateElement?.();
      const ok = await player.connect();
      if (!ok) throw new Error("spotify refused the connection");
      playerRef.current = player;
    } catch (e) {
      setStatus("error");
      setErr((e as Error).message);
    }
  };
  const stop = () => {
    playerRef.current?.disconnect();
    playerRef.current = null;
    setStatus("off");
    setTimeout(() => void api("/refresh", { method: "POST" }), 800);
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {status === "ready" ? (
        <Button size="sm" variant="ghost" onClick={stop} title="stop being a spotify device"><Icon name="monitor" size={12} /> this browser is a speaker · stop</Button>
      ) : (
        <Button size="sm" variant="ghost" loading={status === "loading"} onClick={() => void start()} title="make this tab a spotify connect device (web playback sdk, premium)"><Icon name="monitor" size={12} /> play in this browser</Button>
      )}
      {err ? <span style={{ color: "var(--dnd)", fontSize: 10 }}>{err}{/scope/i.test(err) ? " – disconnect and connect spotify again once (the streaming scope is new)" : ""}</span> : null}
    </span>
  );
}

/* ---------- shared state hook: server pushes "state", progress is interpolated locally ---------- */

function usePlayer() {
  const q = useModuleQuery<State>("/state", { intervalMs: 30_000 });
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

/** spotify refuses "localhost" as a redirect host but accepts the loopback ip, so we talk to the hub as 127.0.0.1 for the oauth dance */
function loopback(url: string) {
  return url.replace(/\/\/localhost(:|\/|$)/, "//127.0.0.1$1").replace(/\/+$/, "");
}
function useSpotifyUrls() {
  const { hubUrl, token } = useModule();
  const base = loopback(hubUrl);
  const redirectUri = `${base}/api/m/media/spotify/callback`;
  const loginHref = (back: string) => `${base}/api/m/media/spotify/login?return=${encodeURIComponent(back)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  return { base, redirectUri, loginHref, isLoopback: /127\.0\.0\.1|localhost/.test(hubUrl) };
}

function ConnectHint({ state }: { state: State | undefined }) {
  const { loginHref } = useSpotifyUrls();
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
      <a className="btn btn-primary" href={loginHref(window.location.href)}>
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

/* ---------- search with autocomplete ---------- */

type SearchResults = { tracks: Track[]; albums: Simple[]; artists: Simple[]; playlists: Simple[] };
const searchMemo = new Map<string, SearchResults>();

function SearchBox({ types = ["track", "playlist", "album"], compact, onPlayed }: { types?: string[]; compact?: boolean; onPlayed?: () => void }) {
  const api = useModuleApi();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SearchResults | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const typeKey = types.join(",");

  useEffect(() => {
    const term = q.trim().toLowerCase();
    clearTimeout(timer.current);
    if (term.length < 2) {
      setRes(null);
      return;
    }
    const key = `${typeKey}|${term}`;
    const hit = searchMemo.get(key);
    if (hit) {
      setRes(hit);
      setOpen(true);
      return;
    }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api<SearchResults>(`/search?q=${encodeURIComponent(term)}&types=${typeKey}&limit=5`);
        searchMemo.set(key, r);
        if (searchMemo.size > 100) searchMemo.delete(searchMemo.keys().next().value!);
        setRes(r);
        setOpen(true);
        setActive(0);
      } catch {
        /* ignore */
      } finally {
        setBusy(false);
      }
    }, 280);
    return () => clearTimeout(timer.current);
  }, [q, typeKey, api]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  type Item = { key: string; kind: string; name: string; sub: string; cover: string | null; uri: string };
  const items: Item[] = [];
  if (res) {
    for (const t of res.tracks) items.push({ key: "t" + t.id, kind: "track", name: t.title, sub: t.artists.join(", "), cover: t.cover, uri: t.uri });
    for (const p of res.playlists) items.push({ key: "p" + p.id, kind: "playlist", name: p.name, sub: p.sub, cover: p.cover, uri: p.uri });
    for (const a of res.albums) items.push({ key: "a" + a.id, kind: "album", name: a.name, sub: a.sub, cover: a.cover, uri: a.uri });
    for (const a of res.artists) items.push({ key: "r" + a.id, kind: "artist", name: a.name, sub: "artist", cover: a.cover, uri: a.uri });
  }
  const play = async (it: Item) => {
    setOpen(false);
    setQ("");
    await api("/play", { method: "POST", json: it.kind === "track" ? { uri: it.uri } : { contextUri: it.uri } }).catch(() => undefined);
    onPlayed?.();
  };
  const queue = async (it: Item) => {
    await api("/queue", { method: "POST", json: { uri: it.uri } }).catch(() => undefined);
  };

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name="search" size={12} className="soft" style={{ flex: "none" }} />
        <input
          className="input"
          value={q}
          placeholder={compact ? "search…" : `search ${types.join(", ")}…`}
          style={{ padding: compact ? "3px 6px" : "4px 8px", fontSize: 12 }}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => res && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); setOpen(true); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            else if (e.key === "Enter" && items[active]) { e.preventDefault(); void play(items[active]!); }
            else if (e.key === "Escape") setOpen(false);
          }}
        />
        {busy ? <span className="spinner" style={{ flex: "none" }} /> : null}
      </div>
      {open && items.length ? (
        <div className="menu scroll-y" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, maxHeight: 260, zIndex: 60, padding: 2 }}>
          {items.map((it, i) => (
            <div key={it.key} className={cx("menu-item")} style={{ padding: "4px 8px", gap: 8, background: i === active ? "var(--accent-soft)" : undefined, cursor: "pointer" }} onMouseEnter={() => setActive(i)} onClick={() => void play(it)}>
              <div style={{ width: 24, height: 24, flex: "none", background: "var(--paper-2)", border: "1px solid var(--line)", overflow: "hidden" }}>{it.cover ? <img src={it.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : null}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
                <div className="soft" style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.sub}</div>
              </div>
              <Chip style={{ fontSize: 9 }}>{it.kind}</Chip>
              {it.kind === "track" ? (
                <button type="button" className="btn btn-icon btn-sm btn-ghost" title="add to queue" aria-label="add to queue" onClick={(e) => { e.stopPropagation(); void queue(it); }}>
                  <Icon name="plus" size={11} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- widgets ---------- */

type NowPlayingConfig = {
  showCover?: boolean;
  showTitle?: boolean;
  showProgress?: boolean;
  showControls?: boolean;
  showDevice?: boolean;
  showVolume?: boolean;
  showSearch?: boolean;
  searchTypes?: string[];
  layout?: "auto" | "horizontal" | "vertical";
};

function NowPlayingWidget({ config, size }: WidgetProps<NowPlayingConfig>) {
  const { state, progress } = usePlayer();
  const api = useModuleApi();
  if (!state?.connected) return <ConnectHint state={state} />;
  const t = state.track;
  const on = (k: keyof NowPlayingConfig, d = true) => (config[k] === undefined ? d : !!config[k]);
  const vertical = config.layout === "vertical" || (config.layout !== "horizontal" && size.height > size.width * 0.95);
  const compact = !vertical && size.height < 150;
  const searchH = on("showSearch") ? 34 : 0;
  const cover = vertical ? Math.max(48, Math.min(size.width - 8, size.height - 130 - searchH)) : Math.max(44, Math.min(size.height - 24 - searchH, size.width * 0.3, 160));
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      {on("showSearch") ? <SearchBox types={config.searchTypes?.length ? config.searchTypes : ["track", "playlist", "album"]} compact={compact || size.width < 260} /> : null}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: vertical ? "column" : "row", gap: 12, alignItems: vertical ? "center" : "stretch", textAlign: vertical ? "center" : undefined }}>
        {on("showCover") ? (
          <div style={{ width: cover, height: cover, flex: "none", border: "1.5px solid var(--line)", boxShadow: "3px 3px 0 var(--line)", background: "var(--paper-2)", alignSelf: "center", overflow: "hidden" }}>
            {t?.cover ? <img src={t.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <Icon name="music" size={cover * 0.5} className="soft" style={{ margin: cover * 0.25 }} />}
          </div>
        ) : null}
        <div style={{ flex: 1, minWidth: 0, width: vertical ? "100%" : undefined, display: "flex", flexDirection: "column", justifyContent: "center", gap: compact ? 2 : 6 }}>
          {on("showTitle") ? (
            t ? (
              <div style={{ minWidth: 0 }}>
                <div className="pixel" style={{ fontSize: compact ? 13 : 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</div>
                <div className="soft" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.artists.join(", ")}{!compact && t.album ? ` · ${t.album}` : ""}</div>
              </div>
            ) : (
              <div className="soft" style={{ fontSize: 12 }}>nothing playing{state.device ? ` on ${state.device.name}` : ""}</div>
            )
          ) : null}
          {on("showProgress") && t ? <Progress state={state} progress={progress} onSeek={(ms) => void api("/seek", { method: "POST", json: { positionMs: ms } })} /> : null}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: vertical ? "center" : undefined }}>
            {on("showControls") ? <Controls state={state} size={compact ? "sm" : "md"} /> : null}
            {on("showVolume", false) ? <Volume state={state} /> : null}
            {on("showDevice") && !compact ? <DevicePicker state={state} compact /> : null}
          </div>
          {state.error ? <div style={{ color: "var(--dnd)", fontSize: 10 }}>{state.error}</div> : null}
        </div>
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
  const { redirectUri, isLoopback } = useSpotifyUrls();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ tracks: Track[]; albums: Simple[]; artists: Simple[]; playlists: Simple[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const playlists = useModuleQuery<Simple[]>("/playlists", { enabled: !!state?.connected && state.provider === "spotify" });
  const recent = useModuleQuery<Array<Track & { context: { uri: string } | null }>>("/recent", { enabled: !!state?.connected && state.provider === "spotify", refetchOn: ["state"] });
  const queue = useModuleQuery<{ current: Track | null; queue: Track[] }>("/queue", { enabled: !!state?.connected && state.provider === "spotify", refetchOn: ["state"] });
  const play = (body: Record<string, unknown>) => api("/play", { method: "POST", json: body }).catch(() => undefined);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("spotify_error");
    if (p) alert(`spotify: ${p}`);
  }, []);

  if (state && !state.connected && state.provider === "ha") {
    return (
      <Window title="media" right={<ProviderSwitch state={state} />}>
        <Empty icon="radio" title="no media players in home assistant">{state.error ?? "the home assistant module has no media_player entities yet."}</Empty>
      </Window>
    );
  }
  if (!state?.connected) {
    return (
      <Window title="media" right={<ProviderSwitch state={state} />}>
        <ConnectHint state={state} />
        {state?.configured ? (
          <p className="soft" style={{ fontSize: 11, marginTop: 10 }}>
            spotify only accepts https redirect uris or <code>http://127.0.0.1</code>. redirect uri to register in your spotify app: <code>{redirectUri}</code>
            {isLoopback ? " (connect from the hub machine; the token is stored on the hub and works from every device afterwards)" : ". if your hub runs on plain http in the lan, open the app on the hub machine via http://127.0.0.1:<port> once to connect."}
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
              <ProviderSwitch state={state} />
              {state.account && state.provider === "spotify" ? <Chip style={{ fontSize: 10 }}>{state.account.name}{state.premium ? "" : " · free"}</Chip> : null}
              {state.provider === "spotify" ? <Button size="sm" variant="ghost" onClick={() => api("/spotify/logout", { method: "POST" })} aria-label="disconnect"><Icon name="unlink" size={12} /></Button> : null}
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
                <BrowserPlayer state={state} />
              </div>
              {!state.premium && state.provider === "spotify" ? <div className="soft" style={{ fontSize: 10 }}>playback control needs spotify premium; the free plan can only show what plays.</div> : null}
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
  const { redirectUri } = useSpotifyUrls();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="spotify client id" hint="developer.spotify.com → dashboard → create app. no client secret needed (pkce).">
        <Input value={String(value.spotifyClientId ?? "")} onChange={(e) => onChange({ ...value, spotifyClientId: e.target.value.trim() })} placeholder="32 hex characters" autoComplete="off" />
      </Field>
      <div className="win win-dashed win-flat" style={{ padding: "8px 10px", fontSize: 11 }}>
        <div className="pixel" style={{ marginBottom: 4 }}>redirect uri to register in the spotify app</div>
        <code style={{ overflowWrap: "anywhere" }}>{redirectUri}</code>
        <div className="soft" style={{ marginTop: 6 }}>spotify accepts https or http://127.0.0.1 only (never "localhost"). with a plain-http lan hub, connect once from the hub machine; the token then works from every device.</div>
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
