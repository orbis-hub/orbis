import { defineModule, idParam, intRange, invalid, nonEmptyString, notFound, parseBody, z } from "@orbis/sdk/server";

export type Account = { id: string; name: string; balance: number; currency: string; kind: "checking" | "savings" | "cash" | "credit" | "investment" | "other"; sort: number; updated_at: string };
export type Recurring = { id: string; name: string; amount: number; day: number; kind: "expense" | "income"; account_id: string | null; active: number };
export type Snapshot = { month: string; total: number };
export type Overview = {
  currency: string;
  total: number;
  upcomingExpenses: number;
  upcomingIncome: number;
  /** balance after everything still due and still coming in this month */
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

/* ---------- schemas ---------- */
/** finite and small enough that `money()` (×100) and sums stay finite */
const MAX_MONEY = 1e13;
const amount = z.number().finite("expected a finite number").min(-MAX_MONEY, "too small").max(MAX_MONEY, "too large");
const currencyCode = z.string().trim().regex(/^[A-Za-z]{3}$/, "expected a 3-letter ISO currency code").transform((s) => s.toUpperCase());
const ACCOUNT_KINDS = ["checking", "savings", "cash", "credit", "investment", "other"] as const;
const accountKind = z.enum(ACCOUNT_KINDS);
const recurringKind = z.enum(["expense", "income"]);
/** the client sends 0/1 (the column is an integer), the api may send a boolean */
const activeFlag = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v ? 1 : 0));
const name = nonEmptyString(120);

const accountCreate = z.object({ name, balance: amount.optional(), currency: currencyCode.optional(), kind: accountKind.optional() });
const accountPatch = z.object({ name: name.optional(), balance: amount.optional(), delta: amount.optional(), currency: currencyCode.optional(), kind: accountKind.optional(), sort: intRange(0, 100_000).optional() });
const recurringCreate = z.object({ name, amount, day: intRange(1, 31).optional(), kind: recurringKind.optional(), account_id: idParam.nullable().optional() });
const recurringPatch = z.object({ name: name.optional(), amount: amount.optional(), day: intRange(1, 31).optional(), kind: recurringKind.optional(), account_id: idParam.nullable().optional(), active: activeFlag.optional() });
const importBody = z.object({ csv: z.string().max(500_000, "csv too large (max 500 kB)"), what: z.enum(["accounts", "recurring"]).default("accounts") });

