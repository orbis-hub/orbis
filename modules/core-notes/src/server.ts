import { defineModule } from "@orbis/sdk/server";

export type Note = { id: string; title: string; body: string; pinned: number; updated_at: string; created_at: string };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();

export default defineModule({
  setup(ctx) {
    const { storage: db, http, events } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:notes}} (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
    const all = () => db.sql<Note>(`SELECT * FROM {{t:notes}} ORDER BY pinned DESC, updated_at DESC`);
    const one = (id: string) => db.sql<Note>(`SELECT * FROM {{t:notes}} WHERE id = ?`, [id])[0] ?? null;
    const changed = () => events.publish("changed");

    // "scratchpad" note always exists so the scratch widget has somewhere to write
    const ensure = (title: string) => {
      const found = db.sql<Note>(`SELECT * FROM {{t:notes}} WHERE lower(title) = lower(?)`, [title])[0];
      if (found) return found;
      const id = uid();
      db.run(`INSERT INTO {{t:notes}} (id, title, body, pinned, updated_at, created_at) VALUES (?, ?, '', 0, ?, ?)`, [id, title, now(), now()]);
      return one(id)!;
    };

    http.get("/notes", (c) => c.json(all().map((n) => ({ ...n, body: n.body.slice(0, 200), length: n.body.length }))));
    http.get("/notes/pinned", (c) => c.json(all().find((n) => n.pinned) ?? all()[0] ?? null));
    http.get("/notes/by-title/:title", (c) => c.json(ensure(c.req.param("title"))));
    http.get("/notes/:id", (c) => {
      const n = one(c.req.param("id"));
      return n ? c.json(n) : c.json({ error: "not found" }, 404);
    });
    http.post("/notes", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string };
      const id = uid();
      db.run(`INSERT INTO {{t:notes}} (id, title, body, pinned, updated_at, created_at) VALUES (?, ?, ?, 0, ?, ?)`, [id, b.title?.trim() || ctx.i18n.t("untitled"), b.body ?? "", now(), now()]);
      changed();
      return c.json(one(id), 201);
    });
    http.patch("/notes/:id", async (c) => {
      const id = c.req.param("id");
      if (!one(id)) return c.json({ error: "not found" }, 404);
      const b = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string; pinned?: boolean };
      if (b.title !== undefined) db.run(`UPDATE {{t:notes}} SET title = ?, updated_at = ? WHERE id = ?`, [b.title.trim() || ctx.i18n.t("untitled"), now(), id]);
      if (b.body !== undefined) db.run(`UPDATE {{t:notes}} SET body = ?, updated_at = ? WHERE id = ?`, [b.body, now(), id]);
      if (b.pinned !== undefined) {
        if (b.pinned) db.run(`UPDATE {{t:notes}} SET pinned = 0`);
        db.run(`UPDATE {{t:notes}} SET pinned = ? WHERE id = ?`, [b.pinned ? 1 : 0, id]);
      }
      changed();
      return c.json(one(id));
    });
    http.delete("/notes/:id", (c) => {
      db.run(`DELETE FROM {{t:notes}} WHERE id = ?`, [c.req.param("id")]);
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

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
