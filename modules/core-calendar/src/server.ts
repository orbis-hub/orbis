import { defineModule, type ModuleServerContext } from "@orbis/sdk/server";
import ical, { type VEvent } from "node-ical";
import { createDAVClient, type DAVCalendar } from "tsdav";

/* ---------- types ---------- */

export type AccountType = "ics" | "caldav";
export type Account = {
  id: string;
  type: AccountType;
  name: string;
  /** ics: the feed url · caldav: the server/principal url */
  url: string;
  username?: string;
  password?: string;
  color: string;
  enabled: boolean;
  /** caldav only: calendar urls the user disabled */
  hiddenCalendars?: string[];
};

export type Calendar = { id: string; accountId: string; name: string; color: string; url: string; writable: boolean };

export type CalEvent = {
  id: string;
  calendarId: string;
  calendarName: string;
  color: string;
  title: string;
  start: string; // iso
  end: string; // iso
  allDay: boolean;
  location?: string;
  description?: string;
  url?: string;
  recurring: boolean;
};

type State = { calendars: Calendar[]; events: CalEvent[]; fetchedAt: string; errors: Record<string, string> };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const PALETTE = ["#e2789b", "#8b7fd6", "#4fc47f", "#f0b232", "#4f93d6", "#f23f43", "#2f9fbf", "#d9702e"];

/** Known providers: map the thing users paste into a CalDAV root. */
export function normalizeCaldavUrl(input: string, username?: string): string {
  let u = input.trim();
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  const host = new URL(u).host.toLowerCase();
  if (host.includes("icloud.com")) return "https://caldav.icloud.com";
  if (host.includes("google.com") || host.includes("googleapis.com")) return username ? `https://apidata.googleusercontent.com/caldav/v2/${encodeURIComponent(username)}/user` : "https://apidata.googleusercontent.com/caldav/v2";
  if (host.includes("fastmail.com")) return "https://caldav.fastmail.com";
  // nextcloud: accept the base url, the webdav url or the app url
  if (/\/(remote\.php|apps\/calendar|index\.php)/.test(u)) u = u.replace(/\/(remote\.php|apps\/calendar|index\.php).*$/, "");
  return u.replace(/\/+$/, "");
}

function explainCaldavError(err: Error, serverUrl: string): string {
  const m = err.message ?? String(err);
  const host = (() => {
    try {
      return new URL(serverUrl).host;
    } catch {
      return serverUrl;
    }
  })();
  if (/401|Unauthorized|Invalid credentials/i.test(m)) {
    if (host.includes("icloud.com")) return "icloud rejected the login (401). use an app-specific password from appleid.apple.com → sign-in and security → app-specific passwords (two-factor auth must be on), and your full apple id e-mail as username.";
    if (host.includes("fastmail.com")) return "fastmail rejected the login (401). create an app password with calendar access under settings → privacy & security → integrations.";
    return `${host} rejected the login (401). most servers want an app password instead of your account password; check username (often the full e-mail) and password.`;
  }
  if (/principalUrl|principal/i.test(m)) return `could not find a caldav account at ${host}. check the server url (for nextcloud the base url is enough, for others try the full caldav url your provider documents).`;
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo/i.test(m)) return `cannot reach ${host} from the hub (${m}).`;
  if (/403|Forbidden/i.test(m)) return `${host} answered 403 forbidden: the account is valid but may not allow caldav access or this app password lacks calendar rights.`;
  return m;
}

/* ---------- ics parsing (shared by feeds and caldav objects) ---------- */

