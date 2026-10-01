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
      if (acc.username && acc.password) headers.authorization = `Basic ${Buffer.from(`${acc.username}:${acc.password}`).toString("base64")}`;
      const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(20_000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cal: Calendar = { id: acc.id, accountId: acc.id, name: acc.name, color: acc.color, url, writable: false };
      const { from, to } = range();
      return { calendars: [cal], events: parseIcs(await res.text(), cal, from, to) };
    }

    async function fetchCaldav(acc: Account): Promise<{ calendars: Calendar[]; events: CalEvent[] }> {
      if (!acc.username || !acc.password) throw new Error("username and password required");
      const client = await createDAVClient({
        serverUrl: normalizeCaldavUrl(acc.url, acc.username),
        credentials: { username: acc.username, password: acc.password },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
      const cals = (await client.fetchCalendars()) as DAVCalendar[];
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
        events.publish("updated", { events: state.events.length, errors: Object.keys(state.errors).length });
      })().finally(() => (refreshing = null));
      return refreshing;
    }

    const schedule = () => ctx.scheduler.every("refresh", (ctx.settings.get().refreshMinutes ?? 10) * 60_000, refresh, { immediate: true });
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

    logger.info(`calendar ready (${accounts().length} accounts)`);
  },
});

export type { ModuleServerContext };
