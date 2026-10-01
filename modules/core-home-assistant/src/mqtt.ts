import mqtt, { type MqttClient } from "mqtt";
import type { ModuleServerContext } from "@orbis/sdk/server";

/**
 * The other direction: orbis shows up in home assistant as a device via mqtt discovery.
 * sensors: next event (+ minutes until), open tasks, habits due, modules loaded, focus state.
 * switch: focus (starts/pauses the pomodoro module). everything is read through ctx.modules.call,
 * so a missing module just means that entity is not published.
 */
export type MqttSettings = { mqttUrl?: string; mqttUser?: string; mqttPass?: string; mqttPrefix?: string; mqttDiscoveryPrefix?: string; mqttEnabled?: boolean };

type CalEvent = { id: string; title: string; start: string; end: string; allDay: boolean; location?: string; calendarName: string };
type Task = { id: string; title: string; due?: string | null; done: number };
type Timer = { mode: "focus" | "break" | "long"; running: boolean; endsAt: string | null; remainingMs: number; label: string | null; todayFocusMinutes: number };

export function startMqttBridge(ctx: ModuleServerContext<MqttSettings>, onState: (s: { connected: boolean; error: string | null; entities: string[] }) => void) {
  const { logger, settings } = ctx;
  const cfg = settings.get();
  const url = cfg.mqttUrl?.trim();
  if (!cfg.mqttEnabled || !url) return () => undefined;
  const prefix = (cfg.mqttPrefix?.trim() || "orbis").replace(/\/+$/, "");
  const disc = (cfg.mqttDiscoveryPrefix?.trim() || "homeassistant").replace(/\/+$/, "");
  const device = { identifiers: [`${prefix}_hub`], name: "Orbis", manufacturer: "orbis-hub", model: "hub", sw_version: ctx.manifest.version, configuration_url: undefined as string | undefined };
  const avail = `${prefix}/status`;
  let client: MqttClient | null = null;
  let stopped = false;
  let published = new Set<string>();
  let tick: ReturnType<typeof setInterval> | null = null;
  const state = { connected: false, error: null as string | null, entities: [] as string[] };
  const report = () => onState({ ...state, entities: [...published] });

  const pub = (topic: string, payload: unknown, retain = true) => {
    if (!client?.connected) return;
    client.publish(topic, typeof payload === "string" ? payload : JSON.stringify(payload), { retain, qos: 0 });
  };

  /** discovery config for one entity; removed again (empty retained payload) when its module goes away */
  const announce = (component: "sensor" | "switch" | "binary_sensor", id: string, conf: Record<string, unknown>) => {
    const uid = `${prefix}_${id}`;
    pub(`${disc}/${component}/${uid}/config`, { unique_id: uid, object_id: uid, device, availability_topic: avail, ...conf });
    published.add(`${component}.${uid}`);
  };
  const retract = (component: string, id: string) => {
    pub(`${disc}/${component}/${prefix}_${id}/config`, "");
    published.delete(`${component}.${prefix}_${id}`);
  };

  const announceAll = () => {
    const has = (m: string) => ctx.modules.has(m);
    if (has("calendar")) {
      announce("sensor", "next_event", { name: "Next event", state_topic: `${prefix}/sensor/next_event/state`, json_attributes_topic: `${prefix}/sensor/next_event/attributes`, icon: "mdi:calendar-clock" });
      announce("sensor", "next_event_in", { name: "Next event in", state_topic: `${prefix}/sensor/next_event_in/state`, unit_of_measurement: "min", device_class: "duration", state_class: "measurement", icon: "mdi:timer-sand" });
      announce("sensor", "events_today", { name: "Events today", state_topic: `${prefix}/sensor/events_today/state`, state_class: "measurement", icon: "mdi:calendar-today" });
    } else ["next_event", "next_event_in", "events_today"].forEach((i) => retract("sensor", i));
    if (has("todo")) {
      announce("sensor", "open_tasks", { name: "Open tasks", state_topic: `${prefix}/sensor/open_tasks/state`, json_attributes_topic: `${prefix}/sensor/open_tasks/attributes`, state_class: "measurement", icon: "mdi:checkbox-marked-outline" });
      announce("sensor", "tasks_due_today", { name: "Tasks due today", state_topic: `${prefix}/sensor/tasks_due_today/state`, state_class: "measurement", icon: "mdi:calendar-check" });
    } else ["open_tasks", "tasks_due_today"].forEach((i) => retract("sensor", i));
    if (has("habits")) announce("sensor", "habits_open", { name: "Habits left today", state_topic: `${prefix}/sensor/habits_open/state`, state_class: "measurement", icon: "mdi:repeat" });
    else retract("sensor", "habits_open");
    if (has("pomodoro")) {
      announce("switch", "focus", { name: "Focus", state_topic: `${prefix}/switch/focus/state`, command_topic: `${prefix}/switch/focus/set`, payload_on: "ON", payload_off: "OFF", icon: "mdi:timer-outline" });
      announce("sensor", "focus_minutes_today", { name: "Focus minutes today", state_topic: `${prefix}/sensor/focus_minutes_today/state`, unit_of_measurement: "min", state_class: "total_increasing", icon: "mdi:brain" });
      announce("sensor", "focus_phase", { name: "Focus phase", state_topic: `${prefix}/sensor/focus_phase/state`, json_attributes_topic: `${prefix}/sensor/focus_phase/attributes`, icon: "mdi:timer-outline" });
    } else {
      retract("switch", "focus");
      retract("sensor", "focus_minutes_today");
      retract("sensor", "focus_phase");
    }
    if (has("shopping")) announce("sensor", "shopping_items", { name: "Shopping list items", state_topic: `${prefix}/sensor/shopping_items/state`, json_attributes_topic: `${prefix}/sensor/shopping_items/attributes`, state_class: "measurement", icon: "mdi:cart-outline" });
    else retract("sensor", "shopping_items");
    announce("sensor", "modules", { name: "Modules loaded", state_topic: `${prefix}/sensor/modules/state`, json_attributes_topic: `${prefix}/sensor/modules/attributes`, icon: "mdi:puzzle", entity_category: "diagnostic" });
    announce("binary_sensor", "online", { name: "Hub online", state_topic: avail, payload_on: "online", payload_off: "offline", device_class: "connectivity", entity_category: "diagnostic" });
    report();
  };

  const safe = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      logger.debug(`mqtt bridge read failed: ${(err as Error).message}`);
      return null;
    }
  };

  const publishStates = async () => {
    if (!client?.connected) return;
    const now = Date.now();
    const todayIso = new Date().toLocaleDateString("sv-SE");
    if (ctx.modules.has("calendar")) {
      const r = await safe(() => ctx.modules.call<{ events: CalEvent[] }>("calendar", `/events?from=${new Date(now - 60 * 60_000).toISOString()}&to=${new Date(now + 14 * 86400_000).toISOString()}`));
      const upcoming = (r?.events ?? []).filter((e) => !e.allDay && new Date(e.end).getTime() > now).sort((a, b) => a.start.localeCompare(b.start));
      const next = upcoming.find((e) => new Date(e.start).getTime() >= now) ?? upcoming[0] ?? null;
      pub(`${prefix}/sensor/next_event/state`, next ? next.title.slice(0, 250) : "none");
      pub(`${prefix}/sensor/next_event/attributes`, next ? { start: next.start, end: next.end, location: next.location ?? null, calendar: next.calendarName, running: new Date(next.start).getTime() <= now } : {});
      pub(`${prefix}/sensor/next_event_in/state`, next ? String(Math.max(0, Math.round((new Date(next.start).getTime() - now) / 60_000))) : "0");
      pub(`${prefix}/sensor/events_today/state`, String((r?.events ?? []).filter((e) => e.start.slice(0, 10) === todayIso || (new Date(e.start).toLocaleDateString("sv-SE") === todayIso)).length));
    }
    if (ctx.modules.has("todo")) {
      const tasks = (await safe(() => ctx.modules.call<Task[]>("todo", "/tasks"))) ?? [];
      const open = tasks.filter((t) => !t.done);
      pub(`${prefix}/sensor/open_tasks/state`, String(open.length));
      pub(`${prefix}/sensor/open_tasks/attributes`, { titles: open.slice(0, 10).map((t) => t.title) });
      pub(`${prefix}/sensor/tasks_due_today/state`, String(open.filter((t) => t.due && String(t.due).slice(0, 10) <= todayIso).length));
    }
    if (ctx.modules.has("habits")) {
      const habits = (await safe(() => ctx.modules.call<Array<{ doneToday?: boolean; todayDone?: boolean; done_today?: boolean }>>("habits", "/habits"))) ?? [];
      pub(`${prefix}/sensor/habits_open/state`, String(habits.filter((h) => !(h.doneToday ?? h.todayDone ?? h.done_today)).length));
    }
    if (ctx.modules.has("pomodoro")) {
      const t = await safe(() => ctx.modules.call<Timer>("pomodoro", "/state"));
      if (t) {
        pub(`${prefix}/switch/focus/state`, t.running && t.mode === "focus" ? "ON" : "OFF");
        pub(`${prefix}/sensor/focus_minutes_today/state`, String(t.todayFocusMinutes ?? 0));
        pub(`${prefix}/sensor/focus_phase/state`, t.running ? t.mode : "idle");
        pub(`${prefix}/sensor/focus_phase/attributes`, { label: t.label, ends_at: t.endsAt, remaining_min: t.running && t.endsAt ? Math.max(0, Math.round((new Date(t.endsAt).getTime() - now) / 60_000)) : Math.round(t.remainingMs / 60_000) });
      }
    }
    if (ctx.modules.has("shopping")) {
      const items = (await safe(() => ctx.modules.call<Array<{ name: string; qty: string | null }>>("shopping", "/items"))) ?? [];
      pub(`${prefix}/sensor/shopping_items/state`, String(items.length));
      pub(`${prefix}/sensor/shopping_items/attributes`, { items: items.slice(0, 30).map((i) => (i.qty ? `${i.qty} ${i.name}` : i.name)) });
    }
    const mods = ctx.modules.list();
    pub(`${prefix}/sensor/modules/state`, String(mods.length));
    pub(`${prefix}/sensor/modules/attributes`, { modules: mods.map((m) => `${m.id}@${m.version}`) });
  };

  const onCommand = async (topic: string, payload: Buffer) => {
    if (topic === `${prefix}/switch/focus/set` && ctx.modules.has("pomodoro")) {
      const on = payload.toString().trim().toUpperCase() === "ON";
      await safe(() => ctx.modules.call("pomodoro", on ? "/start" : "/pause", { method: "POST", json: {} }));
      await publishStates();
    }
  };

  try {
    client = mqtt.connect(url, { username: cfg.mqttUser || undefined, password: cfg.mqttPass || undefined, clientId: `${prefix}-hub-${Math.random().toString(16).slice(2, 8)}`, will: { topic: avail, payload: Buffer.from("offline"), retain: true, qos: 0 }, reconnectPeriod: 10_000, connectTimeout: 10_000 });
  } catch (err) {
    state.error = (err as Error).message;
    report();
    return () => undefined;
  }
  client.on("connect", () => {
    state.connected = true;
    state.error = null;
    logger.info(`mqtt bridge connected (${url}, prefix ${prefix})`);
    pub(avail, "online");
    client!.subscribe(`${prefix}/switch/+/set`);
    announceAll();
    void publishStates();
    report();
  });
  client.on("message", (topic, payload) => void onCommand(topic, payload));
  client.on("error", (err) => {
    state.error = err.message;
    report();
  });
  client.on("close", () => {
    if (state.connected) logger.warn("mqtt bridge disconnected");
    state.connected = false;
    report();
  });
  tick = setInterval(() => void publishStates(), 30_000);
  const offModules = ctx.modules.onChange(() => {
    announceAll();
    void publishStates();
  });

  return () => {
    stopped = true;
    offModules();
    if (tick) clearInterval(tick);
    if (client) {
      try {
        if (client.connected) client.publish(avail, "offline", { retain: true });
      } catch {
        /* closing anyway */
      }
      client.end(true);
    }
    published = new Set();
    state.connected = false;
    report();
  };
}
