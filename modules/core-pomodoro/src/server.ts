import { defineModule } from "@orbis/sdk/server";

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

const dayKey = () => new Date().toISOString().slice(0, 10);

export default defineModule({
  setup(ctx) {
    const { storage, http, events } = ctx;
    const empty = (): TimerState => ({ mode: "focus", running: false, endsAt: null, remainingMs: 25 * 60_000, totalMs: 25 * 60_000, round: 0, label: null, todayFocusMinutes: 0, day: dayKey() });
    let state: TimerState = storage.get<TimerState>("state") ?? empty();
    const save = () => {
      storage.set("state", state);
      events.publish("timer", state);
    };
    const rollDay = () => {
      if (state.day !== dayKey()) {
        state.day = dayKey();
        state.todayFocusMinutes = 0;
      }
    };

    const durations = (cfg: Record<string, unknown>) => ({
      focus: Number(cfg.focusMinutes ?? 25) * 60_000,
      break: Number(cfg.breakMinutes ?? 5) * 60_000,
      long: Number(cfg.longBreakMinutes ?? 15) * 60_000,
      rounds: Number(cfg.roundsBeforeLong ?? 4),
    });

    function finish(cfg: Record<string, unknown>) {
      const d = durations(cfg);
      if (state.mode === "focus") {
        state.round += 1;
        state.todayFocusMinutes += Math.round(state.totalMs / 60_000);
        const long = state.round % d.rounds === 0;
        state.mode = long ? "long" : "break";
        state.totalMs = long ? d.long : d.break;
        ctx.notify({ key: "block", title: long ? "focus block done – long break" : "focus block done – short break", body: state.label ?? undefined, level: "info", icon: "alarm-clock" });
      } else {
        state.mode = "focus";
        state.totalMs = d.focus;
        ctx.notify({ key: "block", title: "break over – back to it", body: state.label ?? undefined, level: "info", icon: "alarm-clock" });
      }
      state.running = false;
      state.endsAt = null;
      state.remainingMs = state.totalMs;
      save();
    }

    // the hub finishes blocks even when no client is open
    let lastCfg: Record<string, unknown> = {};
    ctx.scheduler.every("tick", 1000, () => {
      if (state.running && state.endsAt && new Date(state.endsAt).getTime() <= Date.now()) finish(lastCfg);
    });

    http.get("/state", (c) => {
      rollDay();
      return c.json(state);
    });
    http.post("/start", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { config?: Record<string, unknown>; label?: string };
      lastCfg = b.config ?? lastCfg;
      rollDay();
      if (!state.running) {
        if (state.remainingMs <= 0) state.remainingMs = state.totalMs;
        state.endsAt = new Date(Date.now() + state.remainingMs).toISOString();
        state.running = true;
        if (b.label !== undefined) state.label = b.label || null;
        save();
      }
      return c.json(state);
    });
    http.post("/pause", (c) => {
      if (state.running && state.endsAt) {
        state.remainingMs = Math.max(0, new Date(state.endsAt).getTime() - Date.now());
        state.running = false;
        state.endsAt = null;
        save();
      }
      return c.json(state);
    });
    http.post("/skip", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { config?: Record<string, unknown> };
      lastCfg = b.config ?? lastCfg;
      finish(lastCfg);
      return c.json(state);
    });
    http.post("/reset", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { config?: Record<string, unknown> };
      const d = durations(b.config ?? lastCfg);
      const keepToday = state.todayFocusMinutes;
      state = { ...empty(), totalMs: d.focus, remainingMs: d.focus, todayFocusMinutes: keepToday };
      ctx.dismissNotification("block");
      save();
      return c.json(state);
    });

    einkRender = () => {
      const left = state.running && state.endsAt ? Math.max(0, new Date(state.endsAt).getTime() - Date.now()) : state.remainingMs;
      const m = Math.floor(left / 60_000), s = Math.floor((left % 60_000) / 1000);
      return { type: "col", grow: 1, align: "center", justify: "center", gap: 4, children: [{ type: "text", text: state.mode === "focus" ? "focus" : "break", size: 12, gray: 0.5 }, { type: "text", text: `${m}:${String(s).padStart(2, "0")}`, size: 40 }, { type: "bar", value: state.totalMs - left, max: state.totalMs, height: 8 }, { type: "text", text: `${state.todayFocusMinutes} min focused today`, size: 11, pixel: false, gray: 0.5 }] };
    };
    ctx.logger.info("focus timer ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
