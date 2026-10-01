import { defineModule } from "@orbis/sdk/server";

export default defineModule({
  setup(ctx) {
    // The clock is rendered client-side; the server just exposes the hub's time so clients can
    // correct their local clock and know the hub's timezone.
    ctx.http.get("/now", (c) => c.json({ iso: new Date().toISOString(), epoch: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    ctx.logger.info("clock ready");
  },
  eink(_ctx, req) {
    const cfg = req.config as { showSeconds?: boolean; showDate?: boolean; hour12?: boolean; timezone?: string; label?: string };
    const tz = cfg.timezone || req.timezone;
    const time = new Intl.DateTimeFormat(req.locale, { hour: "2-digit", minute: "2-digit", hour12: cfg.hour12 ?? false, timeZone: tz }).format(req.now);
    const date = new Intl.DateTimeFormat(req.locale, { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(req.now);
    const big = Math.max(24, Math.min(req.height * 0.55, req.width / 3.2));
    return {
      type: "col",
      grow: 1,
      align: "center",
      justify: "center",
      gap: 4,
      children: [
        ...(cfg.label ? [{ type: "text" as const, text: cfg.label, size: 14, gray: 0.5 }] : []),
        { type: "text", text: time, size: big, align: "center" },
        ...(cfg.showDate !== false ? [{ type: "text" as const, text: date.toLowerCase(), size: Math.max(12, big * 0.28), pixel: false, align: "center" as const }] : []),
      ],
    };
  },
});
