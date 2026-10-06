import { defineModule, notFound, parseBody, z, type EinkRequest, type EinkTree } from "@orbis/sdk/server";

export type Note = { id: string; title: string; body: string; pinned: number; updated_at: string; created_at: string };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();
const MAX_TITLE = 200;
const MAX_BODY = 10_000;
const titleInput = z.string().trim().max(MAX_TITLE);
const bodyInput = z.string().max(MAX_BODY);

export default defineModule({
  setup(ctx) {
    const { storage: db, http, events } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:notes}} (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
    const all = () => db.sql<Note>(`SELECT * FROM {{t:notes}} ORDER BY pinned DESC, updated_at DESC`);
    const one = (id: string) => db.sql<Note>(`SELECT * FROM {{t:notes}} WHERE id = ?`, [id])[0] ?? null;
    const changed = () => events.publish("changed");

    http.get("/notes", (c) => c.json(all().map((n) => ({ ...n, body: n.body.slice(0, 200), length: n.body.length }))));
    http.get("/notes/pinned", (c) => c.json(all().find((n) => n.pinned) ?? all()[0] ?? null));
    /** exact (case-sensitive) title; the scratch widget creates its note via POST when this is a 404 */
    http.get("/notes/by-title/:title", (c) => {
      const n = db.sql<Note>(`SELECT * FROM {{t:notes}} WHERE title = ? ORDER BY created_at LIMIT 1`, [c.req.param("title")])[0];
      return n ? c.json(n) : notFound(c);
    });
    http.get("/notes/:id", (c) => {
      const n = one(c.req.param("id"));
      return n ? c.json(n) : notFound(c);
    });
    http.post("/notes", async (c) => {
      const b = await parseBody(
        c,
        z.object({
          title: titleInput.optional(),
          // "" is an empty note (the page and the scratchpad start like that); only-whitespace is a mistake
          body: bodyInput.refine((s) => s === "" || s.trim().length > 0, "body must not be whitespace only").optional(),
        }),
      );
      if (!b.ok) return b.res;
      const id = uid();
      db.run(`INSERT INTO {{t:notes}} (id, title, body, pinned, updated_at, created_at) VALUES (?, ?, ?, 0, ?, ?)`, [id, b.data.title || ctx.i18n.t("untitled"), b.data.body ?? "", now(), now()]);
      changed();
      return c.json(one(id), 201);
    });
    http.patch("/notes/:id", async (c) => {
      const id = c.req.param("id");
      if (!one(id)) return notFound(c);
      const b = await parseBody(c, z.object({ title: titleInput.optional(), body: bodyInput.optional(), pinned: z.boolean().optional() }));
      if (!b.ok) return b.res;
      const d = b.data;
      if (d.title !== undefined) db.run(`UPDATE {{t:notes}} SET title = ?, updated_at = ? WHERE id = ?`, [d.title || ctx.i18n.t("untitled"), now(), id]);
      if (d.body !== undefined) db.run(`UPDATE {{t:notes}} SET body = ?, updated_at = ? WHERE id = ?`, [d.body, now(), id]);
      if (d.pinned !== undefined) {
        if (d.pinned) db.run(`UPDATE {{t:notes}} SET pinned = 0`);
        db.run(`UPDATE {{t:notes}} SET pinned = ? WHERE id = ?`, [d.pinned ? 1 : 0, id]);
      }
      changed();
      return c.json(one(id));
    });
    http.delete("/notes/:id", (c) => {
      const id = c.req.param("id");
      if (!one(id)) return notFound(c);
      db.run(`DELETE FROM {{t:notes}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });

    einkRender = (req) => {
      const cfg = req.config as { noteId?: string; showTitle?: boolean };
      const n = (cfg.noteId && one(cfg.noteId)) || all().find((x) => x.pinned) || all()[0];
      if (!n) return { type: "col", grow: 1, align: "center", justify: "center", children: [{ type: "text", text: ctx.i18n.t("eink.empty"), size: 14, gray: 0.5 }] };
      const lines = n.body
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^[-*]\s+/, "• ").replace(/^\[([ x])\]\s*/i, (m, c) => (c.trim() ? "☑ " : "☐ ")))
        .filter((l) => l.trim());
      const max = Math.max(1, Math.floor((req.height - 24) / 18));
      return {
        type: "col",
        grow: 1,
        gap: 2,
        children: [...(cfg.showTitle !== false ? [{ type: "text" as const, text: n.title, size: 15 }] : []), ...lines.slice(0, max).map((l) => ({ type: "text" as const, text: l, size: 13, pixel: false, wrap: false }))],
      };
    };
    ctx.logger.info("notes ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: EinkRequest) => EinkTree) | null = null;