function parseIcs(text: string, cal: Calendar, from: Date, to: Date): CalEvent[] {
  const data = ical.sync.parseICS(text);
  const out: CalEvent[] = [];
  for (const item of Object.values(data)) {
    if (!item || (item as { type?: string }).type !== "VEVENT") continue;
    const ev = item as VEvent;
    const allDay = (ev.start as unknown as { dateOnly?: boolean })?.dateOnly === true || (ev.datetype as string | undefined) === "date";
    // all-day events carry a plain DATE; serialise them as utc midnight of that calendar day so no timezone shifts the day
    const asDay = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const push = (start: Date, end: Date, suffix = "") => {
      if (allDay) {
        start = asDay(start);
        end = asDay(end);
        if (end <= start) end = new Date(start.getTime() + 86400_000);
      }
      if (end < from || start > to) return;
      out.push({
        id: `${cal.id}:${ev.uid}${suffix}`,
        calendarId: cal.id,
        calendarName: cal.name,
        color: cal.color,
        title: String(ev.summary ?? "(untitled)"),
        start: start.toISOString(),
        end: end.toISOString(),
        allDay,
        location: ev.location ? String(ev.location) : undefined,
        description: ev.description ? String(ev.description).slice(0, 500) : undefined,
        url: ev.url ? String(ev.url) : undefined,
        recurring: !!ev.rrule,
      });
    };
    const duration = ev.end && ev.start ? ev.end.getTime() - ev.start.getTime() : 3600_000;
    if (ev.rrule) {
      const dates = ev.rrule.between(from, to, true);
      const exdates = new Set(Object.values(ev.exdate ?? {}).map((d) => new Date(d as unknown as string).toDateString()));
      for (const d of dates) {
        if (exdates.has(d.toDateString())) continue;
        // recurrence overrides (modified single instances)
        const override = ev.recurrences?.[d.toISOString().slice(0, 10)] as VEvent | undefined;
        if (override) push(override.start, override.end ?? new Date(override.start.getTime() + duration), `@${d.toISOString()}`);
        else {
          // keep the local wall-clock time of the first occurrence
          const start = new Date(d);
          const base = ev.start;
          if (!allDay) start.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
          push(start, new Date(start.getTime() + duration), `@${d.toISOString()}`);
        }
      }
    } else if (ev.start) {
      push(ev.start, ev.end ?? new Date(ev.start.getTime() + duration));
    }
  }
  return out;
}

/* ---------- module ---------- */

