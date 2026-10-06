# waste – müllabfuhr

when the bins have to go out. a household can have several **sources**; every source owns **bins**, every bin has pickup **dates**.

| source | how dates come in | refresh |
| --- | --- | --- |
| `jumomind` (by address) | MyMüll / Jumomind app api, no key: city → street → `trash` + `dates` | weekly |
| `ics` | any ical export; own tolerant parser (folding, `VALUE=DATE`, utc stamps, simple `RRULE`) | daily |
| `manual` | per bin a rule: every n weeks on a weekday from a date, or explicit dates; optional holiday shift | – |

bin types (`residual, organic, paper, packaging, glass, bulky, hazardous, christmas, custom`) get a colour and a pixel icon (`src/bins.ts`); provider titles and ics summaries are mapped by keywords (`mapTrashName`), unknown ones become `custom` and keep the provider colour.

## api (`/api/m/waste`)

```
GET    /overview                    today, lookaheadDays, sources, bins, upcoming[]
GET    /upcoming?days=28
GET    /types                       bin types with translated name, colour, icon
GET    /sources                     POST /sources { kind, name?, config }   → 201 { source, bins } (502 when the first fetch failed)
PATCH  /sources/:id { name?, config? }     POST /sources/:id/refresh     DELETE /sources/:id
GET    /bins       POST /bins { source_id (manual), name, type, color, rule }   PATCH /bins/:id   DELETE /bins/:id
POST   /putout { binId, date, value }      "mark as put out" – stored until the date has passed
GET    /geo/reverse?lat=&lon=       nominatim reverse geocode (1 req/s, hub user-agent, hub language)
GET    /providers                   GET /providers/:id/cities?q=   GET /providers/:id/streets?cityId=&q=&house=
```

source configs: `{ provider: "jumomind", cityId, cityName, areaId, streetId?, streetName? }`, `{ url }`, `{ shiftOnHolidays }`.
manual rules: `{ mode: "weekly", interval, weekday (0 = sunday), start }` or `{ mode: "dates", dates: [] }`.

## adding a provider

`src/providers/index.ts` defines `ScheduleProvider`:

```ts
{
  id, name,
  searchCities(query, fetch)                         → [{ id, name, hasStreets, areaId }]
  searchStreets(cityId, query, fetch, houseNumber?)  → [{ id, name, areaId }]
  bins(location, fetch)                              → [{ key, title, color, type }]
  pickups(location, fetch)                           → [{ date: "YYYY-MM-DD", key, title, color }]
}
```

implement it in `src/providers/<id>.ts`, register it in `PROVIDERS`, and the setup flow, refresh and bin mapping work unchanged (`location.provider` is persisted in the source config). candidates: **abfallnavi / regioit** (`https://<region>-abfallapp.regioit.de/abfall-app-<region>/rest/...`), **abfall.io** (`https://api.abfall.io/?key=…&modus=…` – needs the municipality's key/modus pair), **awido**, **jumomind sister apps** (same api on other `<app>.jumomind.com` hosts).

## jumomind notes

- host is `mymuell.jumomind.com` (the `.de` name does not resolve).
- `?r=cities` → `[{ id, name, _name, region_code, area_id, has_streets, img }]` (~300 towns)
- `?r=streets&city_id=` → `[{ id, name, _name, area_id, street_comment }]` – street names carry house ranges ("Adelungstraße 1-41, 2-38"), `houseNumberMatches` ranks the right one first.
- `?r=trash&city_id=&area_id=` → `[{ title, name, _name, color }]`
- `?r=dates&city_id=&area_id=` → `[{ id, title, trash_name, day, description, color }]` – `day`, not `date`.
- `area_id` is the city's `area_id` without streets, else the **street's `area_id`** (not its `id`).

## develop

```bash
pnpm --filter @orbis/module-waste build      # dist/server.js, dist/client.js, dist/locales
pnpm --filter @orbis/module-waste typecheck
pnpm --filter @orbis/module-waste test       # ics parser, keyword mapping, recurrence, jumomind mapping
```
