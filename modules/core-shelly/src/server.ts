import type { Device } from "@orbis/sdk";
import { defineModule } from "@orbis/sdk/server";

/**
 * Shelly over the local http api. Devices come from the hub's device registry (mdns _shelly._tcp) or are added by ip.
 * Gen2+ (Plus/Pro/Mini, firmware 1.x): /rpc/Shelly.GetDeviceInfo, /rpc/Shelly.GetStatus, /rpc/Switch.Set
 * Gen1 (classic 1/1PM/2.5/Plug S): /shelly, /status, /relay/<n>?turn=on
 */

export type ShellyDevice = {
  id: string; // registry device id or "ip:<ip>"
  ip: string;
  name: string;
  model: string | null;
  gen: 1 | 2;
  mac: string | null;
  online: boolean;
  channels: Array<{ id: number; on: boolean; power: number | null; energyWh: number | null; name: string | null }>;
  temperature: number | null;
  updatedAt: string;
  error: string | null;
};

/** `host[:port]` where host is a valid ipv4 (each octet ≤ 255) or a dns hostname; null for anything else ("999.1.1", "a..b", "http://x") */
export function normalizeHost(input: string): string | null {
  const s = input.trim().toLowerCase();
  const m = s.match(/^([^:/\s]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const host = m[1]!;
  const port = m[2] !== undefined ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (/^[\d.]+$/.test(host)) {
    const o = host.split(".");
    if (o.length !== 4 || o.some((x) => x === "" || Number(x) > 255)) return null;
  } else if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/.test(host) || host.length > 253) return null;
  try {
    new URL(`http://${s}`);
  } catch {
    return null;
  }
  return s;
}

export default defineModule({
  setup(ctx) {
    const { http, storage, events, logger, devices } = ctx;
    const state = new Map<string, ShellyDevice>();
    const manual = () => storage.get<string[]>("manualIps") ?? [];

    /** which ips to poll: claimed registry devices + manual ips */
    const targets = (): Array<{ id: string; ip: string; name: string | null; mac: string | null }> => {
      const out: Array<{ id: string; ip: string; name: string | null; mac: string | null }> = [];
      for (const d of devices.claimed()) out.push({ id: d.id, ip: d.ip, name: d.label ?? d.hostname, mac: d.mac });
      for (const ip of manual()) if (!out.some((t) => t.ip === ip)) out.push({ id: `ip:${ip}`, ip, name: null, mac: null });
      return out;
    };

    const get = async <T,>(ip: string, path: string): Promise<T> => {
      const res = await ctx.fetch(`http://${ip}${path}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    };

    async function poll(t: { id: string; ip: string; name: string | null; mac: string | null }): Promise<ShellyDevice> {
      const prev = state.get(t.id);
      try {
        // gen2 first
        try {
          const info = await get<{ id: string; model: string; gen: number; mac: string; name?: string | null }>(t.ip, "/rpc/Shelly.GetDeviceInfo");
          const status = await get<Record<string, unknown>>(t.ip, "/rpc/Shelly.GetStatus");
          const channels: ShellyDevice["channels"] = [];
          for (const [k, v] of Object.entries(status)) {
            const m = k.match(/^switch:(\d+)$/);
            if (!m) continue;
            const s = v as { output: boolean; apower?: number; aenergy?: { total?: number } };
            channels.push({ id: Number(m[1]), on: !!s.output, power: s.apower ?? null, energyWh: s.aenergy?.total ?? null, name: null });
          }
          const temp = (status["temperature:0"] as { tC?: number } | undefined)?.tC ?? (status["switch:0"] as { temperature?: { tC?: number } } | undefined)?.temperature?.tC ?? null;
          const d: ShellyDevice = { id: t.id, ip: t.ip, name: t.name ?? info.name ?? info.id, model: info.model, gen: 2, mac: info.mac ?? t.mac, online: true, channels: channels.sort((a, b) => a.id - b.id), temperature: temp, updatedAt: new Date().toISOString(), error: null };
          state.set(t.id, d);
          return d;
        } catch (e) {
          if (!/HTTP 404/.test((e as Error).message)) throw e;
        }
        // gen1
        const shelly = await get<{ type: string; mac: string }>(t.ip, "/shelly");
        const status = await get<{ relays?: Array<{ ison: boolean }>; meters?: Array<{ power?: number; total?: number }>; temperature?: number }>(t.ip, "/status");
        const channels: ShellyDevice["channels"] = (status.relays ?? []).map((r, i) => ({ id: i, on: r.ison, power: status.meters?.[i]?.power ?? null, energyWh: status.meters?.[i]?.total != null ? status.meters[i]!.total! / 60 : null, name: null }));
        const d: ShellyDevice = { id: t.id, ip: t.ip, name: t.name ?? shelly.type, model: shelly.type, gen: 1, mac: shelly.mac ?? t.mac, online: true, channels, temperature: status.temperature ?? null, updatedAt: new Date().toISOString(), error: null };
        state.set(t.id, d);
        return d;
      } catch (err) {
        const d: ShellyDevice = { ...(prev ?? { id: t.id, ip: t.ip, name: t.name ?? t.ip, model: null, gen: 2, mac: t.mac, channels: [], temperature: null }), online: false, updatedAt: new Date().toISOString(), error: (err as Error).message };
        state.set(t.id, d);
        return d;
      }
    }

    async function pollAll() {
      const ts = targets();
      for (const id of [...state.keys()]) if (!ts.some((t) => t.id === id)) state.delete(id);
      await Promise.all(ts.map(poll));
      events.publish("state", [...state.values()]);
      reportStatus();
    }
    const reportStatus = () => {
      const t = ctx.i18n.t;
      const all = [...state.values()];
      const found = devices.suggested().length;
      if (!targets().length) ctx.status.set({ state: "needs-setup", message: found ? t("status.found", { count: found }) : t("status.none"), action: { label: t("status.action"), page: "shelly" } });
      else if (all.some((d) => !d.online)) ctx.status.set({ state: "warning", message: t("status.offline", { count: all.filter((d) => !d.online).length }), action: { label: t("status.action"), page: "shelly" } });
      else ctx.status.set({ state: "ok" });
    };

    ctx.scheduler.every("poll", 5000, pollAll, { immediate: true });
    devices.onChange(() => void pollAll());
    ctx.i18n.onChange(reportStatus);

    async function setSwitch(d: ShellyDevice, channel: number, on: boolean) {
      if (d.gen === 2) await get(d.ip, `/rpc/Switch.Set?id=${channel}&on=${on}`);
      else await get(d.ip, `/relay/${channel}?turn=${on ? "on" : "off"}`);
      await poll({ id: d.id, ip: d.ip, name: d.name, mac: d.mac });
      events.publish("state", [...state.values()]);
    }

    http.get("/devices", (c) => c.json([...state.values()]));
    http.get("/suggested", (c) => c.json(devices.suggested()));
    http.post("/claim", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { deviceId?: string };
      const d = b.deviceId ? devices.claim(b.deviceId) : null;
      if (!d) return c.json({ error: ctx.i18n.t("error.cannot_claim") }, 400);
      await pollAll();
      return c.json(state.get(d.id) ?? { ok: true });
    });
    http.post("/release", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { deviceId?: string };
      if (b.deviceId?.startsWith("ip:")) storage.set("manualIps", manual().filter((ip) => ip !== b.deviceId!.slice(3)));
      else if (b.deviceId) devices.release(b.deviceId);
      await pollAll();
      return c.json({ ok: true });
    });
    http.post("/add-ip", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { ip?: unknown };
      const target = normalizeHost(typeof b.ip === "string" ? b.ip : "");
      if (!target) return c.json({ error: ctx.i18n.t("error.ip_required") }, 400);
      const id = `ip:${target}`;
      if (manual().includes(target) || devices.claimed().some((d) => d.ip === target)) return c.json(state.get(id) ?? { ok: true }, 200);
      // probe first; only a device that answers is remembered (otherwise it would be polled forever and flag "offline")
      const d = await poll({ id, ip: target, name: null, mac: null });
      if (!d.online) {
        state.delete(id);
        return c.json({ error: d.error ?? ctx.i18n.t("error.no_answer") }, 400);
      }
      storage.set("manualIps", [...new Set([...manual(), target])]);
      events.publish("state", [...state.values()]);
      reportStatus();
      return c.json(d, 201);
    });
    http.post("/switch", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { device?: string; channel?: number; on?: boolean };
      const d = b.device ? state.get(b.device) : null;
      if (!d) return c.json({ error: ctx.i18n.t("error.unknown_device") }, 404);
      const ch = b.channel ?? 0;
      const on = b.on ?? !d.channels.find((x) => x.id === ch)?.on;
      try {
        await setSwitch(d, ch, on);
        return c.json(state.get(d.id));
      } catch (err) {
        return c.json({ error: (err as Error).message }, 502);
      }
    });

    einkRender = (req) => {
      const t = ctx.i18n.t;
      const cfg = req.config as { device?: string; channel?: number; name?: string };
      if (req.widget === "power") {
        const list = [...state.values()];
        return { type: "col", grow: 1, gap: 4, children: list.map((d) => ({ type: "row" as const, gap: 8, align: "center" as const, children: [{ type: "text" as const, text: d.name, size: 13, pixel: false, grow: 1, wrap: false }, { type: "text" as const, text: d.online ? `${Math.round(d.channels.reduce((a, c) => a + (c.power ?? 0), 0))} W` : t("eink.offline"), size: 13, pixel: false, gray: d.online ? 1 : 0.5 }] })) };
      }
      const d = cfg.device ? state.get(cfg.device) : null;
      const ch = d?.channels.find((x) => x.id === (cfg.channel ?? 0));
      if (!d || !ch) return { type: "text", text: t("eink.no_device"), size: 12, gray: 0.5 };
      return { type: "col", grow: 1, align: "center", justify: "center", gap: 4, children: [{ type: "text", text: cfg.name ?? d.name, size: 12, gray: 0.5 }, { type: "text", text: t(ch.on ? "eink.on" : "eink.off"), size: 28, bold: true }, ...(ch.power != null ? [{ type: "text" as const, text: `${Math.round(ch.power)} W`, size: 12, pixel: false, gray: 0.5 }] : [])] };
    };
    logger.info("shelly ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
export type { Device };
