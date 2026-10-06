import { createHash, randomBytes } from "node:crypto";
import { defineModule, parseBody, z } from "@orbis/sdk/server";
import type { Context } from "hono";

/**
 * Media module. Provider based; Spotify is the first provider (Web API, PKCE auth, no client secret).
 * Apple Music and YouTube Music have no third-party playback-control api, so they are not providers here.
 * Future providers: Home Assistant media_player entities, Sonos, Chromecast, MPD.
 */

type Settings = { spotifyClientId?: string; pollSeconds?: number; provider?: "spotify" | "ha" };

export type ProviderId = "spotify" | "ha";
export type ProviderInfo = { id: ProviderId; name: string; available: boolean; reason?: string };

export type Device = { id: string; name: string; type: string; active: boolean; volume: number | null; provider: ProviderId };
export type Track = { id: string; title: string; artists: string[]; album: string; cover: string | null; durationMs: number; uri: string; url?: string };
export type PlayerState = {
  provider: ProviderId;
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

const SCOPES = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing", "user-read-private", "user-read-email", "streaming", "playlist-read-private", "playlist-read-collaborative", "user-library-read", "user-read-recently-played"].join(" ");

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** origin as the browser sees it: behind a tls proxy the Host header is the internal one, x-forwarded-* carry the public one */
export function publicOrigin(c: Context): string {
  const u = new URL(c.req.url);
  const first = (v: string | undefined) => v?.split(",")[0]?.trim() ?? "";
  const proto = first(c.req.header("x-forwarded-proto")).replace(/:$/, "") || u.protocol.replace(/:$/, "");
  const host = first(c.req.header("x-forwarded-host")) || c.req.header("host") || u.host;
  return /^https?$/.test(proto) && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${proto}://${host}` : u.origin;
}

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
        throw Object.assign(new Error(ctx.i18n.t("error.rateLimit", { seconds: Math.round((pausedUntil - Date.now()) / 1000) })), { status: 429 });
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
      const origin = publicOrigin(c);
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
      if (!pending) return c.text(ctx.i18n.t("error.loginExpired"), 400);
      if (c.req.query("error")) return c.redirect(`${pending.back}${pending.back.includes("?") ? "&" : "?"}spotify_error=${encodeURIComponent(c.req.query("error")!)}`);
      const res = await ctx.fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: c.req.query("code") ?? "", redirect_uri: pending.redirectUri, client_id: clientId(), code_verifier: pending.verifier }),
      });
      if (!res.ok) return c.text(ctx.i18n.t("error.tokenExchange", { detail: await res.text() }), 400);
      const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
      storage.set("spotify:tokens", { access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000, scope: j.scope } satisfies Tokens);
      logger.info("spotify connected");
      reportStatus();
      void poll(true);
      return c.redirect(pending.back);
    });

    http.post("/spotify/logout", (c) => {
      storage.delete("spotify:tokens");
      state = empty();
      events.publish("state", state);
      reportStatus();
      return c.json({ ok: true });
    });

    /* ---------- providers ----------
     * spotify is the default. "ha" mirrors home assistant media_player entities (sonos, chromecast, kodi, …)
     * through the home-assistant module (soft dep); every entity is a "device", the selected one is the player. */
    type HaEntity = { id: string; state: string; attributes: Record<string, unknown>; name: string };
    const haAvailable = () => ctx.modules.has("home-assistant");
    const providerId = (): ProviderId => (settings.get().provider === "ha" && haAvailable() ? "ha" : "spotify");
    const providers = (): ProviderInfo[] => [
      { id: "spotify", name: "spotify", available: !!clientId(), reason: clientId() ? undefined : ctx.i18n.t("reason.clientIdMissing") },
      { id: "ha", name: "home assistant", available: haAvailable(), reason: haAvailable() ? undefined : ctx.i18n.t("reason.haMissing") },
    ];
    const haSelected = () => storage.get<string>("ha:selected") ?? null;
    let haBase = "";
    const haCall = (service: string, data: Record<string, unknown> = {}, entity: string | null | undefined = state.device?.id ?? haSelected()) => {
      if (!entity) throw Object.assign(new Error("pick a media player first"), { status: 404 });
      return ctx.modules.call("home-assistant", "/call", { method: "POST", json: { domain: "media_player", service, entity, data } });
    };
    const haPicture = (p: string) => (p.startsWith("http") ? p : `${haBase}${p}`);
    async function haState(): Promise<PlayerState> {
      if (!haBase) haBase = ((await ctx.modules.call<{ url?: string }>("home-assistant", "/status").catch(() => null))?.url ?? "").replace(/\/+$/, "");
      const list = (await ctx.modules.call<HaEntity[]>("home-assistant", "/entities?domain=media_player")) ?? [];
      const sel = list.find((e) => e.id === haSelected()) ?? list.find((e) => e.state === "playing") ?? list[0] ?? null;
      const devices: Device[] = list.map((e) => ({ id: e.id, name: e.name, type: String(e.attributes.device_class ?? (e.id.includes("tv") ? "tv" : "speaker")), active: sel?.id === e.id, volume: e.attributes.volume_level != null ? Math.round(Number(e.attributes.volume_level) * 100) : null, provider: "ha" }));
      const a = sel?.attributes ?? {};
      const playing = sel?.state === "playing";
      const pos = a.media_position != null ? Number(a.media_position) * 1000 : 0;
      const posAt = a.media_position_updated_at ? new Date(String(a.media_position_updated_at)).getTime() : Date.now();
      const track: Track | null = sel && a.media_title ? { id: String(a.media_content_id ?? a.media_title), title: String(a.media_title), artists: a.media_artist ? [String(a.media_artist)] : a.media_series_title ? [String(a.media_series_title)] : [], album: String(a.media_album_name ?? a.app_name ?? ""), cover: a.entity_picture ? haPicture(String(a.entity_picture)) : null, durationMs: a.media_duration != null ? Number(a.media_duration) * 1000 : 0, uri: String(a.media_content_id ?? "") } : null;
      return {
        provider: "ha",
        connected: list.length > 0,
        account: { name: "home assistant", image: null, product: "premium" },
        playing,
        track,
        progressMs: playing ? pos + (Date.now() - posAt) : pos,
        shuffle: !!a.shuffle,
        repeat: (["off", "one", "all"].includes(String(a.repeat)) ? (a.repeat === "one" ? "track" : a.repeat === "all" ? "context" : "off") : "off") as PlayerState["repeat"],
        volume: sel && a.volume_level != null ? Math.round(Number(a.volume_level) * 100) : null,
        device: devices.find((d) => d.active) ?? null,
        devices,
        context: null,
        updatedAt: new Date().toISOString(),
        error: list.length ? undefined : ctx.i18n.t("error.noHaPlayers"),
      };
    }

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
      if (providerId() === "ha") {
        try {
          state = await haState();
        } catch (err) {
          state = { ...empty(), provider: "ha", error: (err as Error).message };
        }
        const sigHa = JSON.stringify({ ...state, progressMs: 0, updatedAt: "" });
        if (sigHa !== lastSig || force) {
          lastSig = sigHa;
          events.publish("state", state);
        }
        return;
      }
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
    const reportStatus = () => {
      const t = ctx.i18n.t;
      if (providerId() === "ha") ctx.status.set({ state: "ok" });
      else if (!clientId()) ctx.status.set({ state: "needs-setup", message: t("status.needsClientId"), action: { label: t("status.settings"), settings: true } });
      else if (!tokens()) ctx.status.set({ state: "needs-setup", message: t("status.notConnected"), action: { label: t("status.connect"), page: "media" } });
      else ctx.status.set({ state: "ok" });
    };
    reportStatus();
    schedule();
    ctx.i18n.onChange(() => {
      reportStatus();
      lastSig = ""; // re-broadcast so translated provider reasons / errors reach clients
      void poll(true);
    });
    ctx.modules.onChange(() => {
      haBase = "";
      reportStatus();
      void poll(true);
    });
    settings.onChange(() => {
      reportStatus();
      schedule();
    });

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

    http.get("/state", (c) => c.json({ ...state, configured: !!clientId(), premium: providerId() === "ha" || state.account?.product === "premium", providers: providers() }));
    http.get("/providers", (c) => c.json({ current: providerId(), providers: providers() }));
    http.post("/provider", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { id?: ProviderId };
      if (b.id !== "spotify" && b.id !== "ha") return c.json({ error: "spotify or ha" }, 400);
      if (b.id === "ha" && !haAvailable()) return c.json({ error: "home assistant module is not installed" }, 409);
      settings.set({ provider: b.id });
      lastSig = "";
      await poll(true);
      return c.json({ current: providerId(), providers: providers() });
    });
    /** access token for the spotify web playback sdk running in a browser tab (session-protected like every other route) */
    http.get("/spotify/token", async (c) => {
      const access = await refreshIfNeeded();
      if (!access) return c.json({ error: "spotify not connected" }, 401);
      return c.json({ token: access, expiresAt: tokens()?.expiresAt ?? null });
    });
    http.post("/refresh", wrap(async (c) => { await poll(true); return c.json(state); }));
    http.post("/play", wrap(async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { uri?: string; contextUri?: string; deviceId?: string; uris?: string[] };
      const q = b.deviceId ? `?device_id=${encodeURIComponent(b.deviceId)}` : "";
      const body = b.contextUri ? { context_uri: b.contextUri } : b.uris?.length ? { uris: b.uris } : b.uri ? (b.uri.includes(":track:") || b.uri.includes(":episode:") ? { uris: [b.uri] } : { context_uri: b.uri }) : undefined;
      if (providerId() === "ha") {
        const target = b.deviceId ?? haSelected() ?? undefined;
        if (b.uri || b.contextUri) await haCall("play_media", { media_content_id: b.contextUri ?? b.uri, media_content_type: "music" }, target);
        else await haCall("media_play", {}, target);
        return ok(c);
      }
      await api(`/me/player/play${q}`, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
      return ok(c);
    }));
    http.post("/pause", wrap(async (c) => { if (providerId() === "ha") { await haCall("media_pause"); return ok(c); } await api("/me/player/pause", { method: "PUT" }); return ok(c); }));
    http.post("/next", wrap(async (c) => { if (providerId() === "ha") { await haCall("media_next_track"); return ok(c); } await api("/me/player/next", { method: "POST" }); return ok(c); }));
    http.post("/previous", wrap(async (c) => { if (providerId() === "ha") { await haCall("media_previous_track"); return ok(c); } await api("/me/player/previous", { method: "POST" }); return ok(c); }));
    // control routes: a missing / invalid body is the caller's fault (400), not an upstream failure (502)
    const deviceId = z.string().trim().min(1).max(200);
    http.post("/seek", wrap(async (c) => {
      const b = await parseBody(c, z.object({ positionMs: z.number().finite().min(0) }));
      if (!b.ok) return b.res;
      if (providerId() === "ha") { await haCall("media_seek", { seek_position: b.data.positionMs / 1000 }); return ok(c); }
      await api(`/me/player/seek?position_ms=${Math.round(b.data.positionMs)}`, { method: "PUT" });
      return ok(c);
    }));
    http.post("/volume", wrap(async (c) => {
      const b = await parseBody(c, z.object({ percent: z.number().finite().min(0).max(100), deviceId: deviceId.optional() }));
      if (!b.ok) return b.res;
      if (providerId() === "ha") { await haCall("volume_set", { volume_level: b.data.percent / 100 }, b.data.deviceId ?? haSelected()); return ok(c); }
      await api(`/me/player/volume?volume_percent=${Math.round(b.data.percent)}${b.data.deviceId ? `&device_id=${encodeURIComponent(b.data.deviceId)}` : ""}`, { method: "PUT" });
      return ok(c);
    }));
    http.post("/shuffle", wrap(async (c) => {
      const b = await parseBody(c, z.object({ on: z.boolean() }));
      if (!b.ok) return b.res;
      if (providerId() === "ha") { await haCall("shuffle_set", { shuffle: b.data.on }); return ok(c); }
      await api(`/me/player/shuffle?state=${b.data.on}`, { method: "PUT" });
      return ok(c);
    }));
    http.post("/repeat", wrap(async (c) => {
      const b = await parseBody(c, z.object({ mode: z.enum(["off", "track", "context"]) }));
      if (!b.ok) return b.res;
      if (providerId() === "ha") { await haCall("repeat_set", { repeat: b.data.mode === "track" ? "one" : b.data.mode === "context" ? "all" : "off" }); return ok(c); }
      await api(`/me/player/repeat?state=${b.data.mode}`, { method: "PUT" });
      return ok(c);
    }));
    http.post("/transfer", wrap(async (c) => {
      const b = await parseBody(c, z.object({ deviceId, play: z.boolean().optional() }));
      if (!b.ok) return b.res;
      if (providerId() === "ha") { storage.set("ha:selected", b.data.deviceId); lastSig = ""; return ok(c); }
      await api("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [b.data.deviceId], play: b.data.play ?? true }) });
      return ok(c);
    }));
    http.post("/queue", wrap(async (c) => {
      const b = await parseBody(c, z.object({ uri: z.string().trim().min(1).max(500) }));
      if (!b.ok) return b.res;
      if (providerId() === "ha") { await haCall("play_media", { media_content_id: b.data.uri, media_content_type: "music", enqueue: "add" }); return ok(c); }
      await api(`/me/player/queue?uri=${encodeURIComponent(b.data.uri)}`, { method: "POST" });
      return ok(c);
    }));

    http.get("/queue", wrap(async (c) => {
      if (providerId() === "ha") return c.json({ current: state.track, queue: [] });
      const q = await api<{ currently_playing: Record<string, unknown>; queue: Record<string, unknown>[] }>("/me/player/queue");
      return c.json({ current: mapTrack(q?.currently_playing), queue: (q?.queue ?? []).map((t) => mapTrack(t)).filter(Boolean).slice(0, 20) });
    }));
    http.get("/playlists", wrap(async (c) => {
      if (providerId() === "ha") return c.json([]);
      const p = await api<{ items: Array<{ id: string; name: string; uri: string; images?: Array<{ url: string }>; tracks?: { total: number }; owner?: { display_name?: string } }> }>("/me/playlists?limit=50");
      return c.json((p?.items ?? []).map((x) => ({ id: x.id, name: x.name, uri: x.uri, cover: x.images?.[0]?.url ?? null, tracks: x.tracks?.total ?? 0, owner: x.owner?.display_name ?? "" })));
    }));
    http.get("/recent", wrap(async (c) => {
      if (providerId() === "ha") return c.json([]);
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
    const searchCache = new Map<string, { at: number; value: unknown }>();
    http.get("/search", wrap(async (c) => {
      const q = c.req.query("q")?.trim().toLowerCase();
      if (!q || providerId() === "ha") return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
      const types = (c.req.query("types") ?? "track,album,artist,playlist").split(",").filter((t) => ["track", "album", "artist", "playlist"].includes(t)).join(",") || "track";
      const limit = Math.min(10, Math.max(1, Number(c.req.query("limit") ?? 8)));
      const key = `${types}|${limit}|${q}`;
      const hit = searchCache.get(key);
      if (hit && Date.now() - hit.at < 5 * 60_000) return c.json(hit.value);
      if (searchCache.size > 200) searchCache.clear();
      const r = await api<Record<string, { items: Array<Record<string, unknown>> }>>(`/search?type=${types}&limit=${limit}&q=${encodeURIComponent(q)}`);
      const simple = (x: Record<string, unknown>) => ({ id: String(x.id), name: String(x.name ?? ""), uri: String(x.uri ?? ""), cover: ((x.images as Array<{ url: string }> | undefined) ?? [])[0]?.url ?? null, sub: ((x.artists as Array<{ name: string }> | undefined) ?? []).map((a) => a.name).join(", ") || String((x.owner as { display_name?: string } | undefined)?.display_name ?? "") });
      const value = {
        tracks: (r?.tracks?.items ?? []).map((t) => mapTrack(t)).filter(Boolean),
        albums: (r?.albums?.items ?? []).filter(Boolean).map(simple),
        artists: (r?.artists?.items ?? []).filter(Boolean).map(simple),
        playlists: (r?.playlists?.items ?? []).filter(Boolean).map(simple),
      };
      searchCache.set(key, { at: Date.now(), value });
      return c.json(value);
    }));

    logger.info(`media ready (spotify ${tokens() ? "connected" : "not connected"})`);
  },
});
