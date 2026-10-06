// hub timezone europe/berlin (dst ends oct 25 2026); new york ends dst nov 1 2026
process.env.TZ = "Europe/Berlin";
import { describe, expect, it } from "vitest";
import { dayKeyIn, isCalendarText, normalizeIcsUrl, parseIcs, safeCaldavUrl, type Calendar } from "./server";

const cal: Calendar = { id: "c", accountId: "c", name: "test", color: "#000", url: "https://example.test/cal.ics", writable: false };
const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\n${body.trim().replace(/\n/g, "\r\n")}\r\nEND:VCALENDAR\r\n`;
const from = new Date("2026-10-01T00:00:00Z");
const to = new Date("2026-11-10T00:00:00Z");
const starts = (events: ReturnType<typeof parseIcs>) => events.map((e) => e.start).sort();

describe("recurrence expansion in the event's tzid", () => {
  it("keeps a weekly new york event at 09:00 edt across the hub's dst switch (issue #55.1)", () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:ny
DTSTART;TZID=America/New_York:20260901T090000
DTEND;TZID=America/New_York:20260901T100000
RRULE:FREQ=WEEKLY;BYDAY=TU
SUMMARY:ny weekly
END:VEVENT`);
    const evs = parseIcs(ics, cal, from, to);
    // berlin switched on oct 25, new york only on nov 1: oct 27 must still be 13:00Z, nov 3 is 14:00Z
    expect(starts(evs)).toEqual(["2026-10-06T13:00:00.000Z", "2026-10-13T13:00:00.000Z", "2026-10-20T13:00:00.000Z", "2026-10-27T13:00:00.000Z", "2026-11-03T14:00:00.000Z"]);
    expect(evs.every((e) => e.recurring && !e.allDay && new Date(e.end).getTime() - new Date(e.start).getTime() === 3600_000)).toBe(true);
  });

  it("keeps the local wall-clock for a same-zone weekly event across dst", () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:b
DTSTART;TZID=Europe/Berlin:20261006T100000
DTEND;TZID=Europe/Berlin:20261006T110000
RRULE:FREQ=WEEKLY;COUNT=4
SUMMARY:berlin weekly
END:VEVENT`);
    expect(starts(parseIcs(ics, cal, from, to))).toEqual(["2026-10-06T08:00:00.000Z", "2026-10-13T08:00:00.000Z", "2026-10-20T08:00:00.000Z", "2026-10-27T09:00:00.000Z"]);
  });
});

describe("overrides and exdates are matched on the event's local date (issue #55.2)", () => {
  it("replaces the right instance of a daily 00:30 berlin event", () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:daily
DTSTART;TZID=Europe/Berlin:20261006T003000
DTEND;TZID=Europe/Berlin:20261006T010000
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:daily
END:VEVENT
BEGIN:VEVENT
UID:daily
RECURRENCE-ID;TZID=Europe/Berlin:20261007T003000
DTSTART;TZID=Europe/Berlin:20261007T053000
DTEND;TZID=Europe/Berlin:20261007T060000
SUMMARY:daily (moved)
END:VEVENT`);
    const evs = parseIcs(ics, cal, from, to);
    // oct 6 00:30 → 22:30Z on the 5th; the oct 7 instance is replaced by 05:30 local (03:30Z); oct 8 stays
    expect(starts(evs)).toEqual(["2026-10-05T22:30:00.000Z", "2026-10-07T03:30:00.000Z", "2026-10-07T22:30:00.000Z"]);
    expect(evs.find((e) => e.start === "2026-10-07T03:30:00.000Z")?.title).toBe("daily (moved)");
    expect(evs.some((e) => e.start === "2026-10-06T22:30:00.000Z")).toBe(false);
  });

  it("drops the exdated instance of a late-evening event", () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:late
DTSTART;TZID=Europe/Berlin:20261006T233000
DTEND;TZID=Europe/Berlin:20261007T000000
RRULE:FREQ=DAILY;COUNT=3
EXDATE;TZID=Europe/Berlin:20261007T233000
SUMMARY:late
END:VEVENT`);
    expect(starts(parseIcs(ics, cal, from, to))).toEqual(["2026-10-06T21:30:00.000Z", "2026-10-08T21:30:00.000Z"]);
  });

  it("handles date-only exdates on all-day weekly events", () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:allday
DTSTART;VALUE=DATE:20261006
DTEND;VALUE=DATE:20261007
RRULE:FREQ=WEEKLY;COUNT=3
EXDATE;VALUE=DATE:20261013
SUMMARY:allday
END:VEVENT`);
    const evs = parseIcs(ics, cal, from, to);
    expect(evs.every((e) => e.allDay)).toBe(true);
    expect(starts(evs)).toEqual(["2026-10-06T00:00:00.000Z", "2026-10-20T00:00:00.000Z"]);
  });

  it("includes an instance moved into the range from outside it", () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:moved
DTSTART;TZID=Europe/Berlin:20260901T090000
DTEND;TZID=Europe/Berlin:20260901T100000
RRULE:FREQ=MONTHLY;COUNT=2
SUMMARY:monthly
END:VEVENT
BEGIN:VEVENT
UID:moved
RECURRENCE-ID;TZID=Europe/Berlin:20260901T090000
DTSTART;TZID=Europe/Berlin:20261002T090000
DTEND;TZID=Europe/Berlin:20261002T100000
SUMMARY:monthly (moved into october)
END:VEVENT`);
    const evs = parseIcs(ics, cal, from, to);
    expect(starts(evs)).toEqual(["2026-10-01T07:00:00.000Z", "2026-10-02T07:00:00.000Z"]);
  });
});

describe("expansion outside the refresh window (issue #55.3)", () => {
  it("expands a yearly holiday feed for a month a year ahead", () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:holiday
DTSTART;VALUE=DATE:20260214
DTEND;VALUE=DATE:20260215
RRULE:FREQ=YEARLY
SUMMARY:valentine
END:VEVENT`);
    const evs = parseIcs(ics, cal, new Date("2027-02-01T00:00:00Z"), new Date("2027-02-28T23:59:59Z"));
    expect(starts(evs)).toEqual(["2027-02-14T00:00:00.000Z"]);
  });
});

describe("validation helpers (issue #55.4)", () => {
  it("detects html instead of a calendar", () => {
    expect(isCalendarText("<!doctype html><html><body>login</body></html>")).toBe(false);
    expect(isCalendarText("﻿BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR")).toBe(true);
  });
  it("rejects garbage urls instead of throwing", () => {
    expect(safeCaldavUrl("http://[::1")).toBeNull();
    expect(safeCaldavUrl("caldav.fastmail.com")).toBe("https://caldav.fastmail.com");
    expect(normalizeIcsUrl("webcal://example.test/a.ics")).toBe("https://example.test/a.ics");
    expect(normalizeIcsUrl("ftp://example.test/a.ics")).toBeNull();
    expect(normalizeIcsUrl("not a url")).toBeNull();
  });
  it("computes the calendar day in the event's zone", () => {
    const d = new Date("2026-10-06T22:30:00Z"); // 00:30 berlin on oct 7, 18:30 new york on oct 6
    expect(dayKeyIn(d, "Europe/Berlin")).toBe("2026-10-07");
    expect(dayKeyIn(d, "America/New_York")).toBe("2026-10-06");
  });
});
