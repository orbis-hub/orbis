import { defineModule } from "@orbis/sdk/server";

export type Account = { id: string; name: string; balance: number; currency: string; kind: "checking" | "savings" | "cash" | "credit" | "investment" | "other"; sort: number; updated_at: string };
export type Recurring = { id: string; name: string; amount: number; day: number; kind: "expense" | "income"; account_id: string | null; active: number };
export type Snapshot = { month: string; total: number };
export type Overview = {
  currency: string;
  total: number;
  upcomingExpenses: number;
  upcomingIncome: number;
  left: number;
  monthlyExpenses: number;
  monthlyIncome: number;
  upcoming: Array<Recurring & { date: string }>;
  daysLeft: number;
  perDay: number;
};
type Settings = { currency?: string; locale?: string; hideAmounts?: boolean };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();
const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

/** what is still due between now and the end of the month */
export function computeOverview(accounts: Account[], recurring: Recurring[], today: Date, currency: string): Overview {
  const total = money(accounts.reduce((s, a) => s + a.balance, 0));
  const y = today.getFullYear();
  const m = today.getMonth();
  const dim = new Date(y, m + 1, 0).getDate();
  const d = today.getDate();
  const upcoming = recurring
    .filter((r) => r.active && Math.min(r.day, dim) >= d)
    .map((r) => ({ ...r, date: `${y}-${String(m + 1).padStart(2, "0")}-${String(Math.min(r.day, dim)).padStart(2, "0")}` }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const upcomingExpenses = money(upcoming.filter((r) => r.kind === "expense").reduce((s, r) => s + r.amount, 0));
  const upcomingIncome = money(upcoming.filter((r) => r.kind === "income").reduce((s, r) => s + r.amount, 0));
  const monthlyExpenses = money(recurring.filter((r) => r.active && r.kind === "expense").reduce((s, r) => s + r.amount, 0));
  const monthlyIncome = money(recurring.filter((r) => r.active && r.kind === "income").reduce((s, r) => s + r.amount, 0));
  const left = money(total - upcomingExpenses + upcomingIncome);
  const daysLeft = dim - d + 1;
  return { currency, total, upcomingExpenses, upcomingIncome, left, monthlyExpenses, monthlyIncome, upcoming, daysLeft, perDay: money(left / daysLeft) };
}

export default defineModule<Settings>({
  setup(ctx) {
    const { storage: db, http, events, settings, logger } = ctx;
    db.run(`CREATE TABLE IF NOT EXISTS {{t:accounts}} (id TEXT PRIMARY KEY, name TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR', kind TEXT NOT NULL DEFAULT 'checking', sort INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:recurring}} (id TEXT PRIMARY KEY, name TEXT NOT NULL, amount REAL NOT NULL, day INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'expense', account_id TEXT, active INTEGER NOT NULL DEFAULT 1)`);
    db.run(`CREATE TABLE IF NOT EXISTS {{t:snapshots}} (month TEXT PRIMARY KEY, total REAL NOT NULL)`);
    const changed = () => events.publish("changed");
    const accounts = () => db.sql<Account>(`SELECT * FROM {{t:accounts}} ORDER BY sort, name`);
    const recurring = () => db.sql<Recurring>(`SELECT * FROM {{t:recurring}} ORDER BY day, name`);
    const currency = () => settings.get().currency?.toUpperCase() || "EUR";
    /** one total per month, overwritten on every change so the history is "end of month" */
    const snapshot = () => {
      const total = accounts().reduce((s, a) => s + a.balance, 0);
      db.run(`INSERT INTO {{t:snapshots}} (month, total) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET total = excluded.total`, [now().slice(0, 7), money(total)]);
    };
    const overview = () => computeOverview(accounts(), recurring(), new Date(), currency());

    http.get("/overview", (c) => c.json({ ...overview(), hideAmounts: !!settings.get().hideAmounts, locale: settings.get().locale || null }));
    http.get("/history", (c) => c.json(db.sql<Snapshot>(`SELECT * FROM {{t:snapshots}} ORDER BY month DESC LIMIT 24`).reverse()));

    http.get("/accounts", (c) => c.json(accounts()));
    http.post("/accounts", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as Partial<Account>;
      if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
      const id = uid();
      const sort = db.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM {{t:accounts}}`)[0]?.n ?? 0;
      db.run(`INSERT INTO {{t:accounts}} (id, name, balance, currency, kind, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, b.name.trim(), money(b.balance), (b.currency ?? currency()).toUpperCase(), b.kind ?? "checking", sort, now()]);
      snapshot();
      changed();
      return c.json(db.sql<Account>(`SELECT * FROM {{t:accounts}} WHERE id = ?`, [id])[0], 201);
    });
    http.patch("/accounts/:id", async (c) => {
      const id = c.req.param("id");
      const b = (await c.req.json().catch(() => ({}))) as Partial<Account> & { delta?: number };
      if (b.name !== undefined) db.run(`UPDATE {{t:accounts}} SET name = ? WHERE id = ?`, [b.name, id]);
      if (b.kind !== undefined) db.run(`UPDATE {{t:accounts}} SET kind = ? WHERE id = ?`, [b.kind, id]);
      if (b.currency !== undefined) db.run(`UPDATE {{t:accounts}} SET currency = ? WHERE id = ?`, [b.currency.toUpperCase(), id]);
      if (b.balance !== undefined) db.run(`UPDATE {{t:accounts}} SET balance = ?, updated_at = ? WHERE id = ?`, [money(b.balance), now(), id]);
      if (b.delta !== undefined) db.run(`UPDATE {{t:accounts}} SET balance = balance + ?, updated_at = ? WHERE id = ?`, [money(b.delta), now(), id]);
      if (b.sort !== undefined) db.run(`UPDATE {{t:accounts}} SET sort = ? WHERE id = ?`, [b.sort, id]);
      snapshot();
      changed();
      return c.json(db.sql<Account>(`SELECT * FROM {{t:accounts}} WHERE id = ?`, [id])[0] ?? { ok: true });
    });
    http.delete("/accounts/:id", (c) => {
      db.run(`DELETE FROM {{t:accounts}} WHERE id = ?`, [c.req.param("id")]);
      db.run(`UPDATE {{t:recurring}} SET account_id = NULL WHERE account_id = ?`, [c.req.param("id")]);
      snapshot();
      changed();
      return c.json({ ok: true });
    });

    http.get("/recurring", (c) => c.json(recurring()));
    http.post("/recurring", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as Partial<Recurring>;
      if (!b.name?.trim() || !Number.isFinite(Number(b.amount))) return c.json({ error: "name + amount required" }, 400);
      const id = uid();
      db.run(`INSERT INTO {{t:recurring}} (id, name, amount, day, kind, account_id, active) VALUES (?, ?, ?, ?, ?, ?, 1)`, [id, b.name.trim(), Math.abs(money(b.amount)), Math.min(31, Math.max(1, Number(b.day ?? 1))), b.kind === "income" ? "income" : "expense", b.account_id ?? null]);
      changed();
      return c.json(db.sql<Recurring>(`SELECT * FROM {{t:recurring}} WHERE id = ?`, [id])[0], 201);
    });
    http.patch("/recurring/:id", async (c) => {
      const id = c.req.param("id");
      const b = (await c.req.json().catch(() => ({}))) as Partial<Recurring>;
      if (b.name !== undefined) db.run(`UPDATE {{t:recurring}} SET name = ? WHERE id = ?`, [b.name, id]);
      if (b.amount !== undefined) db.run(`UPDATE {{t:recurring}} SET amount = ? WHERE id = ?`, [Math.abs(money(b.amount)), id]);
      if (b.day !== undefined) db.run(`UPDATE {{t:recurring}} SET day = ? WHERE id = ?`, [Math.min(31, Math.max(1, Number(b.day))), id]);
      if (b.kind !== undefined) db.run(`UPDATE {{t:recurring}} SET kind = ? WHERE id = ?`, [b.kind === "income" ? "income" : "expense", id]);
      if (b.account_id !== undefined) db.run(`UPDATE {{t:recurring}} SET account_id = ? WHERE id = ?`, [b.account_id, id]);
      if (b.active !== undefined) db.run(`UPDATE {{t:recurring}} SET active = ? WHERE id = ?`, [b.active ? 1 : 0, id]);
      changed();
      return c.json(db.sql<Recurring>(`SELECT * FROM {{t:recurring}} WHERE id = ?`, [id])[0] ?? { ok: true });
    });
    http.delete("/recurring/:id", (c) => {
      db.run(`DELETE FROM {{t:recurring}} WHERE id = ?`, [c.req.param("id")]);
      changed();
      return c.json({ ok: true });
    });
    /** "this was paid": subtract from the linked account (or the first one) and move on */
    http.post("/recurring/:id/book", (c) => {
      const r = db.sql<Recurring>(`SELECT * FROM {{t:recurring}} WHERE id = ?`, [c.req.param("id")])[0];
      if (!r) return c.json({ error: "not found" }, 404);
      const acc = (r.account_id ? db.sql<Account>(`SELECT * FROM {{t:accounts}} WHERE id = ?`, [r.account_id])[0] : null) ?? accounts()[0];
      if (!acc) return c.json({ error: "no account" }, 409);
      db.run(`UPDATE {{t:accounts}} SET balance = balance + ?, updated_at = ? WHERE id = ?`, [r.kind === "income" ? r.amount : -r.amount, now(), acc.id]);
      snapshot();
      changed();
      return c.json({ ok: true, account: db.sql<Account>(`SELECT * FROM {{t:accounts}} WHERE id = ?`, [acc.id])[0] });
    });
    /** csv: name;amount;day;kind  or  name;balance (accounts) – semicolon or comma */
    http.post("/import", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { csv?: string; what?: "accounts" | "recurring" };
      const lines = (b.csv ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let n = 0;
      for (const line of lines) {
        const cells = line.split(/[;,\t]/).map((x) => x.trim());
        if (cells.length < 2 || !Number.isFinite(parseFloat(cells[1]!.replace(",", ".")))) continue;
        const amount = parseFloat(cells[1]!.replace(",", "."));
        const kind = (cells[3] ?? "").toLowerCase().startsWith("in") ? "income" : "expense";
        if (b.what === "recurring") db.run(`INSERT INTO {{t:recurring}} (id, name, amount, day, kind, account_id, active) VALUES (?, ?, ?, ?, ?, NULL, 1)`, [uid(), cells[0], Math.abs(money(amount)), Math.min(31, Math.max(1, Number(cells[2] ?? 1) || 1)), kind]);
        else db.run(`INSERT INTO {{t:accounts}} (id, name, balance, currency, kind, sort, updated_at) VALUES (?, ?, ?, ?, 'checking', 99, ?)`, [uid(), cells[0], money(amount), currency(), now()]);
        n++;
      }
      snapshot();
      changed();
      return c.json({ imported: n });
    });

    einkRender = (req) => {
      const o = overview();
      const cfg = req.config as { mode?: "left" | "total" };
      const fmt = (n: number) => `${n.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${o.currency}`;
      const big = cfg.mode === "total" ? o.total : o.left;
      const children: import("@orbis/sdk/server").EinkTree[] = [
        { type: "text", text: cfg.mode === "total" ? "total" : "left this month", size: 11, gray: 0.5 },
        { type: "text", text: fmt(big), size: Math.min(34, Math.max(18, Math.floor(req.width / 7))), bold: true, wrap: false },
        { type: "text", text: cfg.mode === "total" ? `${fmt(o.upcomingExpenses)} still due` : `${fmt(o.perDay)} / day · ${o.daysLeft} days`, size: 11, pixel: false, gray: 0.5 },
      ];
      if (req.height > 110) for (const u of o.upcoming.slice(0, Math.floor((req.height - 90) / 18))) children.push({ type: "row", gap: 6, align: "center", children: [{ type: "text", text: u.date.slice(8), size: 11, pixel: false, gray: 0.5 }, { type: "text", text: u.name, size: 12, pixel: false, grow: 1, wrap: false }, { type: "text", text: `${u.kind === "income" ? "+" : "−"}${fmt(u.amount)}`, size: 12, pixel: false, wrap: false }] });
      return { type: "col", grow: 1, gap: 3, children };
    };
    logger.info("finance ready");
  },
  eink(_ctx, req) {
    if (!einkRender) throw new Error("not ready");
    return einkRender(req);
  },
});

let einkRender: ((req: import("@orbis/sdk/server").EinkRequest) => import("@orbis/sdk/server").EinkTree) | null = null;
