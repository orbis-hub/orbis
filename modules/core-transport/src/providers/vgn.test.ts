import { describe, expect, it } from "vitest";
import { parseStopId, providerForTrip } from "./index";
import { createVgnProvider, mapVgnDeparture, mapVgnStop, mapVgnTrip, parseVgnTripId, rankStops, vgnProducts, vgnTripId } from "./vgn";

/* captured from https://start.vag.de/dm/api/v1 on 2026-10-06 (Puls-API-v1.3.0), trimmed */

const STOPS = {
  Metadata: { Version: "Puls-API-v1.3.0", Timestamp: "2026-10-06T08:07:31+02:00" },
  Haltestellen: [
    { Haltestellenname: "Hummelsteiner Weg (Nürnberg)", VAGKennung: "HUL,HUMMEL", VGNKennung: 535, Longitude: 11.085444, Latitude: 49.440907, Produkte: "Tram" },
    { Haltestellenname: "Nürnberg-Stein (Nürnberg)", VAGKennung: "STEIBF", VGNKennung: 1910, Longitude: 11.018169, Latitude: 49.425554 },
    { Haltestellenname: "Nürnberg-Steinbühl (Nürnberg)", VAGKennung: "STBU", VGNKennung: 620, Longitude: 11.068197, Latitude: 49.442841, Produkte: "Bus,Tram" },
    { Haltestellenname: "Stein Schloss (Nürnberg)", VAGKennung: "SCHLOS", VGNKennung: 1990, Longitude: 11.021816, Latitude: 49.418274, Produkte: "Bus" },
    { Haltestellenname: "Ziegelstein (Nürnberg)", VAGKennung: "ZI", VGNKennung: 1320, Longitude: 11.105126, Latitude: 49.485035, Produkte: "UBahn" },
    { Haltestellenname: "Kirche (Stein (b Nürnberg))", VAGKennung: "S-KIRC", VGNKennung: 5755, Longitude: 11.0, Latitude: 49.4, Produkte: "Bus" },
  ],
};

const DEPARTURES = {
  Metadata: { Version: "Puls-API-v1.3.0", Timestamp: "2026-10-06T08:07:47+02:00" },
  Haltestellenname: "Stein Schloss (Nürnberg)",
  VAGKennung: "SCHLOS",
  VGNKennung: 1990,
  Abfahrten: [
    { Linienname: "67", Haltepunkt: "SCHLOS:2", Richtung: "Richtung2", Richtungstext: "Frankenstraße", AbfahrtszeitSoll: "2026-10-06T08:10:00+02:00", AbfahrtszeitIst: "2026-10-06T08:10:56+02:00", Produkt: "Bus", Longitude: 11.02167333, Latitude: 49.41814417, Fahrtnummer: 2090983, Betriebstag: "2026-10-06", Fahrtartnummer: 1, Fahrzeugnummer: "433", Besetztgrad: "Unbekannt", Prognose: true, HaltesteigText: "2" },
    { Linienname: "67", Haltepunkt: "SCHLOS:1", Richtung: "Richtung1", Richtungstext: "Fü-Hauptbahnhof", AbfahrtszeitSoll: "2026-10-06T08:08:00+02:00", AbfahrtszeitIst: "2026-10-06T08:11:35+02:00", Produkt: "Bus", Longitude: 11.02148333, Latitude: 49.41836556, Fahrtnummer: 2056792, Betriebstag: "2026-10-06", Fahrtartnummer: 1, Fahrzeugnummer: "222", Besetztgrad: "Unbekannt", Prognose: true, HaltesteigText: "1" },
    { Linienname: "63", Haltepunkt: "SCHLOS:2", Richtung: "Richtung2", Richtungstext: "Röthenbach", AbfahrtszeitSoll: "2026-10-06T08:12:00+02:00", AbfahrtszeitIst: "2026-10-06T08:12:00+02:00", Produkt: "Bus", Longitude: 11.02167333, Latitude: 49.41814417, Fahrtnummer: 86023054, Betriebstag: "2026-10-06", Fahrtartnummer: 1, Besetztgrad: "Unbekannt", Prognose: false, HaltesteigText: "2" },
  ],
};