export default defineModule<{ refreshMinutes?: number }>({
  setup(ctx) {
    const { http, storage, events, logger } = ctx;
    let state: State = storage.get<State>("state") ?? { calendars: [], events: [], fetchedAt: "", errors: {} };
    const accounts = (): Account[] => storage.get<Account[]>("accounts") ?? [];
    const saveAccounts = (a: Account[]) => storage.set("accounts", a);
    const publicAccount = (a: Account) => ({ ...a, password: a.password ? "••••••" : undefined, hasPassword: !!a.password });

    const range = () => {
      const from = new Date();
      from.setMonth(from.getMonth() - 1);
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      const to = new Date();
      to.setMonth(to.getMonth() + 3);
      to.setHours(23, 59, 59, 999);
      return { from, to };
    };

    async function fetchIcs(acc: Account): Promise<{ calendars: Calendar[]; events: CalEvent[] }> {
      const url = acc.url.replace(/^webcal:\/\//i, "https://");
      const headers: Record<string, string> = {};
      if (acc.username && acc.password) headers.authorization = `Basic ${Buffer.from(`${acc.username.trim()}:${acc.password.replace(/\s+/g, "")}`).toString("base64")}`;
      const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(20_000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cal: Calendar = { id: acc.id, accountId: acc.id, name: acc.name, color: acc.color, url, writable: false };
      const { from, to } = range();
      return { calendars: [cal], events: parseIcs(await res.text(), cal, from, to) };
    }

    async function fetchCaldav(acc: Account): Promise<{ calendars: Calendar[]; events: CalEvent[] }> {
      if (!acc.username || !acc.password) throw new Error("username and password required");
      const serverUrl = normalizeCaldavUrl(acc.url, acc.username);
      if (serverUrl.includes("googleusercontent.com") || serverUrl.includes("google.com")) {
        throw new Error("google calendar only allows oauth on caldav, app passwords are rejected. use the calendar's 'secret address in ical format' (google calendar → settings → your calendar → integrate calendar) as an ics feed instead.");
      }
      // probe the credentials ourselves first: tsdav hides a 401 behind "cannot find principalUrl"
      {
        const auth = `Basic ${Buffer.from(`${acc.username.trim()}:${acc.password.replace(/\s+/g, "")}`).toString("base64")}`;
        let probe: Response | null = null;
        for (const u of [`${serverUrl}/.well-known/caldav`, serverUrl]) {
          try {
            probe = await ctx.fetch(u, { method: "PROPFIND", headers: { authorization: auth, depth: "0", "content-type": "application/xml" }, body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`, redirect: "follow", signal: AbortSignal.timeout(15_000) });
            if (probe.status !== 404 && probe.status !== 405) break;
          } catch (err) {
            throw new Error(explainCaldavError(err as Error, serverUrl));
          }
        }
        if (probe && (probe.status === 401 || probe.status === 403)) throw new Error(explainCaldavError(new Error(`HTTP ${probe.status} Unauthorized`), serverUrl));
      }
      let client: Awaited<ReturnType<typeof createDAVClient>>;
      try {
        client = await createDAVClient({
          serverUrl,
          credentials: { username: acc.username.trim(), password: acc.password.replace(/\s+/g, "") },
          authMethod: "Basic",
          defaultAccountType: "caldav",
        });
      } catch (err) {
        throw new Error(explainCaldavError(err as Error, serverUrl));
      }
      let cals: DAVCalendar[];
      try {
        cals = (await client.fetchCalendars()) as DAVCalendar[];
      } catch (err) {
        throw new Error(explainCaldavError(err as Error, serverUrl));
      }
      const { from, to } = range();
      const calendars: Calendar[] = [];
      const evs: CalEvent[] = [];
      let i = 0;
      for (const c of cals) {
        const comps = (c.components ?? ["VEVENT"]) as string[];
        if (!comps.includes("VEVENT")) continue;
        const cal: Calendar = {
          id: `${acc.id}:${Buffer.from(c.url).toString("base64url").slice(-12)}`,
          accountId: acc.id,
          name: String((c.displayName as unknown) ?? "calendar"),
          color: typeof c.calendarColor === "string" && c.calendarColor ? String(c.calendarColor).slice(0, 7) : PALETTE[(i++ + 1) % PALETTE.length]!,
          url: c.url,
          writable: true,
        };
        calendars.push(cal);
        if (acc.hiddenCalendars?.includes(c.url)) continue;
        try {
          const objects = await client.fetchCalendarObjects({ calendar: c, timeRange: { start: from.toISOString(), end: to.toISOString() }, expand: false });
          for (const o of objects) if (o.data) evs.push(...parseIcs(String(o.data), cal, from, to));
        } catch (err) {
          logger.warn(`calendar ${cal.name}: ${(err as Error).message}`);
        }
      }
      return { calendars, events: evs };
    }

    let refreshing: Promise<void> | null = null;
    function refresh(): Promise<void> {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const next: State = { calendars: [], events: [], fetchedAt: new Date().toISOString(), errors: {} };
        for (const acc of accounts()) {
          if (!acc.enabled) continue;
          try {
            const r = acc.type === "ics" ? await fetchIcs(acc) : await fetchCaldav(acc);
            next.calendars.push(...r.calendars);
            next.events.push(...r.events);
          } catch (err) {
            next.errors[acc.id] = (err as Error).message;
            // keep the last good data for this account
            next.calendars.push(...state.calendars.filter((c) => c.accountId === acc.id));
            next.events.push(...state.events.filter((e) => e.calendarId.startsWith(acc.id)));
            logger.warn(`account ${acc.name}: ${(err as Error).message}`);
          }
        }
        next.events.sort((a, b) => a.start.localeCompare(b.start));
        state = next;
        storage.set("state", state);
        reportStatus();
        events.publish("updated", { events: state.events.length, errors: Object.keys(state.errors).length });
      })().finally(() => (refreshing = null));
      return refreshing;
    }

    const schedule = () => ctx.scheduler.every("refresh", (ctx.settings.get().refreshMinutes ?? 10) * 60_000, refresh, { immediate: true });
    const reportStatus = () => {
      const list = accounts();
      if (list.length === 0) ctx.status.set({ state: "needs-setup", message: "no calendar accounts yet", action: { label: "add account", page: "calendar" } });
      else if (Object.keys(state.errors).length) ctx.status.set({ state: "warning", message: `${Object.keys(state.errors).length} account(s) failing: ${Object.values(state.errors)[0]}`, action: { label: "open calendar", page: "calendar" } });
      else ctx.status.set({ state: "ok" });
    };
    reportStatus();
    schedule();
    ctx.settings.onChange(schedule);

    /* ---- api ---- */
    http.get("/accounts", (c) => c.json(accounts().map(publicAccount)));
    http.post("/accounts", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as Partial<Account>;
      if (!b.url || !b.type) return c.json({ error: "type and url required" }, 400);
      const acc: Account = {
        id: uid(),
        type: b.type,
        name: b.name?.trim() || (b.type === "ics" ? "feed" : new URL(normalizeCaldavUrl(b.url)).host),
        url: b.url.trim(),
        username: b.username?.trim() || undefined,
        password: b.password || undefined,
        color: b.color || PALETTE[accounts().length % PALETTE.length]!,
        enabled: true,
        hiddenCalendars: [],
      };
      saveAccounts([...accounts(), acc]);
      reportStatus();
      void refresh();
      return c.json(publicAccount(acc), 201);
    });
    http.patch("/accounts/:id", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as Partial<Account>;
      const list = accounts();
      const acc = list.find((a) => a.id === c.req.param("id"));
      if (!acc) return c.json({ error: "not found" }, 404);
      if (b.name !== undefined) acc.name = b.name;
      if (b.url !== undefined) acc.url = b.url;
      if (b.username !== undefined) acc.username = b.username || undefined;
      if (b.password !== undefined && b.password !== "••••••") acc.password = b.password || undefined;
      if (b.color !== undefined) acc.color = b.color;
      if (b.enabled !== undefined) acc.enabled = b.enabled;
      if (b.hiddenCalendars !== undefined) acc.hiddenCalendars = b.hiddenCalendars;
      saveAccounts(list);
      void refresh();
      return c.json(publicAccount(acc));
    });
    http.delete("/accounts/:id", (c) => {
      saveAccounts(accounts().filter((a) => a.id !== c.req.param("id")));
      reportStatus();
      void refresh();
      return c.json({ ok: true });
    });
    http.post("/accounts/test", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as Partial<Account>;
      try {
        const acc: Account = { id: "test", type: b.type ?? "ics", name: "test", url: b.url ?? "", username: b.username, password: b.password, color: "#000", enabled: true };
        const r = acc.type === "ics" ? await fetchIcs(acc) : await fetchCaldav(acc);
        return c.json({ ok: true, calendars: r.calendars.map((x) => x.name), events: r.events.length });
      } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 400);
      }
    });
    http.post("/refresh", async (c) => {
      await refresh();
      return c.json({ ok: true, fetchedAt: state.fetchedAt });
    });
    http.get("/calendars", (c) => c.json({ calendars: state.calendars, errors: state.errors, fetchedAt: state.fetchedAt }));
    http.get("/events", (c) => {
      const from = c.req.query("from") ? new Date(c.req.query("from")!) : new Date();
      const to = c.req.query("to") ? new Date(c.req.query("to")!) : new Date(Date.now() + 7 * 86400_000);
      const only = (c.req.query("calendars") ?? "").split(",").filter(Boolean);
      const list = state.events.filter((e) => new Date(e.end) >= from && new Date(e.start) <= to && (only.length === 0 || only.includes(e.calendarId)));
      return c.json({ events: list, fetchedAt: state.fetchedAt, errors: state.errors });
    });

    // "starts in a few minutes" for timed events; keyed per event so a refresh does not duplicate
    ctx.scheduler.every("upcoming", 60_000, () => {
      const now = Date.now();
      for (const e of state.events) {
        if (e.allDay) continue;
        const start = new Date(e.start).getTime();
        const mins = Math.round((start - now) / 60_000);
        if (mins === 15 || mins === 14) {
          ctx.notify({ key: `soon:${e.id}`, title: `in 15 min: ${e.title}`, body: e.location ?? undefined, level: "info", icon: "calendar", url: "/m/?id=calendar&page=calendar" });
        }
      }
    });
    logger.info(`calendar ready (${accounts().length} accounts)`);

    einkRender = (req) => {
      const cfg = req.config as { days?: number; calendars?: string[] };
      const only = cfg.calendars?.length ? new Set(cfg.calendars) : null;
      const from = new Date(req.now);
      from.setHours(0, 0, 0, 0);
      const to = new Date(from.getTime() + (req.widget === "next" ? 30 : (cfg.days ?? 7)) * 86400_000);
      const evs = state.events.filter((e) => new Date(e.end) >= from && new Date(e.start) <= to && (!only || only.has(e.calendarId)));
      const fmtT = (iso: string) => new Date(iso).toLocaleTimeString(req.locale, { hour: "2-digit", minute: "2-digit", timeZone: req.timezone });
      const dayOf = (e: CalEvent) => (e.allDay ? new Date(e.start.slice(0, 10) + "T12:00:00") : new Date(e.start));
      const label = (d: Date) => {
        const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - from.getTime()) / 86400_000);
        return diff === 0 ? "today" : diff === 1 ? "tomorrow" : d.toLocaleDateString(req.locale, { weekday: "short", day: "numeric", month: "short" }).toLowerCase();
      };
      if (req.widget === "next") {
        const n = evs.find((e) => !e.allDay && new Date(e.end) > req.now) ?? evs[0];
        if (!n) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: "no upcoming events", size: 14, gray: 0.5 }] };
        return {
          type: "col",
          grow: 1,
          justify: "center",
          gap: 4,
          children: [
            { type: "text", text: `${label(dayOf(n))} · ${n.allDay ? "all day" : fmtT(n.start)}`, size: 12, pixel: false, gray: 0.5 },
            { type: "text", text: n.title, size: Math.max(16, Math.min(28, req.width / 14)), wrap: true },
            ...(n.location ? [{ type: "text" as const, text: n.location, size: 12, pixel: false, gray: 0.5 }] : []),
          ],
        };
      }
      if (req.widget === "month") {
        // compact month grid with event dots
        const first = new Date(req.now.getFullYear(), req.now.getMonth(), 1);
        const offset = (first.getDay() + 6) % 7;
        const daysIn = new Date(req.now.getFullYear(), req.now.getMonth() + 1, 0).getDate();
        const monthEvs = state.events.filter((e) => new Date(e.start).getMonth() === req.now.getMonth() && (!only || only.has(e.calendarId)));
        const has = new Set(monthEvs.map((e) => dayOf(e).getDate()));
        const cells: import("@orbis/sdk/server").EinkTree[] = [];
        for (let i = 0; i < offset; i++) cells.push({ type: "spacer", grow: 1 });
        for (let d = 1; d <= daysIn; d++) cells.push({ type: "col", grow: 1, align: "center", children: [{ type: "text", text: String(d), size: 12, pixel: false, bold: d === req.now.getDate() }, { type: "dots", count: 1, filled: has.has(d) ? 1 : 0, size: 5 }] });
        while (cells.length % 7) cells.push({ type: "spacer", grow: 1 });
        const weeks: import("@orbis/sdk/server").EinkTree[] = [];
        for (let i = 0; i < cells.length; i += 7) weeks.push({ type: "row", grow: 1, children: cells.slice(i, i + 7) });
        return { type: "col", grow: 1, gap: 2, children: [{ type: "text", text: req.now.toLocaleDateString(req.locale, { month: "long", year: "numeric" }).toLowerCase(), size: 14, align: "center" }, { type: "row", children: ["mo", "tu", "we", "th", "fr", "sa", "su"].map((n) => ({ type: "text" as const, text: n, size: 10, gray: 0.5, grow: 1, align: "center" as const })) }, ...weeks] };
      }
      // agenda
      if (evs.length === 0) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: "nothing coming up", size: 14, gray: 0.5 }] };
      const rowH = 20;
      const max = Math.max(1, Math.floor((req.height - 4) / rowH));
      const rows: import("@orbis/sdk/server").EinkTree[] = [];
      let lastDay = "";
      for (const e of evs) {
        if (rows.length >= max) break;
        const d = dayOf(e);
        const l = label(d);
        if (l !== lastDay) {
          rows.push({ type: "text", text: l, size: 12, gray: 0.5 });
          lastDay = l;
          if (rows.length >= max) break;
        }
        rows.push({ type: "row", gap: 6, align: "center", children: [{ type: "text", text: e.allDay ? "all day" : fmtT(e.start), size: 12, pixel: false, gray: 0.6, wrap: false }, { type: "text", text: e.title, size: 13, pixel: false, grow: 1, wrap: false }] });
      }
      return { type: "col", grow: 1, gap: 2, children: rows };
    };
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;

export type { ModuleServerContext };
