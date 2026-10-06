/**
 * Tiny, tolerant iCalendar parser for municipal waste feeds. No dependency.
 * Handles CRLF/LF, line folding, `DTSTART;VALUE=DATE:20261012`, date-times (local, floating or UTC),
 * escaped text and a minimal RRULE (DAILY/WEEKLY with INTERVAL/UNTIL/COUNT) bounded to a horizon.
 */
import { addDays, pad2, toIso } from "./dates";

export type IcsEvent = { date: string; summary: string; uid: string | null; description: string | null };

type Prop = { name: string; params: Record<string, string>; value: string };

/** join folded lines (a following line starting with space/tab continues the previous one) */
export function unfold(text: string): string[] {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out.filter((l) => l.length > 0);
}

function parseLine(line: string): Prop | null {
  // find the first ':' that is not inside double quotes (params may contain quoted colons)
  let inQ = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === ":" && !inQ) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon), value = line.slice(colon + 1);
  const parts = head.split(";");
  const name = (parts[0] ?? "").trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

export function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

/** "20261012", "20261012T060000", "20261012T060000Z" → local "YYYY-MM-DD" (UTC stamps are converted to local time) */
export function parseIcsDate(value: string, params: Record<string, string> = {}): string | null {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (!m[4] || params.VALUE === "DATE") return `${m[1]}-${m[2]}-${m[3]}`;
  const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6] ?? "0");
  if (m[7] === "Z") return toIso(new Date(Date.UTC(y, mo - 1, d, h, mi, s)));
  return `${m[1]}-${m[2]}-${m[3]}`; // floating / tzid: take the wall-clock date as given
}

function parseRrule(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

const ICS_DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** expand a simple DAILY/WEEKLY rrule from `start` up to `horizon`; returns [] for anything fancier */
export function expandRrule(start: string, rule: Record<string, string>, horizon: string, max = 400): string[] {
  const freq = rule.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY") return [];
  const interval = Math.max(1, Number(rule.INTERVAL ?? "1") || 1);
  const until = rule.UNTIL ? parseIcsDate(rule.UNTIL) : null;
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const end = until && until < horizon ? until : horizon;
  const out: string[] = [];
  if (freq === "DAILY") {
    for (let d = start, i = 0; d <= end && out.length < max; d = addDays(d, interval), i++) {
      if (count !== null && i >= count) break;
      out.push(d);
    }
    return out;
  }
  // WEEKLY: BYDAY list or the start's weekday
  const days = (rule.BYDAY ? rule.BYDAY.split(",") : []).map((s) => ICS_DOW.indexOf(s.trim().slice(-2))).filter((i) => i >= 0);
  const startDow = new Date(start + "T12:00:00").getDay();
  const dows = days.length ? days : [startDow];
  const monday = addDays(start, -((startDow + 6) % 7));
  let produced = 0;
  for (let week = monday, w = 0; week <= end && out.length < max; week = addDays(week, 7 * interval), w++) {
    for (const dow of dows.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) {
      const d = addDays(week, (dow + 6) % 7);
      if (d < start || d > end) continue;
      if (count !== null && produced >= count) return out;
      out.push(d);
      produced++;
    }
  }
  return out;
}

/**
 * Parse an ics text into dated events. `horizon` bounds recurring events (default: one year from the first event).
 * Events without a parsable DTSTART or SUMMARY are skipped; nothing throws on odd input.
 */
export function parseIcs(text: string, opts: { horizon?: string } = {}): IcsEvent[] {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  let cur: Prop[] | null = null;
  for (const line of lines) {
    const u = line.toUpperCase();
    if (u === "BEGIN:VEVENT") {
      cur = [];
      continue;
    }
    if (u === "END:VEVENT") {
      if (cur) flush(cur, events, opts.horizon);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = parseLine(line);
    if (p) cur.push(p);
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.summary.localeCompare(b.summary));
}

function flush(props: Prop[], out: IcsEvent[], horizon?: string) {
  const get = (n: string) => props.find((p) => p.name === n);
  const dt = get("DTSTART");
  const summary = get("SUMMARY");
  if (!dt || !summary) return;
  const date = parseIcsDate(dt.value, dt.params);
  if (!date) return;
  const base: Omit<IcsEvent, "date"> = { summary: unescapeText(summary.value), uid: get("UID")?.value.trim() || null, description: get("DESCRIPTION") ? unescapeText(get("DESCRIPTION")!.value) : null };
  if (!base.summary) return;
  const rr = get("RRULE");
  if (rr) {
    const hz = horizon ?? addDays(date, 365);
    const ex = new Set(props.filter((p) => p.name === "EXDATE").flatMap((p) => p.value.split(",").map((v) => parseIcsDate(v, p.params)).filter((v): v is string => !!v)));
    const dates = expandRrule(date, parseRrule(rr.value), hz);
    if (dates.length) {
      for (const d of dates) if (!ex.has(d)) out.push({ ...base, date: d });
      return;
    }
  }
  out.push({ ...base, date });
}

/** convenience for tests and the setup preview */
export function icsDateStamp(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}
