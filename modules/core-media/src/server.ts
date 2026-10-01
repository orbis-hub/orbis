import { createHash, randomBytes } from "node:crypto";
import { defineModule } from "@orbis/sdk/server";
import type { Context } from "hono";

/**
 * Media module. Provider based; Spotify is the first provider (Web API, PKCE auth, no client secret).
 * Apple Music and YouTube Music have no third-party playback-control api, so they are not providers here.
 * Future providers: Home Assistant media_player entities, Sonos, Chromecast, MPD.
 */

type Settings = { spotifyClientId?: string; pollSeconds?: number };

export type Device = { id: string; name: string; type: string; active: boolean; volume: number | null; provider: "spotify" };
export type Track = { id: string; title: string; artists: string[]; album: string; cover: string | null; durationMs: number; uri: string; url?: string };
export type PlayerState = {
  provider: "spotify";
  connected: boolean;
  account?: { name: string; image: string | null; product: string };
  playing: boolean;
  track: Track | null;
  progressMs: number;
  shuffle: boolean;
  repeat: "off" | "track" | "context";
  volume: number | null;
  device: Device | null;
  devices: Device[];
  context?: { type: string; uri: string } | null;
  updatedAt: string;
  error?: string;
};

type Tokens = { access: string; refresh: string; expiresAt: number; scope: string };

