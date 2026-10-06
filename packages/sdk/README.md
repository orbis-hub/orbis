# @orbis/sdk

Types, manifest schema, server context and client hooks for Orbis modules.

| entry point            | what it is for                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| `@orbis/sdk`           | shared types (`Device`, `Dashboard`, `Notification`, …) and the manifest schema |
| `@orbis/sdk/server`    | `defineModule`, `ModuleServerContext`, e-ink layout types, request validation   |
| `@orbis/sdk/client`    | `defineClient`, `useModule`, `useModuleApi`, `useModuleQuery`, `useT`, …        |
| `@orbis/sdk/manifest`  | `ModuleManifest` zod schema + `parseManifest`                                   |

## Request validation (`@orbis/sdk/server`)

Every module route that takes input should validate it. The sdk ships a small zod based helper so all
modules answer the same way: `400 { error: "invalid json" }` for a body that is not json,
`400 { error: "invalid input", issues: [{ path, message }] }` for a body that does not match the schema.
The web app shows `error` to the user, `issues` is for the developer / the API consumer.

```ts
import { defineModule, parseBody, parseQuery, notFound, nonEmptyString, idParam, dateKey, z } from "@orbis/sdk/server";

export default defineModule({
  setup({ http, storage }) {
    http.post("/tasks", async (c) => {
      const b = await parseBody(c, z.object({ title: nonEmptyString(200), listId: idParam.optional(), due: dateKey.nullable().optional() }));
      if (!b.ok) return b.res;              // 400 already built
      // b.data is typed and trimmed
      …
    });
    http.get("/habits", (c) => {
      const q = parseQuery(c, z.object({ days: z.coerce.number().int().min(1).max(400).default(400) }));
      if (!q.ok) return q.res;
      …
    });
    http.patch("/tasks/:id", async (c) => {
      if (!task(c.req.param("id"))) return notFound(c);   // 404 { error: "not found" }
      …
    });
  },
});
```

| export                    | meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `parseBody(c, schema)`    | json body → `{ ok: true, data }` or `{ ok: false, res }` (a ready 400 response)          |
| `parseQuery(c, schema)`   | same for `c.req.query()` (strings; use `z.coerce.number()` for numbers)                  |
| `parseValue(c, schema, v)`| same for any value you already have                                                       |
| `invalid(c, issues)`      | build the 400 yourself for checks zod cannot express ("day must not be in the future")    |
| `notFound(c, what?)`      | `404 { error: "not found" }`                                                             |
| `idParam`                 | ids modules generate: `[A-Za-z0-9_-]{1,64}`                                              |
| `isoDate`                 | full ISO-8601 timestamp with zone                                                         |
| `dateKey`                 | calendar day `YYYY-MM-DD` (real dates only)                                               |
| `nonEmptyString(max)`     | trimmed, 1..max characters – use 200 for names and titles, 10 000 for bodies             |
| `hexColor`                | `#rgb` / `#rrggbb`                                                                       |
| `intRange(min, max)`      | integer in range; rejects `"7"` strings and `7.5` so nothing like `7.0` lands in sqlite   |
| `z`                       | zod itself, re-exported so modules do not need their own dependency                      |
| `HttpContext`             | the hono context type, for helpers shared between routes                                  |

Conventions the core modules follow: unknown ids on PATCH / DELETE answer 404, bodies are trimmed,
and a value that is a day (habits, due dates) is stored as a `YYYY-MM-DD` key, never as a timestamp.
