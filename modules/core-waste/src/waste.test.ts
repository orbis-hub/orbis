import { describe, expect, it } from "vitest";
import { mapTrashName, normalize, providerColor } from "./bins";
import { addDays, daysBetween, mondayOf } from "./dates";
import { mapNominatim } from "./geocode";
import { expandRrule, parseIcs, parseIcsDate, unfold } from "./ics";
import { houseNumberMatches, mapCities, mapDates, mapStreets, mapTrash, matchScore, rankCities, rankStreets } from "./providers/jumomind";
import { easter, expandRule, germanHolidays, parseRule, shiftForHolidays } from "./recurrence";

describe("ics parser", () => {
  it("unfolds continuation lines and handles crlf", () => {
    expect(unfold("A:1\r\n b\r\nB:2\n\tc\n")).toEqual(["A:1b", "B:2c"]);
  });

  it("parses date, datetime and utc stamps", () => {
    expect(parseIcsDate("20261012", { VALUE: "DATE" })).toBe("2026-10-12");
    expect(parseIcsDate("20261012T063000")).toBe("2026-10-12");
    // 23:30Z on the 11th is the 12th in europe/berlin, but the 11th in utc – only assert it is one of the two
    expect(["2026-10-11", "2026-10-12"]).toContain(parseIcsDate("20261011T233000Z"));
    expect(parseIcsDate("not a date")).toBeNull();
    expect(parseIcsDate("20261340")).toBeNull();
  });

  it("parses vevents with folded summaries and escapes", () => {
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:a@x", "DTSTART;VALUE=DATE:20261012", "SUMMARY:Restm\\,üll ", " und Bio", "END:VEVENT", "BEGIN:VEVENT", "DTSTART;TZID=Europe/Berlin:20261003T060000", "SUMMARY:Gelber Sack", "END:VEVENT", "BEGIN:VEVENT", "SUMMARY:no dtstart", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const ev = parseIcs(ics);
    expect(ev).toEqual([
      { date: "2026-10-03", summary: "Gelber Sack", uid: null, description: null },
      { date: "2026-10-12", summary: "Restm,üll und Bio", uid: "a@x", description: null },
    ]);
  });

  it("expands simple weekly rrules bounded by horizon / until / exdate", () => {
    expect(expandRrule("2026-10-06", { FREQ: "WEEKLY", INTERVAL: "2" }, "2026-11-10")).toEqual(["2026-10-06", "2026-10-20", "2026-11-03"]);
    expect(expandRrule("2026-10-06", { FREQ: "WEEKLY", UNTIL: "20261014" }, "2026-12-31")).toEqual(["2026-10-06", "2026-10-13"]);
    expect(expandRrule("2026-10-06", { FREQ: "DAILY", COUNT: "3" }, "2026-12-31")).toEqual(["2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(expandRrule("2026-10-06", { FREQ: "MONTHLY" }, "2026-12-31")).toEqual([]);
    const ics = "BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261006\nRRULE:FREQ=WEEKLY;INTERVAL=2\nEXDATE;VALUE=DATE:20261020\nSUMMARY:Papier\nEND:VEVENT";
    expect(parseIcs(ics, { horizon: "2026-11-05" }).map((e) => e.date)).toEqual(["2026-10-06", "2026-11-03"]);
  });
});

describe("trash name mapping", () => {
  it("maps german titles to bin types", () => {
    expect(mapTrashName("Restmüll")).toBe("residual");
    expect(mapTrashName("Rest- und Biomüll")).toBe("residual");
    expect(mapTrashName("Restabfall 2-wö.")).toBe("residual");
    expect(mapTrashName("Bioabfall")).toBe("organic");
    expect(mapTrashName("Biotonne")).toBe("organic");
    expect(mapTrashName("Altpapier")).toBe("paper");
    expect(mapTrashName("Papiertonne")).toBe("paper");
    expect(mapTrashName("Gelber Sack")).toBe("packaging");
    expect(mapTrashName("Wertstofftonne")).toBe("packaging");
    expect(mapTrashName("Altglas")).toBe("glass");
    expect(mapTrashName("Sperrmüll")).toBe("bulky");
    expect(mapTrashName("Schadstoffmobil")).toBe("hazardous");
    expect(mapTrashName("Weihnachtsbäume")).toBe("christmas");
    expect(mapTrashName("Tannenbaumabfuhr")).toBe("christmas");
    expect(mapTrashName("Baum- und Strauchschnitt")).toBe("custom");
  });
  it("falls back to provider codes", () => {
    expect(mapTrashName("", "WITT_GELB")).toBe("packaging");
    expect(mapTrashName("", "DA_PAP")).toBe("paper");
    expect(mapTrashName("", "DA_REST_2W")).toBe("residual");
    expect(mapTrashName("", "XY_BIO")).toBe("organic");
    expect(mapTrashName("", "XY_FOO")).toBe("custom");
  });
  it("normalizes umlauts", () => {
    expect(normalize("Würzburg (Stadt)")).toBe("wuerzburg stadt");
    expect(providerColor("f3f880")).toBe("#f3f880");
    expect(providerColor("FFFF00")).toBe("#ffff00");
    expect(providerColor("zzz")).toBeNull();
  });
});

describe("manual recurrence", () => {
  it("expands every-n-weeks rules from a start date", () => {
    const rule = parseRule(JSON.stringify({ mode: "weekly", interval: 2, weekday: 2, start: "2026-10-01" }))!; // tuesday
    expect(rule).toEqual({ mode: "weekly", interval: 2, weekday: 2, start: "2026-10-01" });
    expect(expandRule(rule, "2026-10-01", "2026-11-30")).toEqual(["2026-10-06", "2026-10-20", "2026-11-03", "2026-11-17"]);
    // window that starts long after the start date
    expect(expandRule(rule, "2027-03-01", "2027-03-31")).toEqual(["2027-03-09", "2027-03-23"]);
  });
  it("filters explicit date lists", () => {
    const rule = parseRule(JSON.stringify({ mode: "dates", dates: ["2026-10-05", "2026-09-01", "bad", "2026-10-05", "2026-12-24"] }))!;
    expect(rule).toEqual({ mode: "dates", dates: ["2026-09-01", "2026-10-05", "2026-12-24"] });
    expect(expandRule(rule, "2026-10-01", "2026-12-31")).toEqual(["2026-10-05", "2026-12-24"]);
    expect(parseRule(JSON.stringify({ mode: "weekly", interval: 1, weekday: 9, start: "2026-10-01" }))).toBeNull();
    expect(parseRule("{")).toBeNull();
  });
  it("computes easter and nationwide holidays", () => {
    expect(easter(2026)).toBe("2026-04-05");
    expect(easter(2027)).toBe("2027-03-28");
    const h = germanHolidays(2026);
    expect(h.has("2026-04-03")).toBe(true); // karfreitag
    expect(h.has("2026-04-06")).toBe(true); // ostermontag
    expect(h.has("2026-05-14")).toBe(true); // himmelfahrt
    expect(h.has("2026-05-25")).toBe(true); // pfingstmontag
    expect(h.has("2026-10-03")).toBe(true);
  });
  it("shifts pickups after a holiday in the same week", () => {
    expect(shiftForHolidays("2026-04-06")).toBe("2026-04-07"); // ostermontag → tuesday
    expect(shiftForHolidays("2026-04-08")).toBe("2026-04-09"); // wednesday of the same week also moves
    expect(shiftForHolidays("2026-04-13")).toBe("2026-04-13"); // next week untouched
    const rule = parseRule(JSON.stringify({ mode: "weekly", interval: 1, weekday: 1, start: "2026-03-30" }))!;
    expect(expandRule(rule, "2026-03-30", "2026-04-13", { shiftOnHolidays: true })).toEqual(["2026-03-30", "2026-04-07", "2026-04-13"]);
  });
  it("date helpers", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-05", "2026-10-07")).toBe(2);
    expect(mondayOf("2026-10-05")).toBe("2026-10-05");
    expect(mondayOf("2026-10-11")).toBe("2026-10-05");
  });
});

describe("jumomind mapping (real sample responses, 2026-10-05)", () => {
  const cities = [
    { name: "Abens", _name: "Abens", id: "44", region_code: "06", area_id: "44", img: "data/mymuell.jumomind.com/img/logos/44.png", has_streets: false },
    { name: "Darmstadt", _name: "Darmstadt", id: "9934", region_code: "05", area_id: "0", img: "data/mymuell.jumomind.com/img/logos/9934.png", has_streets: true },
    { name: "Altenbeken-Buke", _name: "Altenbeken-Buke", id: "70529", region_code: "07", area_id: "70529", img: "", has_streets: false },
  ];
  const streets = [
    { name: "Achatweg", _name: "Achatweg", id: "96032", area_id: "1", street_comment: "" },
    { name: "Adelungstraße 1-41, 2-38", _name: "Adelungstraße 1-41, 2-38", id: "96033", area_id: "2", street_comment: "" },
    { name: "Adelungstraße 40-Ende, 43-Ende", _name: "Adelungstraße 40-Ende, 43-Ende", id: "96034", area_id: "3", street_comment: "" },
  ];
  const trash = [
    { title: "Baum- und Strauchschnitt", name: "WITT_BAUM", _name: "WITT_BAUM", color: "1fe466" },
    { title: "Wertstofftonne", name: "WITT_GELB", _name: "WITT_GELB", color: "f3f880" },
    { title: "Papiertonne", name: "WITT_PAP", _name: "WITT_PAP", color: "0060ff" },
    { title: "Rest- und Biomüll", name: "WITT_REST", _name: "WITT_REST", color: "bbbbbb" },
  ];
  const dates = [
    { id: "167863221", title: "Wertstofftonne", trash_name: "WITT_GELB", day: "2026-10-07", description: "", color: "f3f880" },
    { id: "167863161", title: "Papiertonne", trash_name: "WITT_PAP", day: "2026-10-09", description: "", color: "0060ff" },
    { id: "167863194", title: "Rest- und Biomüll", trash_name: "WITT_REST", day: "2026-10-14", description: "", color: "bbbbbb" },
    { id: "x", title: "broken", trash_name: "WITT_X", day: "14.10.2026", description: "", color: "" },
  ];

  it("maps cities, streets, trash types and dates", () => {
    expect(mapCities(cities)).toEqual([
      { id: "44", name: "Abens", hasStreets: false, areaId: "44" },
      { id: "9934", name: "Darmstadt", hasStreets: true, areaId: null },
      { id: "70529", name: "Altenbeken-Buke", hasStreets: false, areaId: "70529" },
    ]);
    expect(mapStreets(streets)[1]).toEqual({ id: "96033", name: "Adelungstraße 1-41, 2-38", areaId: "2" });
    expect(mapTrash(trash)).toEqual([
      { key: "WITT_BAUM", title: "Baum- und Strauchschnitt", color: "#1fe466", type: "custom" },
      { key: "WITT_GELB", title: "Wertstofftonne", color: "#f3f880", type: "packaging" },
      { key: "WITT_PAP", title: "Papiertonne", color: "#0060ff", type: "paper" },
      { key: "WITT_REST", title: "Rest- und Biomüll", color: "#bbbbbb", type: "residual" },
    ]);
    expect(mapDates(dates)).toEqual([
      { date: "2026-10-07", key: "WITT_GELB", title: "Wertstofftonne", color: "#f3f880" },
      { date: "2026-10-09", key: "WITT_PAP", title: "Papiertonne", color: "#0060ff" },
      { date: "2026-10-14", key: "WITT_REST", title: "Rest- und Biomüll", color: "#bbbbbb" },
    ]);
    expect(mapDates({ error: "nope" })).toEqual([]);
  });

  it("searches cities fuzzily and umlaut-insensitively", () => {
    const list = mapCities(cities);
    expect(matchScore("darmstadt", "Darmstadt")).toBe(0);
    expect(matchScore("Darm", "Darmstadt")).toBe(1);
    expect(matchScore("buke", "Altenbeken-Buke")).toBe(2);
    expect(matchScore("xyz", "Darmstadt")).toBe(-1);
    expect(rankCities(list, "darm").map((c) => c.name)).toEqual(["Darmstadt"]);
    expect(rankCities(list, "Altenbeken").map((c) => c.name)).toEqual(["Altenbeken-Buke"]);
    expect(rankCities([{ id: "1", name: "Würzburg", hasStreets: false, areaId: "1" }], "wuerzburg")).toHaveLength(1);
    expect(rankCities([{ id: "1", name: "Würzburg", hasStreets: false, areaId: "1" }], "Wurzburg")).toHaveLength(1);
    expect(rankCities([{ id: "1", name: "Würzburg", hasStreets: false, areaId: "1" }], "würz")).toHaveLength(1);
  });

  it("ranks streets by name and house-number range", () => {
    expect(houseNumberMatches("Adelungstraße 1-41, 2-38", "17")).toBe(true);
    expect(houseNumberMatches("Adelungstraße 1-41, 2-38", "44")).toBe(false);
    expect(houseNumberMatches("Adelungstraße 40-Ende, 43-Ende", "120")).toBe(true);
    expect(houseNumberMatches("Achatweg", "3")).toBeNull();
    const list = mapStreets(streets);
    expect(rankStreets(list, "adelung", "44").map((s) => s.areaId)).toEqual(["3", "2"]);
    expect(rankStreets(list, "adelungstrasse", "5").map((s) => s.areaId)).toEqual(["2", "3"]);
    expect(rankStreets(list, "achat").map((s) => s.name)).toEqual(["Achatweg"]);
  });
});

describe("nominatim mapping", () => {
  it("picks city, road and house number", () => {
    expect(mapNominatim({ display_name: "Luisenplatz 5, Darmstadt", address: { house_number: "5", road: "Luisenplatz", city: "Darmstadt", postcode: "64283" } })).toEqual({ city: "Darmstadt", street: "Luisenplatz", houseNumber: "5", postcode: "64283", display: "Luisenplatz 5, Darmstadt" });
    expect(mapNominatim({ address: { village: "Abens", road: "Dorfstraße" } })?.city).toBe("Abens");
    expect(mapNominatim({ error: "Unable to geocode" })).toBeNull();
  });
});
