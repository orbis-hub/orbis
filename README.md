# ◎ orbis

your life, one dashboard. a self-hosted, modular life manager: todos, weather, calendar, smart home – each one a module you install at runtime, arranged as widgets on dashboards you design yourself. web, android/ios (capacitor) and, later, e-ink displays all talk to one hub.

```
┌──────────── clients ────────────┐      ┌──────────── hub (node, docker) ───────────────┐
│ web (next.js static export)     │ REST │ hono + sqlite                                 │
│ mobile (capacitor, same build)  │  +   │ auth · settings · dashboards · module runtime │
│ e-ink (esp32 fetches a png)     │  WS  │ device registry + network scanner · registry  │
└─────────────────────────────────┘      └───────────────────────────────────────────────┘
```

## quick start (development)

```bash
pnpm install
pnpm modules:build          # bundles the first-party modules in modules/*
pnpm hub                    # hub on http://localhost:3001 (api + websocket)
pnpm web                    # next dev on http://localhost:3000
```

open http://localhost:3000, create the owner account, add widgets.

## production (docker)

```bash
docker compose up -d        # web + api on http://<host>:3001, data in ./data
```

`network_mode: host` is used so the hub can discover devices on your lan. put caddy/nginx in front for https and set `ORBIS_CORS_ORIGINS` if the app is served from another origin. see `.env.example`.

## repo layout

| path                     | what                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `apps/hub`               | the server: hono, drizzle + better-sqlite3, module runtime, device registry, installer |
| `apps/web`               | next.js 16 app router, `output: "export"`, tailwind v4, react-grid-layout              |
| `apps/mobile`            | capacitor project wrapping `apps/web/out`                                              |
| `packages/sdk`           | `@orbis/sdk` – manifest schema, server context, client hooks (the module contract)     |
| `packages/ui`            | `@orbis/ui` – design system (window boxes, buttons, pixel icons)                       |
| `packages/module-tools`  | `orbis-module build | watch | pack | init` – esbuild based module bundler              |
| `modules/*`              | first-party modules: clock, todo, weather (built like external ones)                   |
| `registry/`              | example `index.json` for a module registry                                             |

## accounts

the first account created at setup is the **owner**. admins (promoted by the owner) manage users, modules, devices and hub settings. members get their own dashboards plus everything shared with them. dashboards are either shared with everyone or private with explicit grants (accounts page, dashboard menu → sharing & access). passwords are changed under accounts; admins can reset them.

## modules

a module is a folder (or a `module.tgz` on a github release) with:

```
module.json          manifest: id, version, widgets, pages, settingsSchema, permissions, discovery
dist/server.js       runs inside the hub: `defineModule({ setup(ctx) { ... } })`
dist/client.js       runs in the browser: `defineClient({ widgets, pages, settings })`
```

**server context** (`@orbis/sdk/server`): `ctx.http` (hono router at `/api/m/<id>`), `ctx.storage` (kv + own sqlite tables via `{{t:name}}`), `ctx.scheduler`, `ctx.events.publish()`, `ctx.devices` (claim discovered devices), `ctx.settings`, `ctx.fetch`, `ctx.logger`.

**client** (`@orbis/sdk/client`): `useModuleApi()`, `useModuleQuery()`, `useModuleEvents()`, `useModuleSettings()`, `useModuleDevices()`. react, react-dom, `@orbis/sdk/client` and `@orbis/ui` are provided by the host at runtime (`window.__ORBIS__`), so bundles stay tiny and share one react.

### create a module

```bash
mkdir my-module && cd my-module
npx orbis-module init . --id=my-module --name="My Module"   # or copy modules/core-clock
# write src/server.ts and src/client.tsx
npx orbis-module watch --dev=../orbis/apps/hub/data           # hot-reloads into a running hub
npx orbis-module pack                                        # → module.tgz for a release
```

modules live in the hub's `data/modules/` (installed), `data/modules-dev/` (watched, hot reload) or `modules/` in this repo (built-in).

### registry

a registry is just a json file:

```json
{ "name": "orbis official", "modules": [
  { "id": "weather", "name": "Weather", "description": "…", "repo": "github:orbis-os/module-weather", "latest": "0.1.0", "tags": ["weather"] }
] }
```

the hub derives `https://github.com/<repo>/releases/download/v<latest>/module.tgz`; set `tarball` to override. add registries under settings.

## scripts

| command                | does                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `pnpm dev`             | hub + web in parallel (turbo)                               |
| `pnpm build`           | everything                                                  |
| `pnpm typecheck`       | all packages                                                |
| `pnpm test`            | vitest (sdk, hub)                                           |
| `pnpm modules:build`   | bundle `modules/*`                                          |
| `pnpm mobile:sync`     | build web → `cap sync`                                      |
| `pnpm mobile:android`  | open android studio (`pnpm --filter @orbis/mobile add:android` once) |

## roadmap

- [x] hub: auth, dashboards, settings, websocket, module runtime, installer, registry client
- [x] web: shell, dashboard grid, module loader, store, devices, settings
- [x] modules: clock, todo, weather
- [x] device registry + network scanner (ping sweep, arp, mdns)
- [x] accounts: owner/admin/member roles, user management, private/shared dashboards with grants
- [ ] home assistant module, shelly/hue modules using discovery matchers
- [ ] capacitor builds (android apk first), push notifications
- [ ] e-ink renderer (`/api/eink/<display>.png`)
- [ ] worker isolation for third-party modules
