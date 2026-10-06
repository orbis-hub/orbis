import { defineModule, hexColor, parseBody, z, type ModuleServerContext, type Translator } from "@orbis/sdk/server";
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

export type EventsResponse = {
  events: CalEvent[];
  fetchedAt: string;
  errors: Record<string, string>;
  /** true when at least one enabled account could not be loaded for this range */
  partial: boolean;
  /** the range the refresh cache covers; requests outside it are expanded on demand */
  covered: { from: string; to: string };
};

type State = { calendars: Calendar[]; events: CalEvent[]; fetchedAt: string; errors: Record<string, string>; window?: { from: string; to: string } };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const PALETTE = ["#e2789b", "#8b7fd6", "#4fc47f", "#f0b232", "#4f93d6", "#f23f43", "#2f9fbf", "#d9702e"];
/** the longest window `/events` expands on demand */
const MAX_RANGE_DAYS = 400;

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

/** ics feed url → https url, or null when it is not a usable http(s)/webcal url */
export function normalizeIcsUrl(input: string): string | null {
  const u = input.trim().replace(/^webcal:\/\//i, "https://");
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** caldav server url → normalized root, or null when it cannot be parsed */
export function safeCaldavUrl(input: string, username?: string): string | null {
  try {
    const u = normalizeCaldavUrl(input, username);
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

/** an ics feed must contain a VCALENDAR; html pages, json and login forms do not */
export function isCalendarText(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text.slice(0, 8192));
}

function explainCaldavError(t: Translator, err: Error, serverUrl: string): string {
  const m = err.message ?? String(err);
  const host = (() => {
    try {
      return new URL(serverUrl).host;
    } catch {
      return serverUrl;
    }
  })();
  if (/401|Unauthorized|Invalid credentials/i.test(m)) {
    if (host.includes("icloud.com")) return t("error.401.icloud");
    if (host.includes("fastmail.com")) return t("error.401.fastmail");
    return t("error.401", { host });
  }
  if (/principalUrl|principal/i.test(m)) return t("error.principal", { host });
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo/i.test(m)) return t("error.unreachable", { host, message: m });
  if (/403|Forbidden/i.test(m)) return t("error.403", { host });
  return m;
}

/* ---------- ics parsing (shared by feeds and caldav objects) ---------- */

type IcalDate = Date & { tz?: string; dateOnly?: boolean };
const pad = (n: number) => String(n).padStart(2, "0");

/** calendar day ("YYYY-MM-DD") of an instant in `tz` (iana zone); without a zone the server's local day */
export function dayKeyIn(d: Date, tz?: string): string {
  if (tz) {
    try {
      // en-CA formats as 2026-10-07
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    } catch {
      /* unknown zone id: fall through to the server zone */
    }
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** more than one occurrence per day possible (FREQ=HOURLY/MINUTELY/SECONDLY) → only exact instants may match */
function isSubDaily(rrule: VEvent["rrule"]): boolean {
  const f = (rrule as unknown as { options?: { freq?: unknown } })?.options?.freq;
  if (typeof f === "string") return /^(HOURLY|MINUTELY|SECONDLY)$/i.test(f);
  if (typeof f === "number") return f >= 4; // rrule.js: YEARLY 0 … DAILY 3, HOURLY 4
  try {
    return /FREQ=(HOURLY|MINUTELY|SECONDLY)/i.test(String(rrule));
  } catch {
    return false;
  }
}

/**
 * Expand a VCALENDAR into events inside [from, to].
 * Recurrences are expanded by node-ical in the event's own TZID (rrule-temporal), so a weekly 09:00 New York event
 * stays 09:00 New York across the hub's dst switch. Overrides (RECURRENCE-ID) and EXDATEs are matched on the exact
 * instant and, for daily-or-coarser rules, on the calendar day in the event's zone (never the hub's/utc day).
 */
export function parseIcs(text: string, cal: Calendar, from: Date, to: Date, untitled = "(untitled)"): CalEvent[] {
  const data = ical.sync.parseICS(text);
  const out: CalEvent[] = [];
  for (const item of Object.values(data)) {
    if (!item || (item as { type?: string }).type !== "VEVENT") continue;
    const ev = item as VEvent;
    if (!(ev.start instanceof Date)) continue;
    const allDay = (ev.start as IcalDate).dateOnly === true || (ev.datetype as string | undefined) === "date";
    const tz = allDay ? undefined : (ev.start as IcalDate).tz;
    // all-day events carry a plain DATE; serialise them as utc midnight of that calendar day so no timezone shifts the day
    const asDay = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const push = (start: Date, end: Date, suffix = "", src: VEvent = ev) => {
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
        title: String(src.summary ?? ev.summary ?? untitled),
        start: start.toISOString(),
        end: end.toISOString(),
        allDay,
        location: src.location ? String(src.location) : undefined,
        description: src.description ? String(src.description).slice(0, 500) : undefined,
        url: src.url ? String(src.url) : undefined,
        recurring: !!ev.rrule,
      });
    };
    const duration = ev.end instanceof Date && ev.start ? ev.end.getTime() - ev.start.getTime() : allDay ? 86400_000 : 3600_000;
    if (ev.rrule) {
      let dates: Date[];
      try {
        dates = ev.rrule.between(from, to, true);
      } catch {
        dates = [];
      }
      const subDaily = isSubDaily(ev.rrule);
      // exdates: exact instants, plus the local day for date-only values and for rules with one occurrence per day
      const exInstants = new Set<number>();
      const exDays = new Set<string>();
      for (const raw of Object.values(ev.exdate ?? {})) {
        const d = raw as IcalDate;
        if (!(d instanceof Date) || Number.isNaN(d.getTime())) continue;
        if (!d.dateOnly) exInstants.add(d.getTime());
        if (d.dateOnly || allDay || !subDaily) exDays.add(dayKeyIn(d, tz));
      }
      // overrides (modified single instances), keyed the same way
      const ovInstants = new Map<number, VEvent>();
      const ovDays = new Map<string, VEvent>();
      const overrides = new Set(Object.values(ev.recurrences ?? {}) as VEvent[]);
      for (const o of overrides) {
        const rid = (o as { recurrenceid?: IcalDate }).recurrenceid;
        if (!(rid instanceof Date) || Number.isNaN(rid.getTime())) continue;
        if (!rid.dateOnly) ovInstants.set(rid.getTime(), o);
        if (rid.dateOnly || allDay || !subDaily) ovDays.set(dayKeyIn(rid, tz), o);
      }
      const used = new Set<VEvent>();
      for (const d of dates) {
        const key = dayKeyIn(d, tz);
        if (exInstants.has(d.getTime()) || exDays.has(key)) continue;
        const override = ovInstants.get(d.getTime()) ?? ovDays.get(key);
        if (override) {
          used.add(override);
          if (override.start instanceof Date) push(override.start, override.end instanceof Date ? override.end : new Date(override.start.getTime() + duration), `@${d.toISOString()}`, override);
        } else {
          push(d, new Date(d.getTime() + duration), `@${d.toISOString()}`);
        }
      }
      // an instance moved *into* this range from outside it has no generated occurrence to replace
      for (const o of overrides) {
        if (used.has(o) || !(o.start instanceof Date)) continue;
        const rid = (o as { recurrenceid?: Date }).recurrenceid;
        push(o.start, o.end instanceof Date ? o.end : new Date(o.start.getTime() + duration), `@${rid instanceof Date ? rid.toISOString() : o.start.toISOString()}`, o);
      }
    } else {
      push(ev.start, ev.end instanceof Date ? ev.end : new Date(ev.start.getTime() + duration));
    }
  }
  return out;
}

/* ---------- module ---------- */

const accountInput = z.object({
  type: z.enum(["ics", "caldav"]),
  url: z.string().trim().min(1).max(2048),
  name: z.string().trim().max(120).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
  color: hexColor.optional(),
});
const accountPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(500).optional(),
  color: hexColor.optional(),
  enabled: z.boolean().optional(),
  hiddenCalendars: z.array(z.string().max(2048)).max(500).optional(),
});