const TRIP = {
  Metadata: { Version: "Puls-API-v1.3.0", Timestamp: "2026-10-06T08:08:42+02:00" },
  Linienname: "67",
  Richtung: "Richtung2",
  Richtungstext: "Frankenstraße",
  Fahrtnummer: 2090983,
  Betriebstag: "2026-10-06",
  Produkt: "Bus",
  Fahrzeugnummer: "433",
  Besetztgrad: "Unbekannt",
  Prognose: true,
  Fahrtverlauf: [
    { Haltestellenname: "Hauptbahnhof (Fürth (Bayern))", VAGKennung: "F-HB", VGNKennung: 2110, Haltepunkt: "F-HB:6", AbfahrtszeitSoll: "2026-10-06T07:42:00+02:00", AbfahrtszeitIst: "2026-10-06T07:42:00+02:00", Richtungstext: "Frankenstraße", Longitude: 10.989775, Latitude: 49.47058111 },
    { Haltestellenname: "Maxstr. (Fürth (Bayern))", VAGKennung: "MAXSTR", VGNKennung: 2155, Haltepunkt: "MAXSTR:3", AnkunftszeitSoll: "2026-10-06T07:43:00+02:00", AnkunftszeitIst: "2026-10-06T07:44:15+02:00", AbfahrtszeitSoll: "2026-10-06T07:43:00+02:00", AbfahrtszeitIst: "2026-10-06T07:45:15+02:00", Richtungstext: "Frankenstraße", Longitude: 10.98763944, Latitude: 49.47167222 },
    { Haltestellenname: "Amalienstr. (Fürth (Bayern))", VAGKennung: "AMALIE", VGNKennung: 2250, Haltepunkt: "AMALIE:2", AnkunftszeitSoll: "2026-10-06T07:45:00+02:00", AnkunftszeitIst: "2026-10-06T07:46:32+02:00", AbfahrtszeitSoll: "2026-10-06T07:45:00+02:00", AbfahrtszeitIst: "2026-10-06T07:46:32+02:00", Richtungstext: "Frankenstraße", Longitude: 10.98618972, Latitude: 49.46807111 },
  ],
};

describe("vgn stops", () => {
  it("maps VGNKennung, coordinates and the comma separated products", () => {
    const stops = STOPS.Haltestellen.map(mapVgnStop);
    expect(stops[3]).toEqual({ id: "vgn:1990", name: "Stein Schloss (Nürnberg)", lat: 49.418274, lon: 11.021816, products: ["bus"] });
    expect(stops[2]!.products).toEqual(["bus", "tram"]);
    expect(stops[4]!.products).toEqual(["subway"]);
    // no `Produkte` on the station stop
    expect(stops[1]!.products).toEqual([]);
  });

  it("normalises product names", () => {
    expect(vgnProducts("Bus,Tram,UBahn,SBahn,RBahn")).toEqual(["bus", "tram", "subway", "suburban", "regional"]);
    expect(vgnProducts(undefined)).toEqual([]);
    expect(vgnProducts(" Bus , Bus ")).toEqual(["bus"]);
  });

  it("ranks whole-word matches before longer-word prefixes before substring hits", () => {
    const ranked = rankStops(STOPS.Haltestellen.map(mapVgnStop).map((s) => s!), "Stein");
    expect(ranked.map((s) => s.name)).toEqual([
      "Stein Schloss (Nürnberg)",
      "Nürnberg-Stein (Nürnberg)",
      "Kirche (Stein (b Nürnberg))",
      "Nürnberg-Steinbühl (Nürnberg)",
      "Hummelsteiner Weg (Nürnberg)",
      "Ziegelstein (Nürnberg)",
    ]);
  });
});