const SCOPES = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing", "user-read-private", "playlist-read-private", "playlist-read-collaborative", "user-library-read", "user-read-recently-played"].join(" ");

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export default defineModule<Settings>({
  setup(ctx) {
    const { http, storage, events, logger, settings } = ctx;
    const empty = (): PlayerState => ({ provider: "spotify", connected: false, playing: false, track: null, progressMs: 0, shuffle: false, repeat: "off", volume: null, device: null, devices: [], updatedAt: new Date().toISOString() });
    let state: PlayerState = empty();
    let lastSig = "";

    const tokens = () => storage.get<Tokens>("spotify:tokens") ?? null;
    let pausedUntil = 0; // set after a 429, polling waits until then
    const clientId = () => settings.get().spotifyClientId?.trim() ?? "";

    /* ---------- auth (authorization code + pkce) ---------- */

    async function refreshIfNeeded(): Promise<string | null> {
      const t = tokens();
      if (!t) return null;
      if (Date.now() < t.expiresAt - 30_000) return t.access;
      const res = await ctx.fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: clientId() }),
      });
      if (!res.ok) {
        logger.warn(`spotify token refresh failed: HTTP ${res.status}`);
        if (res.status === 400 || res.status === 401) storage.delete("spotify:tokens");
        return null;
      }
      const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
      const next: Tokens = { access: j.access_token, refresh: j.refresh_token ?? t.refresh, expiresAt: Date.now() + j.expires_in * 1000, scope: j.scope ?? t.scope };
      storage.set("spotify:tokens", next);
      return next.access;
    }

    async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T | null> {
      const access = await refreshIfNeeded();
      if (!access) throw Object.assign(new Error("spotify not connected"), { status: 401 });
      const res = await ctx.fetch(`https://api.spotify.com/v1${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${access}`, ...(init.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 204 || res.status === 202) return null;
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after") ?? "30");
        pausedUntil = Date.now() + Math.min(300, Math.max(5, retry)) * 1000;
        throw Object.assign(new Error(`spotify rate limit, pausing ${Math.round((pausedUntil - Date.now()) / 1000)}s`), { status: 429 });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = `HTTP ${res.status}`;
        try {
          msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
        } catch {
          /* ignore */
        }
        throw Object.assign(new Error(msg), { status: res.status });
      }
      const text = await res.text();
      return text ? (JSON.parse(text) as T) : null;
    }

    http.get("/spotify/login", (c) => {
      const id = clientId();
      if (!id) return c.json({ error: "set the spotify client id in the module settings first" }, 400);
      const verifier = b64url(randomBytes(48));
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      const stateKey = b64url(randomBytes(12));
      const origin = new URL(c.req.url).origin;
      const redirectUri = `${origin}/api/m/media/spotify/callback`;
      storage.set(`spotify:pkce:${stateKey}`, { verifier, redirectUri, back: c.req.query("return") ?? `${origin}/m/?id=media`, at: Date.now() });
      const u = new URL("https://accounts.spotify.com/authorize");
      u.search = new URLSearchParams({ response_type: "code", client_id: id, scope: SCOPES, redirect_uri: redirectUri, state: stateKey, code_challenge_method: "S256", code_challenge: challenge }).toString();
      return c.redirect(u.toString());
    });

    http.get("/spotify/callback", async (c) => {
      const stateKey = c.req.query("state") ?? "";
      const pending = storage.get<{ verifier: string; redirectUri: string; back: string }>(`spotify:pkce:${stateKey}`);
      storage.delete(`spotify:pkce:${stateKey}`);
      if (!pending) return c.text("login expired, try again", 400);
      if (c.req.query("error")) return c.redirect(`${pending.back}${pending.back.includes("?") ? "&" : "?"}spotify_error=${encodeURIComponent(c.req.query("error")!)}`);
      const res = await ctx.fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: c.req.query("code") ?? "", redirect_uri: pending.redirectUri, client_id: clientId(), code_verifier: pending.verifier }),
      });
      if (!res.ok) return c.text(`token exchange failed: ${await res.text()}`, 400);
      const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
      storage.set("spotify:tokens", { access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000, scope: j.scope } satisfies Tokens);
      logger.info("spotify connected");
      void poll(true);
      return c.redirect(pending.back);
    });

    http.post("/spotify/logout", (c) => {
      storage.delete("spotify:tokens");
      state = empty();
      events.publish("state", state);
      return c.json({ ok: true });
    });

    /* ---------- state polling ---------- */

    function mapDevice(d: { id: string; name: string; type: string; is_active: boolean; volume_percent: number | null }): Device {
      return { id: d.id, name: d.name, type: d.type, active: d.is_active, volume: d.volume_percent, provider: "spotify" };
    }
    function mapTrack(t: Record<string, unknown> | null | undefined): Track | null {
      if (!t || !t.id) return null;
      const album = t.album as { name?: string; images?: Array<{ url: string }> } | undefined;
      const show = t.show as { name?: string; images?: Array<{ url: string }> } | undefined;
      return {
        id: String(t.id),
        title: String(t.name ?? ""),
        artists: ((t.artists as Array<{ name: string }> | undefined) ?? []).map((a) => a.name).concat(show?.name ? [show.name] : []),
        album: album?.name ?? show?.name ?? "",
        cover: album?.images?.[0]?.url ?? show?.images?.[0]?.url ?? null,
        durationMs: Number(t.duration_ms ?? 0),
        uri: String(t.uri ?? ""),
        url: (t.external_urls as { spotify?: string } | undefined)?.spotify,
      };
    }

    async function poll(force = false) {
      if (Date.now() < pausedUntil && !force) return;
      if (!tokens()) {
        if (state.connected || force) {
          state = empty();
          events.publish("state", state);
        }
        return;
      }
      try {
        const [player, devices] = await Promise.all([
          api<Record<string, unknown>>("/me/player?additional_types=track,episode"),
          api<{ devices: Array<{ id: string; name: string; type: string; is_active: boolean; volume_percent: number | null }> }>("/me/player/devices"),
        ]);
        if (!state.account || force) {
          const me = await api<{ display_name: string; images?: Array<{ url: string }>; product: string }>("/me").catch(() => null);
          if (me) state.account = { name: me.display_name, image: me.images?.[0]?.url ?? null, product: me.product };
        }
        const dev = (player?.device as Record<string, unknown> | undefined) ?? null;
        state = {
          ...state,
          provider: "spotify",
          connected: true,
          playing: !!player?.is_playing,
          track: mapTrack(player?.item as Record<string, unknown>),
          progressMs: Number(player?.progress_ms ?? 0),
          shuffle: !!player?.shuffle_state,
          repeat: (player?.repeat_state as PlayerState["repeat"]) ?? "off",
          volume: dev ? (dev.volume_percent as number | null) : null,
          device: dev ? mapDevice(dev as never) : null,
          devices: (devices?.devices ?? []).map(mapDevice),
          context: (player?.context as PlayerState["context"]) ?? null,
          updatedAt: new Date().toISOString(),
          error: undefined,
        };
      } catch (err) {
        const e = err as Error & { status?: number };
        state = { ...state, connected: e.status !== 401, error: e.message, updatedAt: new Date().toISOString() };
      }
      // only broadcast when something other than progress changed (clients interpolate progress themselves)
      const sig = JSON.stringify({ ...state, progressMs: 0, updatedAt: "" });
      if (sig !== lastSig || force) {
        lastSig = sig;
        events.publish("state", state);
      }
    }

    const schedule = () => ctx.scheduler.every("poll", (settings.get().pollSeconds ?? 10) * 1000, () => poll(), { immediate: true });
    schedule();
    settings.onChange(schedule);

    /* ---------- api for clients ---------- */

    const ok = (c: Context) => c.json({ ok: true });
    const wrap = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
      try {
        const r = await fn(c);
        setTimeout(() => void poll(true), 400);
        return r;
      } catch (err) {
        const e = err as Error & { status?: number };
        return c.json({ error: e.message }, (e.status === 401 || e.status === 403 || e.status === 404 ? e.status : 502) as 401);
      }
    };

    http.get("/state", (c) => c.json({ ...state, configured: !!clientId(), premium: state.account?.product === "premium" }));
    http.post("/refresh", wrap(async (c) => { await poll(true); return c.json(state); }));
    http.post("/play", wrap(async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { uri?: string; contextUri?: string; deviceId?: string; uris?: string[] };
      const q = b.deviceId ? `?device_id=${encodeURIComponent(b.deviceId)}` : "";
      const body = b.contextUri ? { context_uri: b.contextUri } : b.uris?.length ? { uris: b.uris } : b.uri ? (b.uri.includes(":track:") || b.uri.includes(":episode:") ? { uris: [b.uri] } : { context_uri: b.uri }) : undefined;
      await api(`/me/player/play${q}`, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
      return ok(c);
    }));
    http.post("/pause", wrap(async (c) => { await api("/me/player/pause", { method: "PUT" }); return ok(c); }));
    http.post("/next", wrap(async (c) => { await api("/me/player/next", { method: "POST" }); return ok(c); }));
    http.post("/previous", wrap(async (c) => { await api("/me/player/previous", { method: "POST" }); return ok(c); }));
    http.post("/seek", wrap(async (c) => { const b = (await c.req.json()) as { positionMs: number }; await api(`/me/player/seek?position_ms=${Math.max(0, Math.round(b.positionMs))}`, { method: "PUT" }); return ok(c); }));
    http.post("/volume", wrap(async (c) => { const b = (await c.req.json()) as { percent: number; deviceId?: string }; await api(`/me/player/volume?volume_percent=${Math.min(100, Math.max(0, Math.round(b.percent)))}${b.deviceId ? `&device_id=${b.deviceId}` : ""}`, { method: "PUT" }); return ok(c); }));
    http.post("/shuffle", wrap(async (c) => { const b = (await c.req.json()) as { on: boolean }; await api(`/me/player/shuffle?state=${b.on}`, { method: "PUT" }); return ok(c); }));
    http.post("/repeat", wrap(async (c) => { const b = (await c.req.json()) as { mode: "off" | "track" | "context" }; await api(`/me/player/repeat?state=${b.mode}`, { method: "PUT" }); return ok(c); }));
    http.post("/transfer", wrap(async (c) => { const b = (await c.req.json()) as { deviceId: string; play?: boolean }; await api("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [b.deviceId], play: b.play ?? true }) }); return ok(c); }));
    http.post("/queue", wrap(async (c) => { const b = (await c.req.json()) as { uri: string }; await api(`/me/player/queue?uri=${encodeURIComponent(b.uri)}`, { method: "POST" }); return ok(c); }));

    http.get("/queue", wrap(async (c) => {
      const q = await api<{ currently_playing: Record<string, unknown>; queue: Record<string, unknown>[] }>("/me/player/queue");
      return c.json({ current: mapTrack(q?.currently_playing), queue: (q?.queue ?? []).map((t) => mapTrack(t)).filter(Boolean).slice(0, 20) });
    }));
    http.get("/playlists", wrap(async (c) => {
      const p = await api<{ items: Array<{ id: string; name: string; uri: string; images?: Array<{ url: string }>; tracks?: { total: number }; owner?: { display_name?: string } }> }>("/me/playlists?limit=50");
      return c.json((p?.items ?? []).map((x) => ({ id: x.id, name: x.name, uri: x.uri, cover: x.images?.[0]?.url ?? null, tracks: x.tracks?.total ?? 0, owner: x.owner?.display_name ?? "" })));
    }));
    http.get("/recent", wrap(async (c) => {
      const r = await api<{ items: Array<{ track: Record<string, unknown>; context?: { uri: string; type: string } | null }> }>("/me/player/recently-played?limit=20");
      const seen = new Set<string>();
      const out: Array<Track & { context: { uri: string; type: string } | null }> = [];
      for (const it of r?.items ?? []) {
        const t = mapTrack(it.track);
        if (!t || seen.has(t.id)) continue;
        seen.add(t.id);
        out.push({ ...t, context: it.context ?? null });
      }
      return c.json(out);
    }));
    http.get("/search", wrap(async (c) => {
      const q = c.req.query("q")?.trim();
      if (!q) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
      const r = await api<Record<string, { items: Array<Record<string, unknown>> }>>(`/search?type=track,album,artist,playlist&limit=8&q=${encodeURIComponent(q)}`);
      const simple = (x: Record<string, unknown>) => ({ id: String(x.id), name: String(x.name ?? ""), uri: String(x.uri ?? ""), cover: ((x.images as Array<{ url: string }> | undefined) ?? [])[0]?.url ?? null, sub: ((x.artists as Array<{ name: string }> | undefined) ?? []).map((a) => a.name).join(", ") || String((x.owner as { display_name?: string } | undefined)?.display_name ?? "") });
      return c.json({
        tracks: (r?.tracks?.items ?? []).map((t) => mapTrack(t)).filter(Boolean),
        albums: (r?.albums?.items ?? []).filter(Boolean).map(simple),
        artists: (r?.artists?.items ?? []).filter(Boolean).map(simple),
        playlists: (r?.playlists?.items ?? []).filter(Boolean).map(simple),
      });
    }));

    logger.info(`media ready (spotify ${tokens() ? "connected" : "not connected"})`);
  },
});