export default defineModule<{ refreshMinutes?: number }>({
  setup(ctx) {
    const { http, storage, events, logger } = ctx;
    const t: Translator = (key, vars) => ctx.i18n.t(key, vars);
    let state: State = storage.get<State>("state") ?? { calendars: [], events: [], fetchedAt: "", errors: {} };
    const accounts = (): Account[] => storage.get<Account[]>("accounts") ?? [];
    const saveAccounts = (a: Account[]) => storage.set("accounts", a);
    const publicAccount = (a: Account) => ({ ...a, password: a.password ? "••••••" : undefined, hasPassword: !!a.password });
    /** raw feed text per ics account (from the last refresh) so other ranges can be expanded without a network round trip */
    const rawIcs = new Map<string, string>();
    /** on-demand expansions outside the refresh window, keyed by range */
    const rangeCache = new Map<string, { at: number; events: CalEvent[]; errors: Record<string, string> }>();

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

    /** url the account points at, validated; throws a translated error for garbage */
    const feedUrl = (acc: Account): string => {
      const u = acc.type === "ics" ? normalizeIcsUrl(acc.url) : safeCaldavUrl(acc.url, acc.username);
      if (!u) throw new Error(t("error.invalidUrl"));
      return u;
    };

    async function fetchIcsText(acc: Account): Promise<string> {
      const url = feedUrl(acc);
      const headers: Record<string, string> = { accept: "text/calendar, text/plain;q=0.8, */*;q=0.5" };
      if (acc.username && acc.password) headers.authorization = `Basic ${Buffer.from(`${acc.username.trim()}:${acc.password.replace(/\s+/g, "")}`).toString("base64")}`;
      const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(20_000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!isCalendarText(text)) {
        const host = new URL(url).host;
        throw new Error(t("error.notCalendar", { host, type: (res.headers.get("content-type") ?? "unknown").split(";")[0]!.trim() }));
      }
      return text;
    }

    async function fetchIcs(acc: Account, from: Date, to: Date, remember = false): Promise<{ calendars: Calendar[]; events: CalEvent[] }> {
      const text = await fetchIcsText(acc);
      if (remember) rawIcs.set(acc.id, text);
      const cal: Calendar = { id: acc.id, accountId: acc.id, name: acc.name, color: acc.color, url: feedUrl(acc), writable: false };
      return { calendars: [cal], events: parseIcs(text, cal, from, to, t("event.untitled")) };
    }

    async function fetchCaldav(acc: Account, from: Date, to: Date): Promise<{ calendars: Calendar[]; events: CalEvent[] }> {
      if (!acc.username || !acc.password) throw new Error(t("error.credentials"));
      const serverUrl = feedUrl(acc);
      if (serverUrl.includes("googleusercontent.com") || serverUrl.includes("google.com")) {
        throw new Error(t("error.google"));
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
            throw new Error(explainCaldavError(t, err as Error, serverUrl));
          }
        }
        if (probe && (probe.status === 401 || probe.status === 403)) throw new Error(explainCaldavError(t, new Error(`HTTP ${probe.status} Unauthorized`), serverUrl));
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
        throw new Error(explainCaldavError(t, err as Error, serverUrl));
      }
      let cals: DAVCalendar[];
      try {
        cals = (await client.fetchCalendars()) as DAVCalendar[];
      } catch (err) {
        throw new Error(explainCaldavError(t, err as Error, serverUrl));
      }
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
          for (const o of objects) if (o.data) evs.push(...parseIcs(String(o.data), cal, from, to, t("event.untitled")));
        } catch (err) {
          logger.warn(`calendar ${cal.name}: ${(err as Error).message}`);
        }
      }
      return { calendars, events: evs };
    }

    const fetchAccount = (acc: Account, from: Date, to: Date, remember = false) => (acc.type === "ics" ? fetchIcs(acc, from, to, remember) : fetchCaldav(acc, from, to));

    let refreshing: Promise<void> | null = null;
    function refresh(): Promise<void> {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const { from, to } = range();
        const next: State = { calendars: [], events: [], fetchedAt: new Date().toISOString(), errors: {}, window: { from: from.toISOString(), to: to.toISOString() } };
        for (const acc of accounts()) {
          if (!acc.enabled) continue;
          try {
            const r = await fetchAccount(acc, from, to, true);
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
        rangeCache.clear();
        storage.set("state", state);
        reportStatus();
        events.publish("updated", { events: state.events.length, errors: Object.keys(state.errors).length });
      })().finally(() => (refreshing = null));
      return refreshing;
    }

    /** events for a range the refresh cache does not cover: re-parse the remembered feed text, ask caldav servers for that range */
    async function expandRange(from: Date, to: Date): Promise<{ events: CalEvent[]; errors: Record<string, string> }> {
      const key = `${from.toISOString()}|${to.toISOString()}`;
      const hit = rangeCache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
      const out: CalEvent[] = [];
      const errors: Record<string, string> = {};
      for (const acc of accounts()) {
        if (!acc.enabled) continue;
        try {
          if (acc.type === "ics") {
            const text = rawIcs.get(acc.id) ?? (await fetchIcsText(acc));
            rawIcs.set(acc.id, text);
            const cal = state.calendars.find((c) => c.id === acc.id) ?? { id: acc.id, accountId: acc.id, name: acc.name, color: acc.color, url: acc.url, writable: false };
            out.push(...parseIcs(text, cal, from, to, t("event.untitled")));
          } else {
            out.push(...(await fetchCaldav(acc, from, to)).events);
          }
        } catch (err) {
          errors[acc.id] = (err as Error).message;
          logger.warn(`account ${acc.name} (range ${key}): ${(err as Error).message}`);
        }
      }
      out.sort((a, b) => a.start.localeCompare(b.start));
      if (rangeCache.size >= 24) rangeCache.clear();
      const entry = { at: Date.now(), events: out, errors };
      rangeCache.set(key, entry);
      return entry;
    }

    const schedule = () => ctx.scheduler.every("refresh", (ctx.settings.get().refreshMinutes ?? 10) * 60_000, refresh, { immediate: true });
    const reportStatus = () => {
      const list = accounts();
      if (list.length === 0) ctx.status.set({ state: "needs-setup", message: t("status.noAccounts"), action: { label: t("status.addAccount"), page: "calendar" } });
      else if (Object.keys(state.errors).length) ctx.status.set({ state: "warning", message: t("status.failing", { count: Object.keys(state.errors).length, error: Object.values(state.errors)[0] }), action: { label: t("status.openCalendar"), page: "calendar" } });
      else ctx.status.set({ state: "ok" });
    };
    reportStatus();
    schedule();
    ctx.settings.onChange(schedule);
    // status text and account error messages are language-dependent: re-report / re-fetch when the hub language changes
    ctx.i18n.onChange(() => {
      reportStatus();
      if (Object.keys(state.errors).length) void refresh();
    });

    /* ---- api ---- */
    const invalidUrl = (type: AccountType, url: string, username?: string) => (type === "ics" ? !normalizeIcsUrl(url) : !safeCaldavUrl(url, username));
    http.get("/accounts", (c) => c.json(accounts().map(publicAccount)));
    http.post("/accounts", async (c) => {
      const b = await parseBody(c, accountInput);
      if (!b.ok) return b.res;
      const { type, url, username } = b.data;
      if (invalidUrl(type, url, username)) return c.json({ error: t("error.invalidUrl") }, 400);
      const acc: Account = {
        id: uid(),
        type,
        name: b.data.name || (type === "ics" ? "feed" : new URL(safeCaldavUrl(url, username)!).host),
        url,
        username: username || undefined,
        password: b.data.password || undefined,
        color: b.data.color || PALETTE[accounts().length % PALETTE.length]!,
        enabled: true,
        hiddenCalendars: [],
      };
      saveAccounts([...accounts(), acc]);
      reportStatus();
      void refresh();
      return c.json(publicAccount(acc), 201);
    });
    http.patch("/accounts/:id", async (c) => {
      const b = await parseBody(c, accountPatch);
      if (!b.ok) return b.res;
      const list = accounts();
      const acc = list.find((a) => a.id === c.req.param("id"));
      if (!acc) return c.json({ error: "not found" }, 404);
      const d = b.data;
      if (d.url !== undefined && invalidUrl(acc.type, d.url, d.username ?? acc.username)) return c.json({ error: t("error.invalidUrl") }, 400);
      if (d.name !== undefined) acc.name = d.name;
      if (d.url !== undefined) acc.url = d.url;
      if (d.username !== undefined) acc.username = d.username || undefined;
      if (d.password !== undefined && d.password !== "••••••") acc.password = d.password || undefined;
      if (d.color !== undefined) acc.color = d.color;
      if (d.enabled !== undefined) acc.enabled = d.enabled;
      if (d.hiddenCalendars !== undefined) acc.hiddenCalendars = d.hiddenCalendars;
      saveAccounts(list);
      void refresh();
      return c.json(publicAccount(acc));
    });
    http.delete("/accounts/:id", (c) => {
      const list = accounts();
      if (!list.some((a) => a.id === c.req.param("id"))) return c.json({ error: "not found" }, 404);
      saveAccounts(list.filter((a) => a.id !== c.req.param("id")));
      rawIcs.delete(c.req.param("id"));
      reportStatus();
      void refresh();
      return c.json({ ok: true });
    });
    http.post("/accounts/test", async (c) => {
      const b = await parseBody(c, accountInput);
      if (!b.ok) return b.res;
      const { type, url, username } = b.data;
      if (invalidUrl(type, url, username)) return c.json({ ok: false, error: t("error.invalidUrl") }, 400);
      try {
        const acc: Account = { id: "test", type, name: "test", url, username: username || undefined, password: b.data.password || undefined, color: "#000", enabled: true };
        const { from, to } = range();
        const r = await fetchAccount(acc, from, to);
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
    http.get("/events", async (c) => {
      const parseDate = (v: string | undefined, fallback: Date): Date | null => {
        if (v === undefined || v === "") return fallback;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
      };
      const from = parseDate(c.req.query("from"), new Date());
      const to = parseDate(c.req.query("to"), new Date(Date.now() + 7 * 86400_000));
      if (!from || !to || to < from || to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86400_000) return c.json({ error: t("error.invalidRange", { days: MAX_RANGE_DAYS }) }, 400);
      const only = (c.req.query("calendars") ?? "").split(",").filter(Boolean);
      const inRange = (e: CalEvent) => new Date(e.end) >= from && new Date(e.start) <= to && (only.length === 0 || only.includes(e.calendarId));
      const win = state.window ?? (() => {
        const r = range();
        return { from: r.from.toISOString(), to: r.to.toISOString() };
      })();
      const covered = from >= new Date(win.from) && to <= new Date(win.to);
      if (covered || accounts().every((a) => !a.enabled)) {
        const res: EventsResponse = { events: state.events.filter(inRange), fetchedAt: state.fetchedAt, errors: state.errors, partial: Object.keys(state.errors).length > 0, covered: win };
        return c.json(res);
      }
      // outside the refresh window: expand on demand (feed text is remembered, caldav is asked for that range)
      const r = await expandRange(from, to);
      const res: EventsResponse = { events: r.events.filter(inRange), fetchedAt: state.fetchedAt, errors: r.errors, partial: Object.keys(r.errors).length > 0, covered: win };
      return c.json(res);
    });

    // "starts in a few minutes" for timed events; keyed per event so a refresh does not duplicate
    ctx.scheduler.every("upcoming", 60_000, () => {
      const now = Date.now();
      for (const e of state.events) {
        if (e.allDay) continue;
        const start = new Date(e.start).getTime();
        const mins = Math.round((start - now) / 60_000);
        if (mins === 15 || mins === 14) {
          ctx.notify({ key: `soon:${e.id}`, title: t("notify.soon", { title: e.title }), body: e.location ?? undefined, level: "info", icon: "calendar", url: "/m/?id=calendar&page=calendar" });
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
        return diff === 0 ? t("day.today") : diff === 1 ? t("day.tomorrow") : d.toLocaleDateString(req.locale, { weekday: "short", day: "numeric", month: "short" }).toLowerCase();
      };
      if (req.widget === "next") {
        const n = evs.find((e) => !e.allDay && new Date(e.end) > req.now) ?? evs[0];
        if (!n) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: t("widget.next.empty"), size: 14, gray: 0.5 }] };
        return {
          type: "col",
          grow: 1,
          justify: "center",
          gap: 4,
          children: [
            { type: "text", text: `${label(dayOf(n))} · ${n.allDay ? t("event.allDay") : fmtT(n.start)}`, size: 12, pixel: false, gray: 0.5 },
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
        return { type: "col", grow: 1, gap: 2, children: [{ type: "text", text: req.now.toLocaleDateString(req.locale, { month: "long", year: "numeric" }).toLowerCase(), size: 14, align: "center" }, { type: "row", children: ["mo", "tu", "we", "th", "fr", "sa", "su"].map((n) => ({ type: "text" as const, text: t(`weekday.${n}`), size: 10, gray: 0.5, grow: 1, align: "center" as const })) }, ...weeks] };
      }
      // agenda
      if (evs.length === 0) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: t("widget.agenda.empty"), size: 14, gray: 0.5 }] };
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
        rows.push({ type: "row", gap: 6, align: "center", children: [{ type: "text", text: e.allDay ? t("event.allDay") : fmtT(e.start), size: 12, pixel: false, gray: 0.6, wrap: false }, { type: "text", text: e.title, size: 13, pixel: false, grow: 1, wrap: false }] });
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
