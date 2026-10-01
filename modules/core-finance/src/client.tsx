import { useState } from "react";
import { defineClient, useModuleApi, useModuleQuery, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Checkbox, Chip, Empty, Field, Icon, Input, Modal, Select, Textarea, useToast } from "@orbis/ui";
import type { Account, Overview, Recurring, Snapshot } from "./server";

type Ov = Overview & { hideAmounts: boolean; locale: string | null };
type Config = { mode?: "left" | "total"; showUpcoming?: boolean };

function useOverview() {
  return useModuleQuery<Ov>("/overview", { refetchOn: ["changed"], intervalMs: 10 * 60_000 });
}
const fmt = (n: number, cur: string, locale?: string | null, digits = 2) => {
  try {
    return new Intl.NumberFormat(locale || undefined, { style: "currency", currency: cur, maximumFractionDigits: digits, minimumFractionDigits: digits === 0 ? 0 : 2 }).format(n);
  } catch {
    return `${n.toFixed(digits)} ${cur}`;
  }
};
const blur = (on: boolean) => (on ? { filter: "blur(6px)", transition: "filter .15s" } : {});

function Amount({ n, cur, locale, hide, size = 13, tone }: { n: number; cur: string; locale?: string | null; hide?: boolean; size?: number; tone?: "ok" | "bad" }) {
  return <span className="amount" style={{ fontSize: size, fontVariantNumeric: "tabular-nums", color: tone === "bad" ? "var(--dnd)" : tone === "ok" ? "var(--ok)" : undefined, ...blur(!!hide) }}>{fmt(n, cur, locale)}</span>;
}

