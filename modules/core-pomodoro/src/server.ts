import { defineModule, intRange, parseBody, z } from "@orbis/sdk/server";

/** one shared timer per hub (it is a household dashboard, not a per-user app) */
export type TimerState = {
  mode: "focus" | "break" | "long";
  running: boolean;
  /** when the current block ends (iso); set while running */
  endsAt: string | null;
  /** remaining ms while paused */
  remainingMs: number;
  /** total ms of the current block */
  totalMs: number;
  /** completed focus rounds in this cycle */
  round: number;
  label: string | null;
  todayFocusMinutes: number;
  day: string;
};

/** the widget config as the client sends it; anything outside these bounds is a 400 */
export type TimerConfig = { focusMinutes?: number; breakMinutes?: number; longBreakMinutes?: number; roundsBeforeLong?: number };

const isValidTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
/** YYYY-MM-DD in the hub's timezone (so "today" rolls over at local midnight, not 02:00 cest) */
export const dayKey = (tz: string | null | undefined, now = new Date()) => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${g("year")}-${g("month")}-${g("day")}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

const minutes = intRange(1, 180);
const configSchema = z.object({ focusMinutes: minutes.optional(), breakMinutes: minutes.optional(), longBreakMinutes: minutes.optional(), roundsBeforeLong: intRange(1, 12).optional() });
const tzSchema = z.string().max(64).refine(isValidTz, "unknown timezone");
const body = z.object({ config: configSchema.optional(), label: z.string().trim().max(120, "at most 120 characters").optional(), tz: tzSchema.optional() });

