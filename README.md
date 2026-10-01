<p align="center"><img src="brand/wordmark-auto.svg" alt="orbis" width="420"></p>

<p align="center"><b>your life, one dashboard.</b></p>

<p align="center">
  <a href="https://github.com/orbis-hub/orbis/wiki/Getting-Started">getting started</a> ·
  <a href="https://github.com/orbis-hub/orbis/wiki/Install">install</a> ·
  <a href="https://github.com/orbis-hub/orbis/wiki/Module-Developer-Guide">build a module</a> ·
  <a href="https://github.com/orbis-hub/orbis/wiki">wiki</a> ·
  <a href="https://github.com/orbis-hub/registry">registry</a> ·
  <a href="https://github.com/orbis-hub/orbis/issues?q=is%3Aissue+is%3Aopen+label%3A%22module+idea%22">module ideas</a>
</p>

---

orbis is a self-hosted, modular life manager. one **hub** you run yourself (a pi is plenty), **dashboards** you lay out with drag and drop, and **modules** for everything on them: todos, calendar, weather, music, smart home, whatever someone writes next. web, android/ios and (soon) e-ink displays all talk to the same hub. no cloud, no account with us, your data stays in one sqlite file at home.

## install

```bash
curl -fsSL https://raw.githubusercontent.com/orbis-hub/orbis/main/install.sh | sh      # linux · macos · raspberry pi
irm https://raw.githubusercontent.com/orbis-hub/orbis/main/install.ps1 | iex           # windows
```

the installer asks whether this machine runs **hub + web** (one container, the usual case), **hub only** or **web only**. docker required. open `http://<host>:3001`, create the owner account, add widgets. more ways to run it, env vars, https and backups: [install](https://github.com/orbis-hub/orbis/wiki/Install).

## what's in the box

| module | widgets | page |
| --- | --- | --- |
| **clock** | digital clock | |
| **todo** | list, due today | lists & tasks with due dates |
| **weather** | current, forecast | hours and 7 days, open-meteo, no api key |
| **calendar** | agenda, month, next up | ics feeds + caldav (google, icloud, nextcloud, fastmail …) |
| **media** | now playing, playback devices | spotify: search, playlists, queue, pick the device it plays on |
| **home assistant** | switch/light, sensor + sparkline, climate, scenes, entity list | all your ha entities, live over its websocket |
| **notes** | note, scratchpad | markdown-ish notes with checkboxes, autosave |
| **countdown** | countdown | days / weeks / hours to a date, yearly for birthdays |
| **hub status** | overview, single gauge | cpu, memory, disk, uptime, 30 min history |
| **habits** | today, habit grid | streaks, contribution-style grid, evening nudge |
| **bookmarks** | links | a start page with groups, favicons via the hub |
| **focus timer** | timer | pomodoro on the hub, shared across devices |
| **birthdays** | upcoming | people and dates, reminders a week before and on the day |
| **feeds** | headlines | rss / atom, mark read, favicons |
| **shopping list** | list | quick add with quantities and aisles, suggestions from past buys, store mode |
| **shelly** | switch, power overview | gen1 + gen2 shellys on the lan, mdns discovery, watts |

plus: several dashboards, multi-user with owner/admin/member roles and private or shared dashboards, a lan device scanner that smart home modules build on, a module store fed by a registry, light/dark. everything else is a module away: see the [module ideas](https://github.com/orbis-hub/orbis/issues?q=is%3Aissue+is%3Aopen+label%3A%22module+idea%22) or write your own.

## modules

a module is a folder with a `module.json`, a `dist/server.js` that runs inside the hub and a `dist/client.js` that renders widgets and pages in the app. install from the store at runtime, no hub rebuild. react and the design system come from the host, so module bundles are tiny and look native.

```bash
# use the template → github.com/orbis-hub/module-template
pnpm dev --dev=<hub data dir>   # hot-reloads into a running hub
pnpm pack:module                # module.tgz for a release
```

[module developer guide](https://github.com/orbis-hub/orbis/wiki/Module-Developer-Guide) · [sdk reference](https://github.com/orbis-hub/orbis/wiki/SDK-Reference) · [publishing](https://github.com/orbis-hub/orbis/wiki/Publishing-and-Registry)

## repo

```
apps/hub            the server: hono + sqlite, auth, dashboards, module runtime, installer, device registry
apps/web            next.js 16 static export, the dashboard ui
apps/mobile         capacitor wrapper around the web build
packages/sdk        @orbis/sdk – the module contract (manifest schema, server context, client hooks)
packages/ui         @orbis/ui – design system + pixel icons
packages/module-tools   orbis-module build | watch | pack
modules/*           first-party modules, built like third-party ones
brand/              logo + wordmark generator
```

```bash
pnpm install && pnpm modules:build
pnpm hub     # http://localhost:3001
pnpm web     # http://localhost:3000
```

[development setup](https://github.com/orbis-hub/orbis/wiki/Development-Setup) · [architecture](https://github.com/orbis-hub/orbis/wiki/Architecture) · [hub api](https://github.com/orbis-hub/orbis/wiki/Hub-API) · [contributing](https://github.com/orbis-hub/orbis/wiki/Contributing)

## roadmap

- [x] hub, web, sdk, module store, device scanner, accounts, installer
- [x] clock · todo · weather · calendar · media · home assistant
- [x] notifications (bell, ntfy, telegram), backup & restore, kiosk mode, dashboard accents
- [x] e-ink: hub renderer, firmware for inkplate / lilygo / waveshare, web flasher
- [x] shelly direct via the device registry
- [ ] hue direct, more media providers
- [ ] android apk, ios
- [ ] worker isolation for third-party modules, npm packages for the sdk

mit licensed. made in würzburg by [vensin](https://vensin.dev).
