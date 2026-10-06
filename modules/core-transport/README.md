# transport – abfahrten

next departures for one stop, with delays, a stop picker (name search or "near me", place line via nominatim) and an optional map that draws a clicked departure's route. one widget, one page, an e-ink renderer.

## supported providers

| setting | family | upstream | coverage |
| --- | --- | --- | --- |
| `db` (default) | hafas | `https://v6.db.transport.rest` | germany-wide, all local transport the db timetable knows |
| `vbb` | hafas | `https://v6.vbb.transport.rest` | berlin / brandenburg |
| `bvg` | hafas | `https://v6.bvg.transport.rest` | berlin |
| `oebb` | hafas | `https://v6.oebb.transport.rest` | austria |
| `vgn` | vgn | `https://start.vag.de/dm/api/v1` (VAG Abfahrtsmonitor api) | verkehrsverbund großraum nürnberg: nürnberg, fürth, erlangen, stein, zirndorf … bus, tram, u-bahn, s-bahn |

all of them are public, need no key, and get the hub's user-agent. the hub caches every board for ~`refreshSeconds`, stop searches for 10 minutes, trips for 5 minutes, and backs off a backend for 60 s after a timeout / 5xx / 429 (one back-off per upstream host, so a dead transport.rest does not block vgn and vice versa). unknown stops / trips (4xx) are remembered per url for 60 s.

the provider under module settings is the one the **stop search** uses. a stop remembers its provider in its id, so a dashboard can mix providers:

```
vgn:1990            vgn, VGNKennung 1990 (stein schloss)
hafas:8000260       hafas, resolved with the configured hafas profile (db when the setting is vgn)
vbb:900000100003    hafas, profile named explicitly
8000260             bare id from an old config = hafas:8000260
```

trip ids are opaque per family: `vgn:<Produkt>:<Fahrtnummer>:<Betriebstag>` for vgn, the raw hafas trip id otherwise.

## api (`/api/m/transport`)

```
GET /providers                      [{ id, name, family, country, active }]
GET /stops?q=Stein                  stops from the configured provider, first 8 with `place` (nominatim, ≤ 3 s wait)
GET /stops?near=49.418,11.021       stops around a point, nearest first (`q` + `near` = name search sorted by distance)
GET /place?lat=&lon=                { place } or 202 { pending } while nominatim is still queued
GET /departures/:stopId?duration=60 { stopId, provider, departures: [{ tripId, line, product, direction, when, plannedWhen, delayMin, platform, cancelled, color }], fetchedAt }
GET /trip?id=&line=                 { id, line, product, direction, color, polyline: [[lat, lon]], stopovers: [{ id, name, lat, lon, arrival, departure, cancelled }] }
```

errors are `502 { error, retryAt? }`; `error` is `"transport api unavailable"` (hafas) or `"vgn api unavailable"` (vgn), which the client translates, or a `… api HTTP <status>` string.

## adding a provider

`src/providers/types.ts` defines `TransportProvider`:

```ts
{
  id, family, name, country,
  searchStops(query, near)                 → Stop[]        ids prefixed with the family ("vgn:1990")
  departures(localId, durationMin, ttlMs)  → Departure[]   localId = id without the prefix
  trip(tripId, { line })                   → TripRoute | null
}
```

a provider gets one `JsonGet` — `get(url, ttlMs, timeoutMs)` — that is already bound to its backend (cache, in-flight dedupe, back-off live in `server.ts`). keep the mappers pure (`mapXyzStop`, `mapXyzDeparture`, `mapXyzTrip`) so they can be unit-tested with captured json, see `src/providers/vgn.ts` / `vgn.test.ts`.

then:

1. `src/providers/<id>.ts` with `create<Id>Provider(get)` and the pure mappers
2. `src/providers/index.ts`: add it to `PROVIDER_INFOS`, `backendFor()` (host key + the two error strings), `createProvider()`, and teach `parseStopId` / `providerForTrip` the new id prefix
3. `module.json` → `settingsSchema.provider.enum` / `enumNames`; `locales/*.json` → `provider.<id>` and, if it has its own error string, `error.<id>Unavailable` plus the mapping in `client.tsx` (`ERROR_KEYS`)
4. products should come out as the hafas names (`bus, tram, subway, suburban, regional, national, nationalExpress, ferry, taxi`) so the widget's product filter and the translations keep working

## vgn notes (VAG Abfahrtsmonitor api, checked 2026-10-06, Puls-API-v1.3.0)

- `haltestellen.json/vgn?name=Stein` → `{ Haltestellen: [{ Haltestellenname, VAGKennung, VGNKennung, Longitude, Latitude, Produkte }] }` — substring match, 31 hits for "Stein"; `Produkte` is a comma separated string (`"Bus,Tram"`, `"UBahn"`) and missing on some stops. the module ranks prefix / word-start matches first.
- `haltestellen.json/vgn/location?lon=&lat=&radius=` → same shape, nearest first ("near me").
- `abfahrten.json/vgn/<VGNKennung>?timespan=60&limitcount=40` → `{ Abfahrten: [{ Linienname, Richtungstext, AbfahrtszeitSoll, AbfahrtszeitIst, Produkt, Fahrtnummer, Betriebstag, Prognose, HaltesteigText, Haltepunkt, Fahrzeugnummer, Besetztgrad }] }`. `Prognose: false` means no realtime (then `when` is null and the planned time counts). delay = `Ist − Soll`. platform = `HaltesteigText`. there is **no cancellation flag** in the api, `cancelled` stays false. unknown stop → 404 `{ Message }`.
- trips: the documented `fahrten.json/vgn/<Fahrtnummer>/<Betriebstag>` answers 404 — the first path segment is the **product**, not the network: `fahrten.json/<Produkt>/<Fahrtnummer>?betriebstag=YYYY-MM-DD` → `{ Linienname, Richtungstext, Produkt, Fahrtverlauf: [{ Haltestellenname, VGNKennung, Longitude, Latitude, AnkunftszeitSoll/Ist?, AbfahrtszeitSoll/Ist? }] }`. no polyline: the map route is the stop coordinates in order.
- products: `Bus → bus`, `Tram → tram`, `UBahn → subway`, `SBahn → suburban`, `RBahn → regional`. U1/U2/U3 get their official colours, everything else the stable hash colour.
- "Stein" the town is `Stein (b Nürnberg)` in stop names (`Kirche (Stein (b Nürnberg))`, `Rosenstr. (Stein (b Nürnberg))`); `Stein Schloss (Nürnberg)` and `Nürnberg-Stein (Nürnberg)` (the s-bahn station) are listed under nürnberg.

## develop

```bash
pnpm --filter @orbis/module-transport build      # dist/server.js, dist/client.js, dist/locales
pnpm --filter @orbis/module-transport typecheck
pnpm --filter @orbis/module-transport test       # vgn mappers + stop / trip id routing, with captured api samples
pnpm i18n:check                                  # en.json vs de.json
```
