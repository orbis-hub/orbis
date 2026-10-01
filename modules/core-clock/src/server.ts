import { defineModule } from "@orbis/sdk/server";

export default defineModule({
  setup(ctx) {
    // The clock is rendered client-side; the server just exposes the hub's time so clients can
    // correct their local clock and know the hub's timezone.
    ctx.http.get("/now", (c) => c.json({ iso: new Date().toISOString(), epoch: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    ctx.logger.info("clock ready");
  },
});