function OverviewWidget({ config, size }: WidgetProps<Config>) {
  const q = useOverview();
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span>;
  const o = q.data;
  if (!o) return <Empty icon="wallet" title="no data" />;
  const big = config.mode === "total" ? o.total : o.left;
  const compact = size.height < 140;
  return (
    <div className="finance-widget" style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <style>{`.finance-widget:hover .amount{filter:none!important}`}</style>
      <div className="soft" style={{ fontSize: 11 }}>{config.mode === "total" ? "total balance" : "left this month"}</div>
      <div className="pixel" style={{ fontSize: compact ? 22 : 30, lineHeight: 1, fontWeight: 600, color: big < 0 ? "var(--dnd)" : undefined, ...blur(o.hideAmounts) }}>{fmt(big, o.currency, o.locale, 0)}</div>
      <div className="soft" style={{ fontSize: 11 }}>
        {config.mode === "total" ? <>{fmt(o.upcomingExpenses, o.currency, o.locale, 0)} still due this month</> : <>{fmt(o.perDay, o.currency, o.locale, 0)} / day · {o.daysLeft} days</>}
      </div>
      {config.showUpcoming !== false && !compact && o.upcoming.length ? (
        <div className="scroll-y" style={{ flex: 1, minHeight: 0, marginTop: 4, borderTop: "1px dashed var(--line)", paddingTop: 4 }}>
          {o.upcoming.slice(0, 8).map((u) => (
            <div key={u.id} style={{ display: "flex", gap: 6, fontSize: 12, padding: "1px 0" }}>
              <span className="soft" style={{ width: 22 }}>{u.date.slice(8)}.</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</span>
              <Amount n={u.kind === "income" ? u.amount : -u.amount} cur={o.currency} locale={o.locale} hide={o.hideAmounts} size={12} tone={u.kind === "income" ? "ok" : undefined} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AccountsWidget(_p: WidgetProps) {
  const acc = useModuleQuery<Account[]>("/accounts", { refetchOn: ["changed"] });
  const o = useOverview().data;
  if (!acc.data?.length) return <Empty icon="wallet" title="no accounts">add them on the finance page.</Empty>;
  return (
    <div className="finance-widget scroll-y" style={{ height: "100%" }}>
      <style>{`.finance-widget:hover .amount{filter:none!important}`}</style>
      {acc.data.map((a) => (
        <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: "1px dashed var(--line)" }}>
          <Icon name={kindIcon(a.kind)} size={12} />
          <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
          <Amount n={a.balance} cur={a.currency} locale={o?.locale} hide={o?.hideAmounts} tone={a.balance < 0 ? "bad" : undefined} />
        </div>
      ))}
    </div>
  );
}

const kindIcon = (k: Account["kind"]) => ({ checking: "wallet", savings: "coins", cash: "money", credit: "credit-card", investment: "chart-line", other: "wallet" }[k] ?? "wallet");

/** 24 months of totals as pixel columns */
function History({ rows, cur, locale }: { rows: Snapshot[]; cur: string; locale: string | null }) {
  if (rows.length < 2) return <span className="soft" style={{ fontSize: 11 }}>history shows up after a couple of months of changes.</span>;
  const max = Math.max(...rows.map((r) => Math.abs(r.total)), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 70 }}>
      {rows.map((r) => (
        <div key={r.month} title={`${r.month}: ${fmt(r.total, cur, locale, 0)}`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <div style={{ width: "100%", height: Math.max(2, Math.round((Math.abs(r.total) / max) * 56)), background: r.total < 0 ? "var(--dnd)" : "var(--accent)", border: "1.5px solid var(--line)" }} />
          <span className="soft" style={{ fontSize: 9 }}>{r.month.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function FinancePage(_p: PageProps) {
  const api = useModuleApi();
  const toast = useToast();
  const ov = useOverview();
  const acc = useModuleQuery<Account[]>("/accounts", { refetchOn: ["changed"] });
  const rec = useModuleQuery<Recurring[]>("/recurring", { refetchOn: ["changed"] });
  const hist = useModuleQuery<Snapshot[]>("/history", { refetchOn: ["changed"] });
  const [editAcc, setEditAcc] = useState<Partial<Account> | null>(null);
  const [editRec, setEditRec] = useState<Partial<Recurring> | null>(null);
  const [csv, setCsv] = useState<"accounts" | "recurring" | null>(null);
  const [csvText, setCsvText] = useState("");
  const o = ov.data;
  const cur = o?.currency ?? "EUR";
  const loc = o?.locale ?? null;
  const hide = !!o?.hideAmounts;

  const saveAcc = async () => {
    if (!editAcc?.name?.trim()) return;
    if (editAcc.id) await api(`/accounts/${editAcc.id}`, { method: "PATCH", json: editAcc });
    else await api("/accounts", { method: "POST", json: editAcc });
    setEditAcc(null);
  };
  const saveRec = async () => {
    if (!editRec?.name?.trim()) return;
    if (editRec.id) await api(`/recurring/${editRec.id}`, { method: "PATCH", json: editRec });
    else await api("/recurring", { method: "POST", json: editRec });
    setEditRec(null);
  };
  const importCsv = async () => {
    const r = await api<{ imported: number }>("/import", { method: "POST", json: { csv: csvText, what: csv } });
    toast(`${r.imported} rows imported`);
    setCsv(null);
    setCsvText("");
  };

  return (
    <div className="finance-widget" style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", alignItems: "start" }}>
      <style>{`.finance-widget:hover .amount{filter:none!important}`}</style>
      <div className="win" style={{ gridColumn: "1 / -1" }}>
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">this month</span></div>
        <div className="win-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
          {o ? (
            <>
              <Stat label="left this month" value={fmt(o.left, cur, loc, 0)} hint={`${fmt(o.perDay, cur, loc, 0)} / day for ${o.daysLeft} days`} hide={hide} bad={o.left < 0} />
              <Stat label="total balance" value={fmt(o.total, cur, loc, 0)} hint={`${acc.data?.length ?? 0} accounts`} hide={hide} bad={o.total < 0} />
              <Stat label="still due" value={fmt(o.upcomingExpenses, cur, loc, 0)} hint={`of ${fmt(o.monthlyExpenses, cur, loc, 0)} recurring`} hide={hide} />
              <Stat label="still coming in" value={fmt(o.upcomingIncome, cur, loc, 0)} hint={`of ${fmt(o.monthlyIncome, cur, loc, 0)} recurring`} hide={hide} />
            </>
          ) : <span className="soft pixel">loading…</span>}
          <div style={{ gridColumn: "1 / -1" }}><History rows={hist.data ?? []} cur={cur} locale={loc} /></div>
        </div>
      </div>

      <div className="win">
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">accounts</span><span style={{ marginLeft: "auto", display: "flex", gap: 4 }}><Button size="sm" variant="ghost" onClick={() => setCsv("accounts")} title="csv import">csv</Button><Button size="sm" onClick={() => setEditAcc({ name: "", balance: 0, kind: "checking", currency: cur })}><Icon name="plus" size={12} /> add</Button></span></div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {!acc.data?.length ? <span className="soft" style={{ fontSize: 12 }}>no accounts yet. add your checking account and type in the balance, that's it.</span> : null}
          {acc.data?.map((a) => (
            <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px dashed var(--line)" }}>
              <Icon name={kindIcon(a.kind)} size={14} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{a.name}</div>
                <div className="soft" style={{ fontSize: 10 }}>{a.kind} · updated {new Date(a.updated_at).toLocaleDateString()}</div>
              </div>
              <Amount n={a.balance} cur={a.currency} locale={loc} hide={hide} size={15} tone={a.balance < 0 ? "bad" : undefined} />
              <Button size="sm" variant="ghost" onClick={() => setEditAcc(a)} aria-label="edit"><Icon name="more-horizontal" size={12} /></Button>
            </div>
          ))}
        </div>
      </div>

      <div className="win">
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">recurring</span><span style={{ marginLeft: "auto", display: "flex", gap: 4 }}><Button size="sm" variant="ghost" onClick={() => setCsv("recurring")} title="csv import">csv</Button><Button size="sm" onClick={() => setEditRec({ name: "", amount: 0, day: 1, kind: "expense" })}><Icon name="plus" size={12} /> add</Button></span></div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {!rec.data?.length ? <span className="soft" style={{ fontSize: 12 }}>rent, netflix, salary… anything that hits every month on a fixed day.</span> : null}
          {rec.data?.map((r) => {
            const due = o?.upcoming.some((u) => u.id === r.id);
            return (
              <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px dashed var(--line)", opacity: r.active ? 1 : 0.5 }}>
                <span className="pixel soft" style={{ width: 26, fontSize: 11 }}>{r.day}.</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}>{r.name} {due ? <Chip tone="warn" style={{ fontSize: 9, marginLeft: 4 }}>due</Chip> : null}</div>
                  <div className="soft" style={{ fontSize: 10 }}>{r.kind}{r.account_id ? ` · ${acc.data?.find((a) => a.id === r.account_id)?.name ?? ""}` : ""}</div>
                </div>
                <Amount n={r.kind === "income" ? r.amount : -r.amount} cur={cur} locale={loc} hide={hide} size={14} tone={r.kind === "income" ? "ok" : undefined} />
                {due && acc.data?.length ? <Button size="sm" variant="ghost" title="booked: subtract from the account now" onClick={() => void api(`/recurring/${r.id}/book`, { method: "POST" }).then(() => toast(`${r.name} booked`))}><Icon name="check" size={12} /></Button> : null}
                <Button size="sm" variant="ghost" onClick={() => setEditRec(r)} aria-label="edit"><Icon name="more-horizontal" size={12} /></Button>
              </div>
            );
          })}
        </div>
      </div>

      {editAcc ? (
        <Modal open onClose={() => setEditAcc(null)} title={editAcc.id ? "edit account" : "new account"} width={380}>
          <form onSubmit={(e) => { e.preventDefault(); void saveAcc(); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="name"><Input autoFocus value={editAcc.name ?? ""} onChange={(e) => setEditAcc({ ...editAcc, name: e.target.value })} /></Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field label="balance"><Input type="number" step="0.01" value={editAcc.balance ?? 0} onChange={(e) => setEditAcc({ ...editAcc, balance: Number(e.target.value) })} /></Field>
              <Field label="currency"><Input value={editAcc.currency ?? cur} onChange={(e) => setEditAcc({ ...editAcc, currency: e.target.value })} maxLength={3} /></Field>
            </div>
            <Field label="type"><Select value={editAcc.kind ?? "checking"} onChange={(e) => setEditAcc({ ...editAcc, kind: e.target.value as Account["kind"] })}>{["checking", "savings", "cash", "credit", "investment", "other"].map((k) => <option key={k}>{k}</option>)}</Select></Field>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {editAcc.id ? <Button type="button" size="sm" variant="ghost" onClick={() => void api(`/accounts/${editAcc.id}`, { method: "DELETE" }).then(() => setEditAcc(null))}><Icon name="trash" size={12} /> delete</Button> : <span />}
              <Button type="submit" size="sm" variant="primary">save</Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {editRec ? (
        <Modal open onClose={() => setEditRec(null)} title={editRec.id ? "edit recurring" : "new recurring"} width={380}>
          <form onSubmit={(e) => { e.preventDefault(); void saveRec(); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="name"><Input autoFocus value={editRec.name ?? ""} onChange={(e) => setEditRec({ ...editRec, name: e.target.value })} /></Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <Field label="amount"><Input type="number" step="0.01" min={0} value={editRec.amount ?? 0} onChange={(e) => setEditRec({ ...editRec, amount: Number(e.target.value) })} /></Field>
              <Field label="day of month"><Input type="number" min={1} max={31} value={editRec.day ?? 1} onChange={(e) => setEditRec({ ...editRec, day: Number(e.target.value) })} /></Field>
              <Field label="kind"><Select value={editRec.kind ?? "expense"} onChange={(e) => setEditRec({ ...editRec, kind: e.target.value as Recurring["kind"] })}><option value="expense">expense</option><option value="income">income</option></Select></Field>
            </div>
            <Field label="account (for 'booked')"><Select value={editRec.account_id ?? ""} onChange={(e) => setEditRec({ ...editRec, account_id: e.target.value || null })}><option value="">first account</option>{acc.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            {editRec.id ? <Checkbox label="active" checked={!!editRec.active} onChange={(e) => setEditRec({ ...editRec, active: e.target.checked ? 1 : 0 })} /> : null}
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {editRec.id ? <Button type="button" size="sm" variant="ghost" onClick={() => void api(`/recurring/${editRec.id}`, { method: "DELETE" }).then(() => setEditRec(null))}><Icon name="trash" size={12} /> delete</Button> : <span />}
              <Button type="submit" size="sm" variant="primary">save</Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {csv ? (
        <Modal open onClose={() => setCsv(null)} title={`import ${csv} (csv)`} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Textarea rows={8} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder={csv === "accounts" ? "name;balance\ngiro;1234.56\nsavings;5000" : "name;amount;day;kind\nrent;850;1;expense\nsalary;2400;28;income"} />
            <Button size="sm" variant="primary" disabled={!csvText.trim()} onClick={() => void importCsv()}>import</Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function Stat({ label, value, hint, hide, bad }: { label: string; value: string; hint?: string; hide?: boolean; bad?: boolean }) {
  return (
    <div>
      <div className="soft" style={{ fontSize: 11 }}>{label}</div>
      <div className="pixel amount" style={{ fontSize: 24, lineHeight: 1.1, color: bad ? "var(--dnd)" : undefined, ...blur(!!hide) }}>{value}</div>
      {hint ? <div className="soft" style={{ fontSize: 10 }}>{hint}</div> : null}
    </div>
  );
}

export default defineClient({
  widgets: { overview: OverviewWidget, accounts: AccountsWidget },
  pages: { finance: FinancePage },
});
