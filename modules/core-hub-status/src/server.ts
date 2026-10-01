import { readFileSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { defineModule } from "@orbis/sdk/server";

export type Stats = {
  at: string;
  hostname: string;
  platform: string;
  arch: string;
  node: string;
  hubVersion: string;
  uptimeSec: number;
  processUptimeSec: number;
  cpuPercent: number;
  cores: number;
  load: [number, number, number];
  memTotal: number;
  memUsed: number;
  memPercent: number;
  processRss: number;
  diskTotal: number | null;
  diskUsed: number | null;
  diskPercent: number | null;
  dbBytes: number | null;
  tempC: number | null;
  modules: number;
};

export default defineModule({
  setup(ctx) {
    let prev = os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
    let cpuPercent = 0;
    let last: Stats | null = null;
    const history: Array<{ t: string; cpu: number; mem: number }> = [];

    const cpuTemp = (): number | null => {
      // linux thermal zone (pi, most sbcs); nothing portable elsewhere
      try {
        const v = Number(readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim());
        return Number.isFinite(v) ? Math.round(v / 100) / 10 : null;
      } catch {
        return null;
      }
    };

    async function sample(): Promise<Stats> {
      const cpus = os.cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
      let idle = 0, total = 0;
      cpus.forEach((c, i) => {
        idle += c.idle - (prev[i]?.idle ?? 0);
        total += c.total - (prev[i]?.total ?? 0);
      });
      prev = cpus;
      if (total > 0) cpuPercent = Math.round((1 - idle / total) * 100);
      let diskTotal: number | null = null, diskUsed: number | null = null;
      try {
        const fs = await statfs(ctx.dataDir);
        diskTotal = fs.blocks * fs.bsize;
        diskUsed = (fs.blocks - fs.bavail) * fs.bsize;
      } catch {
        /* unsupported */
      }
      let dbBytes: number | null = null;
      try {
        dbBytes = statSync(resolve(ctx.dataDir, "..", "..", "orbis.sqlite")).size;
      } catch {
        /* layout differs */
      }
      const memTotal = os.totalmem();
      const memUsed = memTotal - os.freemem();
      const s: Stats = {
        at: new Date().toISOString(),
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        node: process.version,
        hubVersion: ctx.hubVersion,
        uptimeSec: Math.round(os.uptime()),
        processUptimeSec: Math.round(process.uptime()),
        cpuPercent,
        cores: cpus.length,
        load: os.loadavg() as [number, number, number],
        memTotal,
        memUsed,
        memPercent: Math.round((memUsed / memTotal) * 100),
        processRss: process.memoryUsage().rss,
        diskTotal,
        diskUsed,
        diskPercent: diskTotal && diskUsed !== null ? Math.round((diskUsed / diskTotal) * 100) : null,
        dbBytes,
        tempC: cpuTemp(),
        modules: ctx.modules.list().length + 1,
      };
      last = s;
      history.push({ t: s.at, cpu: s.cpuPercent, mem: s.memPercent });
      if (history.length > 360) history.shift(); // 30 min at 5 s
      ctx.events.publish("stats", s);
      return s;
    }

    ctx.scheduler.every("sample", 5000, () => void sample(), { immediate: true });
    ctx.http.get("/stats", async (c) => c.json(last ?? (await sample())));
    ctx.http.get("/history", (c) => c.json(history));
    ctx.logger.info("hub status ready");

    einkRender = (req) => {
      const s = last;
      if (!s) return { type: "text", text: "no data yet", size: 12 };
      const fmtUp = (sec: number) => (sec > 86400 ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`);
      const row = (label: string, v: number | null, text: string) => ({ type: "col" as const, gap: 2, children: [{ type: "row" as const, justify: "between" as const, children: [{ type: "text" as const, text: label, size: 12, pixel: false, gray: 0.5 }, { type: "text" as const, text, size: 12, pixel: false }] }, ...(v !== null ? [{ type: "bar" as const, value: v, height: 6 }] : [])] });
      return {
        type: "col",
        grow: 1,
        gap: 6,
        children: [row("cpu", s.cpuPercent, `${s.cpuPercent}%`), row("memory", s.memPercent, `${s.memPercent}%`), ...(s.diskPercent !== null ? [row("disk", s.diskPercent, `${s.diskPercent}%`)] : []), { type: "text", text: `up ${fmtUp(s.uptimeSec)}${s.tempC !== null ? ` · ${s.tempC}°C` : ""}`, size: 11, pixel: false, gray: 0.5 }],
      };
    };
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
