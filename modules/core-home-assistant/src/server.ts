import { defineModule } from "@orbis/sdk/server";
import { startMqttBridge, type MqttSettings } from "./mqtt";

/**
 * Home Assistant over its websocket api: one connection, subscribe to state_changed, keep an entity map,
 * push changes to clients, call services on demand. Rest api only for history.
 */

type Settings = { url?: string; token?: string } & MqttSettings;

export type Entity = {
  id: string;
  domain: string;
  state: string;
  attributes: Record<string, unknown>;
  name: string;
  lastChanged: string;
  unit?: string;
  icon?: string;
};

type HaMsg = { id?: number; type: string; success?: boolean; result?: unknown; error?: { message: string }; event?: { event_type: string; data: { entity_id: string; new_state: HaState | null } } };
type HaState = { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string };

export default defineModule<Settings>({
  setup(ctx) {
    const { http, events, logger, settings } = ctx;
    const entities = new Map<string, Entity>();
    let ws: WebSocket | null = null;
    let msgId = 1;
    let connected = false;
    /** last connection error as a locale key (+vars) so it is re-translated when the hub language changes */
    let lastError: { key: string; vars?: Record<string, string> } | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let stopped = false;

    const base = () => (settings.get().url ?? "").trim().replace(/\/+$/, "");
    const token = () => (settings.get().token ?? "").trim();
    const errorText = () => (lastError ? ctx.i18n.t(lastError.key, lastError.vars) : null);

    const toEntity = (s: HaState): Entity => ({
      id: s.entity_id,
      domain: s.entity_id.split(".")[0] ?? "",
      state: s.state,
      attributes: s.attributes,
      name: String(s.attributes.friendly_name ?? s.entity_id),
      lastChanged: s.last_changed,
      unit: s.attributes.unit_of_measurement as string | undefined,
      icon: s.attributes.icon as string | undefined,
    });

    const reportStatus = () => {
      const t = ctx.i18n.t;
      if (!base() || !token()) ctx.status.set({ state: "needs-setup", message: t("status.needsSetup"), action: { label: t("status.settings"), settings: true } });
      else if (!connected) ctx.status.set({ state: lastError ? "error" : "warning", message: errorText() ?? t("status.connecting"), action: { label: t("status.settings"), settings: true } });
      else ctx.status.set({ state: "ok" });
    };
    const offLanguage = ctx.i18n.onChange(() => reportStatus());

    function send(msg: Record<string, unknown>): Promise<unknown> {
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected to home assistant"));
      const id = msgId++;
      ws.send(JSON.stringify({ id, ...msg }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error("home assistant did not answer"));
        }, 15_000);
      });
    }

    function connect() {
      if (stopped) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (!base() || !token()) {
        reportStatus();
        return;
      }
      const url = base().replace(/^http/, "ws") + "/api/websocket";
      try {
        ws = new WebSocket(url);
      } catch (err) {
        lastError = { key: "error.unreachable", vars: { url: base() } };
        logger.warn(`websocket failed: ${(err as Error).message}`);
        reportStatus();
        scheduleReconnect();
        return;
      }
      ws.onopen = () => logger.debug("ws open");
      ws.onmessage = async (ev) => {
        let m: HaMsg;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.type === "auth_required") ws!.send(JSON.stringify({ type: "auth", access_token: token() }));
        else if (m.type === "auth_invalid") {
          lastError = { key: "error.tokenRejected" };
          connected = false;
          reportStatus();
          ws?.close();
        } else if (m.type === "auth_ok") {
          connected = true;
          lastError = null;
          logger.info("connected to home assistant");
          try {
            const states = (await send({ type: "get_states" })) as HaState[];
            entities.clear();
            for (const s of states) entities.set(s.entity_id, toEntity(s));
            await send({ type: "subscribe_events", event_type: "state_changed" });
            events.publish("states", { count: entities.size });
          } catch (err) {
            logger.warn(`initial sync failed: ${(err as Error).message}`);
          }
          reportStatus();
        } else if (m.type === "result" && m.id !== undefined) {
          const p = pending.get(m.id);
          if (p) {
            pending.delete(m.id);
            if (m.success) p.resolve(m.result);
            else p.reject(new Error(m.error?.message ?? "home assistant error"));
          }
        } else if (m.type === "event" && m.event?.event_type === "state_changed") {
          const ns = m.event.data.new_state;
          if (!ns) {
            entities.delete(m.event.data.entity_id);
            return;
          }
          const e = toEntity(ns);
          entities.set(e.id, e);
          events.publish("state", e);
        }
      };
      ws.onerror = () => {
        lastError = { key: "error.unreachable", vars: { url: base() } };
      };
      ws.onclose = () => {
        connected = false;
        reportStatus();
        for (const p of pending.values()) p.reject(new Error("connection closed"));
        pending.clear();
        scheduleReconnect();
      };
    }
    function scheduleReconnect() {
      if (stopped || reconnectTimer) return;
      reconnectTimer = setTimeout(connect, 10_000);
    }

    reportStatus();
    connect();
    settings.onChange(() => {
      lastError = null;
      ws?.close();
      ws = null;
      connect();
    });

    /* ---- rest helper (history) ---- */
    async function rest<T>(path: string): Promise<T> {
      const res = await ctx.fetch(`${base()}/api${path}`, { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`home assistant HTTP ${res.status}`);
      return (await res.json()) as T;
    }

    /* ---- api ---- */
    http.get("/status", (c) => c.json({ connected, error: errorText(), url: base(), entities: entities.size, configured: !!(base() && token()) }));
    http.get("/entities", (c) => {
      const domain = c.req.query("domain");
      const q = c.req.query("q")?.toLowerCase();
      const ids = c.req.query("ids")?.split(",").filter(Boolean);
      let list = [...entities.values()];
      if (ids) list = ids.map((id) => entities.get(id)).filter((e): e is Entity => !!e);
      if (domain) list = list.filter((e) => domain.split(",").includes(e.domain));
      if (q) list = list.filter((e) => e.id.includes(q) || e.name.toLowerCase().includes(q));
      list.sort((a, b) => a.name.localeCompare(b.name));
      return c.json(list.slice(0, Number(c.req.query("limit") ?? 500)));
    });
    http.get("/entities/:id", (c) => {
      const e = entities.get(c.req.param("id"));
      return e ? c.json(e) : c.json({ error: "unknown entity" }, 404);
    });
    http.post("/call", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { domain?: string; service?: string; entity?: string; data?: Record<string, unknown> };
      if (!b.domain || !b.service) return c.json({ error: "domain and service required" }, 400);
      try {
        await send({ type: "call_service", domain: b.domain, service: b.service, service_data: { ...(b.data ?? {}), ...(b.entity ? { entity_id: b.entity } : {}) } });
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    });
    http.post("/toggle", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { entity?: string };
      const e = b.entity ? entities.get(b.entity) : null;
      if (!e) return c.json({ error: "unknown entity" }, 404);
      const domain = ["light", "switch", "fan", "input_boolean", "automation", "media_player", "cover", "lock"].includes(e.domain) ? e.domain : "homeassistant";
      const service = e.domain === "cover" ? (e.state === "open" ? "close_cover" : "open_cover") : e.domain === "lock" ? (e.state === "locked" ? "unlock" : "lock") : "toggle";
      try {
        await send({ type: "call_service", domain, service, service_data: { entity_id: e.id } });
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    });
    http.get("/history/:id", async (c) => {
      // last 24h, thinned to ~96 points for sparklines
      const id = c.req.param("id");
      try {
        const start = new Date(Date.now() - 24 * 3600_000).toISOString();
        const raw = await rest<HaState[][]>(`/history/period/${start}?filter_entity_id=${encodeURIComponent(id)}&minimal_response&no_attributes`);
        const pts = (raw[0] ?? []).map((s) => ({ t: s.last_changed, v: Number(s.state) })).filter((p) => Number.isFinite(p.v));
        const step = Math.max(1, Math.floor(pts.length / 96));
        return c.json(pts.filter((_, i) => i % step === 0));
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    });

    /* ---- mqtt bridge: orbis as a device in HA ---- */
    let mqttState: { connected: boolean; error: string | null; entities: string[] } = { connected: false, error: null, entities: [] };
    let stopMqtt: () => void = () => undefined;
    const startMqtt = () => {
      stopMqtt();
      stopMqtt = startMqttBridge(ctx, (st) => {
        mqttState = st;
        events.publish("mqtt", st);
      });
    };
    startMqtt();
    const offSettings = settings.onChange(() => startMqtt());
    http.get("/mqtt/status", (c) => c.json({ ...mqttState, enabled: !!settings.get().mqttEnabled, url: settings.get().mqttUrl ?? null, prefix: settings.get().mqttPrefix || "orbis" }));

    logger.info("home assistant module ready");
    shutdownFn = () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      offSettings();
      offLanguage();
      stopMqtt();
    };

    /* ---- e-ink ---- */
    einkRender = (req) => {
      const cfg = req.config as { entity?: string; entities?: string[]; name?: string; decimals?: number };
      const fmt = (e: Entity) => (Number.isFinite(Number(e.state)) ? `${Number(e.state).toFixed(cfg.decimals ?? 1)}${e.unit ? ` ${e.unit}` : ""}` : e.state);
      if (req.widget === "group" || req.widget === "scenes") {
        const list = (cfg.entities ?? []).map((id) => entities.get(id)).filter((e): e is Entity => !!e);
        return { type: "col", grow: 1, gap: 4, children: list.map((e) => ({ type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "text" as const, text: e.name, size: 13, pixel: false, grow: 1, wrap: false }, { type: "text" as const, text: fmt(e), size: 13, bold: e.state === "on" }] })) };
      }
      const e = cfg.entity ? entities.get(cfg.entity) : null;
      if (!e) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: cfg.entity ?? ctx.i18n.t("eink.noEntity"), size: 12, gray: 0.5 }] };
      const big = Math.max(18, Math.min(req.height * 0.45, req.width / 5));
      return { type: "col", grow: 1, align: "center", justify: "center", gap: 2, children: [{ type: "text", text: cfg.name ?? e.name, size: 12, gray: 0.5 }, { type: "text", text: fmt(e), size: big }] };
    };
  },
  teardown() {
    shutdownFn?.();
    shutdownFn = null;
    einkRender = null;
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
let shutdownFn: (() => void) | null = null;