export default defineModule({
  setup(ctx) {
    const { storage, http, events } = ctx;
    /** last timezone a client (or the e-ink renderer) told us about */
    let tz: string = storage.get<string>("tz") ?? "UTC";
    const empty = (): TimerState => ({ mode: "focus", running: false, endsAt: null, remainingMs: 25 * 60_000, totalMs: 25 * 60_000, round: 0, label: null, todayFocusMinutes: 0, day: dayKey(tz) });
    let state: TimerState = storage.get<TimerState>("state") ?? empty();
    const save = () => {
      storage.set("state", state);
      events.publish("timer", state);
    };
    const rollDay = () => {
      const today = dayKey(tz);
      if (state.day !== today) {
        state.day = today;
        state.todayFocusMinutes = 0;
      }
    };
    const setTz = (next?: string) => {
      if (next && next !== tz) {
        tz = next;
        storage.set("tz", tz);
      }
    };

    const durations = (cfg: TimerConfig) => ({
      focus: (cfg.focusMinutes ?? 25) * 60_000,
      break: (cfg.breakMinutes ?? 5) * 60_000,
      long: (cfg.longBreakMinutes ?? 15) * 60_000,
      rounds: cfg.roundsBeforeLong ?? 4,
    });
    /** ms of the current block that already ran */
    const elapsedMs = () => {
      const left = state.running && state.endsAt ? Math.max(0, new Date(state.endsAt).getTime() - Date.now()) : state.remainingMs;
      return Math.max(0, Math.min(state.totalMs, state.totalMs - left));
    };

    /** end the current block; `ranMs` is what actually counts towards "focused today" (a skip credits only the elapsed part) */
    function finish(cfg: TimerConfig, ranMs: number) {
      const d = durations(cfg);
      rollDay();
      if (state.mode === "focus") {
        state.round += 1;
        state.todayFocusMinutes += Math.round(ranMs / 60_000);
        const long = state.round % d.rounds === 0;
        state.mode = long ? "long" : "break";
        state.totalMs = long ? d.long : d.break;
        ctx.notify({ key: "block", title: ctx.i18n.t(long ? "notify.blockDoneLong" : "notify.blockDoneShort"), body: state.label ?? undefined, level: "info", icon: "alarm-clock" });
      } else {
        state.mode = "focus";
        state.totalMs = d.focus;
        ctx.notify({ key: "block", title: ctx.i18n.t("notify.breakOver"), body: state.label ?? undefined, level: "info", icon: "alarm-clock" });
      }
      state.running = false;
      state.endsAt = null;
      state.remainingMs = state.totalMs;
      save();
    }

    // the hub finishes blocks even when no client is open; the config survives a restart
    let lastCfg: TimerConfig = configSchema.safeParse(storage.get("lastCfg") ?? {}).data ?? {};
    const remember = (cfg?: TimerConfig) => {
      if (!cfg) return;
      lastCfg = cfg;
      storage.set("lastCfg", cfg);
    };
    ctx.scheduler.every("tick", 1000, () => {
      if (state.running && state.endsAt && new Date(state.endsAt).getTime() <= Date.now()) finish(lastCfg, state.totalMs);
    });

    http.get("/state", (c) => {
      rollDay();
      return c.json(state);
    });
    http.post("/start", async (c) => {
      const p = await parseBody(c, body);
      if (!p.ok) return p.res;
      const b = p.data;
      remember(b.config);
      setTz(b.tz);
      rollDay();
      if (!state.running) {
        if (state.remainingMs <= 0) state.remainingMs = state.totalMs;
        const fresh = state.remainingMs >= state.totalMs;
        state.endsAt = new Date(Date.now() + state.remainingMs).toISOString();
        state.running = true;
        // a non-empty label always wins; an empty one only clears on a fresh block (on resume the input is hidden and sends "")
        if (b.label !== undefined && (b.label || fresh)) state.label = b.label || null;
        save();
      }
      return c.json(state);
    });
    http.post("/pause", async (c) => {
      const p = await parseBody(c, body);
      if (!p.ok) return p.res;
      remember(p.data.config);
      setTz(p.data.tz);
      if (state.running && state.endsAt) {
        state.remainingMs = Math.max(0, new Date(state.endsAt).getTime() - Date.now());
        state.running = false;
        state.endsAt = null;
        save();
      }
      return c.json(state);
    });
    http.post("/skip", async (c) => {
      const p = await parseBody(c, body);
      if (!p.ok) return p.res;
      remember(p.data.config);
      setTz(p.data.tz);
      finish(lastCfg, elapsedMs());
      return c.json(state);
    });
    http.post("/reset", async (c) => {
      const p = await parseBody(c, body);
      if (!p.ok) return p.res;
      remember(p.data.config);
      setTz(p.data.tz);
      rollDay();
      const d = durations(lastCfg);
      const keepToday = state.todayFocusMinutes;
      state = { ...empty(), totalMs: d.focus, remainingMs: d.focus, todayFocusMinutes: keepToday };
      ctx.dismissNotification("block");
      save();
      return c.json(state);
    });

    einkRender = (req) => {
      setTz(req.timezone);
      rollDay();
      const left = state.running && state.endsAt ? Math.max(0, new Date(state.endsAt).getTime() - Date.now()) : state.remainingMs;
      const m = Math.floor(left / 60_000), s = Math.floor((left % 60_000) / 1000);
      const t = ctx.i18n.t;
      return { type: "col", grow: 1, align: "center", justify: "center", gap: 4, children: [{ type: "text", text: state.mode === "focus" ? t("widget.timer.focus") : state.mode === "long" ? t("widget.timer.longBreak") : t("widget.timer.break"), size: 12, gray: 0.5 }, { type: "text", text: `${m}:${String(s).padStart(2, "0")}`, size: 40 }, { type: "bar", value: state.totalMs - left, max: state.totalMs, height: 8 }, { type: "text", text: t("widget.timer.focusedToday", { count: state.todayFocusMinutes }), size: 11, pixel: false, gray: 0.5 }] };
    };
    ctx.logger.info("focus timer ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
  /** tap on the e-ink widget toggles the timer */
  async einkTap(ctx, req) {
    const running = ctx.storage.get<TimerState>("state")?.running;
    await ctx.http.fetch(new Request(`http://m/${running ? "pause" : "start"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz: req.timezone }) }));
    return { refresh: true, toast: ctx.i18n.t(running ? "eink.paused" : "eink.started") };
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