describe("vgn departures", () => {
  it("maps line, direction, planned / actual time, delay, product, platform", () => {
    const d = mapVgnDeparture(DEPARTURES.Abfahrten[1]!)!;
    expect(d).toEqual({
      tripId: "vgn:Bus:2056792:2026-10-06",
      line: "67",
      product: "bus",
      direction: "Fü-Hauptbahnhof",
      when: "2026-10-06T08:11:35+02:00",
      plannedWhen: "2026-10-06T08:08:00+02:00",
      delayMin: 4,
      platform: "1",
      cancelled: false,
      color: expect.stringMatching(/^hsl\(/),
    });
    expect(mapVgnDeparture(DEPARTURES.Abfahrten[0]!)!.delayMin).toBe(1);
  });

  it("has no realtime when Prognose is false", () => {
    const d = mapVgnDeparture(DEPARTURES.Abfahrten[2]!)!;
    expect(d.when).toBeNull();
    expect(d.delayMin).toBeNull();
    expect(d.plannedWhen).toBe("2026-10-06T08:12:00+02:00");
  });

  it("drops rows without a time and honours an explicit cancel flag", () => {
    expect(mapVgnDeparture({ Linienname: "4" })).toBeNull();
    expect(mapVgnDeparture({ ...DEPARTURES.Abfahrten[0]!, Ausfall: true })!.cancelled).toBe(true);
  });

  it("gives the underground lines their official colours", () => {
    expect(mapVgnDeparture({ ...DEPARTURES.Abfahrten[0]!, Linienname: "U1", Produkt: "UBahn" })).toMatchObject({ product: "subway", color: "#005ca9" });
  });

  it("sorts the board by actual time", async () => {
    const p = createVgnProvider(async <T,>() => DEPARTURES as unknown as T);
    const list = await p.departures("1990", 60, 1000);
    expect(list.map((d) => d.line)).toEqual(["67", "67", "63"]);
    expect(list[0]!.when).toBe("2026-10-06T08:10:56+02:00");
  });
});

describe("vgn trips", () => {
  it("round-trips the trip id", () => {
    expect(vgnTripId(DEPARTURES.Abfahrten[0]!)).toBe("vgn:Bus:2090983:2026-10-06");
    expect(parseVgnTripId("vgn:Bus:2090983:2026-10-06")).toEqual({ product: "Bus", tripNumber: "2090983", day: "2026-10-06" });
    expect(parseVgnTripId("vgn:Tram:3006444:")).toEqual({ product: "Tram", tripNumber: "3006444", day: null });
    expect(parseVgnTripId("1|12345|0|80|6102026")).toBeNull();
  });

  it("builds the route polyline from the ordered stops", () => {
    const r = mapVgnTrip(TRIP, { id: "x" })!;
    expect(r.id).toBe("vgn:Bus:2090983:2026-10-06");
    expect(r.line).toBe("67");
    expect(r.product).toBe("bus");
    expect(r.direction).toBe("Frankenstraße");
    expect(r.stopovers).toHaveLength(3);
    expect(r.stopovers[0]).toEqual({ id: "vgn:2110", name: "Hauptbahnhof (Fürth (Bayern))", lat: 49.47058111, lon: 10.989775, arrival: null, departure: "2026-10-06T07:42:00+02:00", cancelled: false });
    expect(r.stopovers[1]!.arrival).toBe("2026-10-06T07:44:15+02:00");
    expect(r.polyline).toEqual([
      [49.47058111, 10.989775],
      [49.47167222, 10.98763944],
      [49.46807111, 10.98618972],
    ]);
  });

  it("requests fahrten.json/<Produkt>/<Fahrtnummer>?betriebstag=", async () => {
    const urls: string[] = [];
    const p = createVgnProvider(async <T,>(url: string) => {
      urls.push(url);
      return TRIP as unknown as T;
    });
    const r = await p.trip("vgn:Bus:2090983:2026-10-06", { line: "67" });
    expect(urls).toEqual(["https://start.vag.de/dm/api/v1/fahrten.json/Bus/2090983?betriebstag=2026-10-06"]);
    expect(r!.stopovers).toHaveLength(3);
    expect(await p.trip("not-a-vgn-id", {})).toBeNull();
  });
});

describe("stop id routing", () => {
  it("keeps bare ids on the configured hafas profile and prefixed ones on their family", () => {
    expect(parseStopId("8000260", "db")).toEqual({ providerId: "db", localId: "8000260" });
    expect(parseStopId("8000260", "vbb")).toEqual({ providerId: "vbb", localId: "8000260" });
    expect(parseStopId("hafas:8000260", "vgn")).toEqual({ providerId: "db", localId: "8000260" });
    expect(parseStopId("vgn:1990", "db")).toEqual({ providerId: "vgn", localId: "1990" });
    expect(parseStopId("vbb:900000100003", "vgn")).toEqual({ providerId: "vbb", localId: "900000100003" });
    expect(parseStopId("A=1@O=X@L=1", "db")).toEqual({ providerId: "db", localId: "A=1@O=X@L=1" });
    expect(parseStopId("", "db")).toBeNull();
    expect(parseStopId("vgn:", "db")).toBeNull();
  });

  it("routes trip ids by prefix", () => {
    expect(providerForTrip("vgn:Bus:1:2026-10-06", "db")).toBe("vgn");
    expect(providerForTrip("1|12345|0|80|6102026", "vgn")).toBe("db");
    expect(providerForTrip("1|12345|0|80|6102026", "oebb")).toBe("oebb");
  });
});
