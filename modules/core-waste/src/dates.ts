/** Local-date helpers. All "iso" strings are "YYYY-MM-DD" in the hub's local time. */

export const pad2 = (n: number) => String(n).padStart(2, "0");

export function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fromIso(iso: string): Date {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isIso(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(fromIso(s).getTime());
}

export function addDays(iso: string, n: number): string {
  const d = fromIso(iso);
  d.setDate(d.getDate() + n);
  return toIso(d);
}

export function todayIso(now = new Date()): string {
  return toIso(now);
}

/** whole days from `from` to `to` (both local dates) */
export function daysBetween(from: string, to: string): number {
  return Math.round((fromIso(to).getTime() - fromIso(from).getTime()) / 86400_000);
}

/** 0 = sunday … 6 = saturday (javascript convention) */
export function weekday(iso: string): number {
  return fromIso(iso).getDay();
}

/** the monday of the week containing `iso` */
export function mondayOf(iso: string): string {
  const dow = (weekday(iso) + 6) % 7;
  return addDays(iso, -dow);
}
