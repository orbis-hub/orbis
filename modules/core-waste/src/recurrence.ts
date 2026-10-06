/** Manual rules: "every N weeks on weekday X from a start date" or explicit dates, plus german nationwide holidays. */
import { addDays, fromIso, isIso, mondayOf, pad2, toIso, weekday } from "./dates";
import type { ManualRule } from "./types";

/** easter sunday (gregorian, anonymous/meeus algorithm) */
export function easter(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** nationwide german public holidays (no state-specific ones) */
export function germanHolidays(year: number): Set<string> {
  const e = easter(year);
  return new Set([
    `${year}-01-01`, // neujahr
    addDays(e, -2), // karfreitag
    addDays(e, 1), // ostermontag
    `${year}-05-01`, // tag der arbeit
    addDays(e, 39), // christi himmelfahrt
    addDays(e, 50), // pfingstmontag
    `${year}-10-03`, // tag der deutschen einheit
    `${year}-12-25`,
    `${year}-12-26`,
  ]);
}

const holidayCache = new Map<number, Set<string>>();
export function isGermanHoliday(iso: string): boolean {
  const y = Number(iso.slice(0, 4));
  let set = holidayCache.get(y);
  if (!set) holidayCache.set(y, (set = germanHolidays(y)));
  return set.has(iso);
}

/**
 * The usual german convention: a holiday pushes that day's and every later pickup of the same week one day back
 * (monday holiday → monday's pickup on tuesday, tuesday's on wednesday …).
 */
export function shiftForHolidays(iso: string): string {
  const monday = mondayOf(iso);
  let shift = 0;
  for (let d = monday; d <= iso; d = addDays(d, 1)) if (isGermanHoliday(d)) shift++;
  return shift ? addDays(iso, shift) : iso;
}

export function parseRule(json: string | null | undefined): ManualRule | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Partial<ManualRule> & { mode?: string };
    if (r.mode === "weekly") {
      const w = r as Extract<ManualRule, { mode: "weekly" }>;
      if (!isIso(w.start) || !Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) return null;
      return { mode: "weekly", interval: Math.min(52, Math.max(1, Math.round(Number(w.interval) || 1))), weekday: w.weekday, start: w.start };
    }
    if (r.mode === "dates") {
      const d = r as Extract<ManualRule, { mode: "dates" }>;
      return { mode: "dates", dates: Array.from(new Set((d.dates ?? []).filter(isIso))).sort() };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** all pickup dates of a rule in [from, to], optionally shifted for holidays */
export function expandRule(rule: ManualRule, from: string, to: string, opts: { shiftOnHolidays?: boolean } = {}): string[] {
  let out: string[] = [];
  if (rule.mode === "dates") out = rule.dates.filter((d) => d >= from && d <= to);
  else {
    // first occurrence on/after start that lands on the weekday
    let first = rule.start;
    const delta = (rule.weekday - weekday(first) + 7) % 7;
    first = addDays(first, delta);
    const step = rule.interval * 7;
    // jump close to `from` instead of iterating from a possibly very old start
    if (first < from) {
      const gap = Math.round((fromIso(from).getTime() - fromIso(first).getTime()) / 86400_000);
      first = addDays(first, Math.floor(gap / step) * step);
    }
    for (let d = first; d <= to; d = addDays(d, step)) if (d >= from) out.push(d);
  }
  if (opts.shiftOnHolidays) out = out.map(shiftForHolidays).filter((d) => d <= to);
  return Array.from(new Set(out)).sort();
}

export { toIso };