/* ---------- csv ---------- */
/** split one csv line on `sep`, honouring double quotes ("" inside quotes is a literal quote) */
export function splitCsvLine(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((x) => x.trim());
}
/** `;` or tab win over `,` so "120,50" stays one cell; `,` only separates when the line has neither */
export const detectSeparator = (line: string) => (line.includes(";") ? ";" : line.includes("\t") ? "\t" : ",");
/** "120,50" → 120.5 · "1.234,56" → 1234.56 · "1,234.56" → 1234.56 · "€ 39,99" → 39.99 · garbage → NaN */
export function parseAmount(raw: string): number {
  let s = raw.replace(/[\s€$£]/g, "").replace(/[A-Za-z]{3}$/, "");
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (lastComma >= 0) s = s.replace(",", ".");
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

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
    const account = (id: string) => db.sql<Account>(`SELECT * FROM {{t:accounts}} WHERE id = ?`, [id])[0] ?? null;
    const recurring = () => db.sql<Recurring>(`SELECT * FROM {{t:recurring}} ORDER BY day, name`);
    const recurringOne = (id: string) => db.sql<Recurring>(`SELECT * FROM {{t:recurring}} WHERE id = ?`, [id])[0] ?? null;
    const currency = () => settings.get().currency?.toUpperCase() || "EUR";
    /** one total per month, overwritten on every change so the history is "end of month" */
    const snapshot = () => {
      const total = accounts().reduce((s, a) => s + a.balance, 0);
      db.run(`INSERT INTO {{t:snapshots}} (month, total) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET total = excluded.total`, [now().slice(0, 7), money(total)]);
    };
    const overview = () => computeOverview(accounts(), recurring(), new Date(), currency());
    /** a referenced account must exist (null = "first account" at booking time) */
    const checkAccountRef = (id: string | null | undefined) => (id && !account(id) ? "no such account" : null);

    http.get("/overview", (c) => c.json({ ...overview(), hideAmounts: !!settings.get().hideAmounts, locale: settings.get().locale || null }));
    http.get("/history", (c) => c.json(db.sql<Snapshot>(`SELECT * FROM {{t:snapshots}} ORDER BY month DESC LIMIT 24`).reverse()));

    http.get("/accounts", (c) => c.json(accounts()));
    http.post("/accounts", async (c) => {
      const p = await parseBody(c, accountCreate);
      if (!p.ok) return p.res;
      const b = p.data;
      const id = uid();
      const sort = db.sql<{ n: number }>(`SELECT COUNT(*) AS n FROM {{t:accounts}}`)[0]?.n ?? 0;
      db.run(`INSERT INTO {{t:accounts}} (id, name, balance, currency, kind, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, b.name, money(b.balance), b.currency ?? currency(), b.kind ?? "checking", sort, now()]);
      snapshot();
      changed();
      return c.json(account(id), 201);
    });
    http.patch("/accounts/:id", async (c) => {
      const id = c.req.param("id");
      if (!account(id)) return notFound(c);
      const p = await parseBody(c, accountPatch);
      if (!p.ok) return p.res;
      const b = p.data;
      if (b.name !== undefined) db.run(`UPDATE {{t:accounts}} SET name = ? WHERE id = ?`, [b.name, id]);
      if (b.kind !== undefined) db.run(`UPDATE {{t:accounts}} SET kind = ? WHERE id = ?`, [b.kind, id]);
      if (b.currency !== undefined) db.run(`UPDATE {{t:accounts}} SET currency = ? WHERE id = ?`, [b.currency, id]);
      if (b.balance !== undefined) db.run(`UPDATE {{t:accounts}} SET balance = ?, updated_at = ? WHERE id = ?`, [money(b.balance), now(), id]);
      if (b.delta !== undefined) db.run(`UPDATE {{t:accounts}} SET balance = balance + ?, updated_at = ? WHERE id = ?`, [money(b.delta), now(), id]);
      if (b.sort !== undefined) db.run(`UPDATE {{t:accounts}} SET sort = ? WHERE id = ?`, [b.sort, id]);
      snapshot();
      changed();
      return c.json(account(id));
    });
    http.delete("/accounts/:id", (c) => {
      const id = c.req.param("id");
      if (!account(id)) return notFound(c);
      db.run(`DELETE FROM {{t:accounts}} WHERE id = ?`, [id]);
      db.run(`UPDATE {{t:recurring}} SET account_id = NULL WHERE account_id = ?`, [id]);
      snapshot();
      changed();
      return c.json({ ok: true });
    });

    http.get("/recurring", (c) => c.json(recurring()));
    http.post("/recurring", async (c) => {
      const p = await parseBody(c, recurringCreate);
      if (!p.ok) return p.res;
      const b = p.data;
      const ref = checkAccountRef(b.account_id);
      if (ref) return invalid(c, [{ path: "account_id", message: ref }]);
      const id = uid();
      db.run(`INSERT INTO {{t:recurring}} (id, name, amount, day, kind, account_id, active) VALUES (?, ?, ?, ?, ?, ?, 1)`, [id, b.name, Math.abs(money(b.amount)), b.day ?? 1, b.kind ?? "expense", b.account_id ?? null]);
      changed();
      return c.json(recurringOne(id), 201);
    });
    http.patch("/recurring/:id", async (c) => {
      const id = c.req.param("id");
      if (!recurringOne(id)) return notFound(c);
      const p = await parseBody(c, recurringPatch);
      if (!p.ok) return p.res;
      const b = p.data;
      const ref = checkAccountRef(b.account_id);
      if (ref) return invalid(c, [{ path: "account_id", message: ref }]);
      if (b.name !== undefined) db.run(`UPDATE {{t:recurring}} SET name = ? WHERE id = ?`, [b.name, id]);
      if (b.amount !== undefined) db.run(`UPDATE {{t:recurring}} SET amount = ? WHERE id = ?`, [Math.abs(money(b.amount)), id]);
      if (b.day !== undefined) db.run(`UPDATE {{t:recurring}} SET day = ? WHERE id = ?`, [b.day, id]);
      if (b.kind !== undefined) db.run(`UPDATE {{t:recurring}} SET kind = ? WHERE id = ?`, [b.kind, id]);
      if (b.account_id !== undefined) db.run(`UPDATE {{t:recurring}} SET account_id = ? WHERE id = ?`, [b.account_id, id]);
      if (b.active !== undefined) db.run(`UPDATE {{t:recurring}} SET active = ? WHERE id = ?`, [b.active, id]);
      changed();
      return c.json(recurringOne(id));
    });
    http.delete("/recurring/:id", (c) => {
      const id = c.req.param("id");
      if (!recurringOne(id)) return notFound(c);
      db.run(`DELETE FROM {{t:recurring}} WHERE id = ?`, [id]);
      changed();
      return c.json({ ok: true });
    });
    /** "this was paid": subtract from the linked account (or the first one) and move on */
    http.post("/recurring/:id/book", (c) => {
      const r = recurringOne(c.req.param("id"));
      if (!r) return notFound(c);
      const acc = (r.account_id ? account(r.account_id) : null) ?? accounts()[0];
      if (!acc) return c.json({ error: "no account" }, 409);
      db.run(`UPDATE {{t:accounts}} SET balance = balance + ?, updated_at = ? WHERE id = ?`, [r.kind === "income" ? r.amount : -r.amount, now(), acc.id]);
      snapshot();
      changed();
      return c.json({ ok: true, account: account(acc.id) });
    });
    /**
     * csv: name;amount;day;kind  or  name;balance (accounts).
     * separator per line (`;` or tab, `,` only when the line has neither), quoted cells, decimal comma ("39,99").
     * rows without a usable name/amount are skipped and counted.
     */
    http.post("/import", async (c) => {
      const p = await parseBody(c, importBody);
      if (!p.ok) return p.res;
      const b = p.data;
      const lines = b.csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let n = 0;
      let skipped = 0;
      for (const line of lines) {
        const cells = splitCsvLine(line, detectSeparator(line));
        const nm = cells[0]?.slice(0, 120) ?? "";
        const amt = parseAmount(cells[1] ?? "");
        if (!nm || !Number.isFinite(amt) || Math.abs(amt) > MAX_MONEY) {
          skipped++;
          continue;
        }
        if (b.what === "recurring") {
          const dayRaw = Number(cells[2] ?? 1);
          const day = Number.isFinite(dayRaw) ? Math.min(31, Math.max(1, Math.round(dayRaw))) : 1;
          const kind = (cells[3] ?? "").toLowerCase().startsWith("in") ? "income" : "expense";
          db.run(`INSERT INTO {{t:recurring}} (id, name, amount, day, kind, account_id, active) VALUES (?, ?, ?, ?, ?, NULL, 1)`, [uid(), nm, Math.abs(money(amt)), day, kind]);
        } else {
          db.run(`INSERT INTO {{t:accounts}} (id, name, balance, currency, kind, sort, updated_at) VALUES (?, ?, ?, ?, 'checking', 99, ?)`, [uid(), nm, money(amt), currency(), now()]);
        }
        n++;
      }
      if (n) {
        snapshot();
        changed();
      }
      return c.json({ imported: n, skipped });
    });

    einkRender = (req) => {
      const o = overview();
      const mode = (req.config as { mode?: unknown }).mode === "total" ? "total" : "left";
      const t = ctx.i18n.t;
      const locale = settings.get().locale || req.locale;
      const fmt = (n: number) => {
        try {
          return `${n.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${o.currency}`;
        } catch {
          return `${Math.round(n)} ${o.currency}`;
        }
      };
      const big = mode === "total" ? o.total : o.left;
      const children: import("@orbis/sdk/server").EinkTree[] = [
        { type: "text", text: mode === "total" ? t("eink.total") : t("eink.left"), size: 11, gray: 0.5 },
        { type: "text", text: fmt(big), size: Math.min(34, Math.max(18, Math.floor(req.width / 7))), bold: true, wrap: false },
        { type: "text", text: mode === "total" ? t("eink.stillDue", { amount: fmt(o.upcomingExpenses) }) : t("overview.perDay", { amount: fmt(o.perDay), count: o.daysLeft }), size: 11, pixel: false, gray: 0.5 },
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
