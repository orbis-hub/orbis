import { useState } from "react";
import { defineClient, useModule, useModuleApi, useModuleQuery, useT, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Checkbox, Chip, Empty, Field, Icon, Input, Modal, Select, Textarea, useToast } from "@orbis/ui";
import type { Account, Overview, Recurring, Snapshot } from "./server";

type Ov = Overview & { hideAmounts: boolean; locale: string | null };
type Config = { mode?: "left" | "total"; showUpcoming?: boolean };

function useOverview() {
  return useModuleQuery<Ov>("/overview", { refetchOn: ["changed"], intervalMs: 10 * 60_000 });
}
/** number format locale: the module setting wins, otherwise the hub's locale */
function useLoc(o?: Ov | null) {
  const { locale } = useModule();
  return o?.locale || locale;
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
  const t = useT();
  const q = useOverview();
  const loc = useLoc(q.data);
  if (q.loading && !q.data) return <span className="soft pixel" style={{ fontSize: 12 }}>{t("loading")}</span>;
  const o = q.data;
  if (!o) return <Empty icon="wallet" title={t("widget.overview.noData")} />;
  const big = config.mode === "total" ? o.total : o.left;
  const compact = size.height < 140;
  return (
    <div className="finance-widget" style={{ height: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
      <style>{`.finance-widget:hover .amount{filter:none!important}`}</style>
      <div className="soft" style={{ fontSize: 11 }} title={config.mode === "total" ? undefined : t("label.leftHint")}>{config.mode === "total" ? t("label.total") : t("label.left")}</div>
      <div className="pixel" style={{ fontSize: compact ? 22 : 30, lineHeight: 1, fontWeight: 600, color: big < 0 ? "var(--dnd)" : undefined, ...blur(o.hideAmounts) }}>{fmt(big, o.currency, loc, 0)}</div>
      <div className="soft" style={{ fontSize: 11 }}>
        {config.mode === "total" ? t("overview.stillDueThisMonth", { amount: fmt(o.upcomingExpenses, o.currency, loc, 0) }) : t("overview.perDay", { amount: fmt(o.perDay, o.currency, loc, 0), count: o.daysLeft })}
      </div>
      {config.showUpcoming !== false && !compact && o.upcoming.length ? (
        <div className="scroll-y" style={{ flex: 1, minHeight: 0, marginTop: 4, borderTop: "1px dashed var(--line)", paddingTop: 4 }}>
          {o.upcoming.slice(0, 8).map((u) => (
            <div key={u.id} style={{ display: "flex", gap: 6, fontSize: 12, padding: "1px 0" }}>
              <span className="soft" style={{ width: 22 }}>{u.date.slice(8)}.</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</span>
              <Amount n={u.kind === "income" ? u.amount : -u.amount} cur={o.currency} locale={loc} hide={o.hideAmounts} size={12} tone={u.kind === "income" ? "ok" : undefined} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AccountsWidget(_p: WidgetProps) {
  const t = useT();
  const acc = useModuleQuery<Account[]>("/accounts", { refetchOn: ["changed"] });
  const o = useOverview().data;
  const loc = useLoc(o);
  if (!acc.data?.length) return <Empty icon="wallet" title={t("widget.accounts.empty")}>{t("widget.accounts.emptyHint")}</Empty>;
  return (
    <div className="finance-widget scroll-y" style={{ height: "100%" }}>
      <style>{`.finance-widget:hover .amount{filter:none!important}`}</style>
      {acc.data.map((a) => (
        <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: "1px dashed var(--line)" }}>
          <Icon name={kindIcon(a.kind)} size={12} />
          <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
          <Amount n={a.balance} cur={a.currency} locale={loc} hide={o?.hideAmounts} tone={a.balance < 0 ? "bad" : undefined} />
        </div>
      ))}
    </div>
  );
}

const kindIcon = (k: Account["kind"]) => ({ checking: "wallet", savings: "coins", cash: "money", credit: "credit-card", investment: "chart-line", other: "wallet" }[k] ?? "wallet");
const KINDS: Account["kind"][] = ["checking", "savings", "cash", "credit", "investment", "other"];

/** 24 months of totals as pixel columns */
function History({ rows, cur, locale }: { rows: Snapshot[]; cur: string; locale: string | null }) {
  const t = useT();
  if (rows.length < 2) return <span className="soft" style={{ fontSize: 11 }}>{t("history.empty")}</span>;
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
  const t = useT();
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
  /** delete asks first: which row, shown in a modal instead of window.confirm */
  const [confirmDel, setConfirmDel] = useState<{ what: "accounts" | "recurring"; id: string; name: string } | null>(null);
  const o = ov.data;
  const cur = o?.currency ?? "EUR";
  const loc = useLoc(o);
  const hide = !!o?.hideAmounts;
  const fail = (err: unknown) => toast((err as Error).message, "bad");

  const saveAcc = async () => {
    if (!editAcc?.name?.trim()) return;
    const { id, ...body } = editAcc;
    try {
      if (id) await api(`/accounts/${id}`, { method: "PATCH", json: body });
      else await api("/accounts", { method: "POST", json: body });
      setEditAcc(null);
    } catch (err) {
      fail(err);
    }
  };
  const saveRec = async () => {
    if (!editRec?.name?.trim()) return;
    const { id, ...body } = editRec;
    try {
      if (id) await api(`/recurring/${id}`, { method: "PATCH", json: body });
      else await api("/recurring", { method: "POST", json: body });
      setEditRec(null);
    } catch (err) {
      fail(err);
    }
  };
  const importCsv = async () => {
    try {
      const r = await api<{ imported: number; skipped: number }>("/import", { method: "POST", json: { csv: csvText, what: csv } });
      toast(r.skipped ? t("toast.importedSkipped", { count: r.imported, skipped: r.skipped }) : t("toast.imported", { count: r.imported }), r.imported ? undefined : "warn");
      setCsv(null);
      setCsvText("");
    } catch (err) {
      fail(err);
    }
  };
  const doDelete = async () => {
    if (!confirmDel) return;
    try {
      await api(`/${confirmDel.what}/${confirmDel.id}`, { method: "DELETE" });
      setConfirmDel(null);
      if (confirmDel.what === "accounts") setEditAcc(null);
      else setEditRec(null);
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="finance-widget" style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", alignItems: "start" }}>
      <style>{`.finance-widget:hover .amount{filter:none!important}`}</style>
      <div className="win" style={{ gridColumn: "1 / -1" }}>
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">{t("page.thisMonth")}</span></div>
        <div className="win-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
          {o ? (
            <>
              <Stat label={t("label.left")} value={fmt(o.left, cur, loc, 0)} hint={`${t("label.leftHint")} · ${t("stat.perDayFor", { amount: fmt(o.perDay, cur, loc, 0), count: o.daysLeft })}`} hide={hide} bad={o.left < 0} />
              <Stat label={t("label.total")} value={fmt(o.total, cur, loc, 0)} hint={t("stat.accounts", { count: acc.data?.length ?? 0 })} hide={hide} bad={o.total < 0} />
              <Stat label={t("stat.stillDue")} value={fmt(o.upcomingExpenses, cur, loc, 0)} hint={t("stat.ofRecurring", { amount: fmt(o.monthlyExpenses, cur, loc, 0) })} hide={hide} />
              <Stat label={t("stat.stillComingIn")} value={fmt(o.upcomingIncome, cur, loc, 0)} hint={t("stat.ofRecurring", { amount: fmt(o.monthlyIncome, cur, loc, 0) })} hide={hide} />
            </>
          ) : <span className="soft pixel">{t("loading")}</span>}
          <div style={{ gridColumn: "1 / -1" }}><History rows={hist.data ?? []} cur={cur} locale={loc} /></div>
        </div>
      </div>

      <div className="win">
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">{t("page.accounts")}</span><span style={{ marginLeft: "auto", display: "flex", gap: 4 }}><Button size="sm" variant="ghost" onClick={() => setCsv("accounts")} title={t("action.csvImport")}>{t("action.csv")}</Button><Button size="sm" onClick={() => setEditAcc({ name: "", balance: 0, kind: "checking", currency: cur })}><Icon name="plus" size={12} /> {t("action.add")}</Button></span></div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {!acc.data?.length ? <span className="soft" style={{ fontSize: 12 }}>{t("page.accountsEmpty")}</span> : null}
          {acc.data?.map((a) => (
            <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px dashed var(--line)" }}>
              <Icon name={kindIcon(a.kind)} size={14} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{a.name}</div>
                <div className="soft" style={{ fontSize: 10 }}>{t("account.updated", { kind: t(`kind.${a.kind}`), date: new Date(a.updated_at).toLocaleDateString(loc) })}</div>
              </div>
              <Amount n={a.balance} cur={a.currency} locale={loc} hide={hide} size={15} tone={a.balance < 0 ? "bad" : undefined} />
              <Button size="sm" variant="ghost" onClick={() => setEditAcc(a)} aria-label={t("action.edit")}><Icon name="more-horizontal" size={12} /></Button>
            </div>
          ))}
        </div>
      </div>

      <div className="win">
        <div className="win-title"><span className="dots"><i /><i /><i /></span><span className="title">{t("page.recurring")}</span><span style={{ marginLeft: "auto", display: "flex", gap: 4 }}><Button size="sm" variant="ghost" onClick={() => setCsv("recurring")} title={t("action.csvImport")}>{t("action.csv")}</Button><Button size="sm" onClick={() => setEditRec({ name: "", amount: 0, day: 1, kind: "expense" })}><Icon name="plus" size={12} /> {t("action.add")}</Button></span></div>
        <div className="win-body" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {!rec.data?.length ? <span className="soft" style={{ fontSize: 12 }}>{t("page.recurringEmpty")}</span> : null}
          {rec.data?.map((r) => {
            const due = o?.upcoming.some((u) => u.id === r.id);
            return (
              <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px dashed var(--line)", opacity: r.active ? 1 : 0.5 }}>
                <span className="pixel soft" style={{ width: 26, fontSize: 11 }}>{r.day}.</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}>{r.name} {due ? <Chip tone="warn" style={{ fontSize: 9, marginLeft: 4 }}>{t("chip.due")}</Chip> : null}</div>
                  <div className="soft" style={{ fontSize: 10 }}>{t(`rkind.${r.kind}`)}{r.account_id ? ` · ${acc.data?.find((a) => a.id === r.account_id)?.name ?? ""}` : ""}</div>
                </div>
                <Amount n={r.kind === "income" ? r.amount : -r.amount} cur={cur} locale={loc} hide={hide} size={14} tone={r.kind === "income" ? "ok" : undefined} />
                {due && acc.data?.length ? <Button size="sm" variant="ghost" title={t("action.book")} onClick={() => void api(`/recurring/${r.id}/book`, { method: "POST" }).then(() => toast(t("toast.booked", { name: r.name })))}><Icon name="check" size={12} /></Button> : null}
                <Button size="sm" variant="ghost" onClick={() => setEditRec(r)} aria-label={t("action.edit")}><Icon name="more-horizontal" size={12} /></Button>
              </div>
            );
          })}
        </div>
      </div>

      {editAcc ? (
        <Modal open onClose={() => setEditAcc(null)} title={editAcc.id ? t("modal.editAccount") : t("modal.newAccount")} width={380}>
          <form onSubmit={(e) => { e.preventDefault(); void saveAcc(); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label={t("field.name")}><Input autoFocus value={editAcc.name ?? ""} onChange={(e) => setEditAcc({ ...editAcc, name: e.target.value })} /></Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field label={t("field.balance")}><Input type="number" step="0.01" value={editAcc.balance ?? 0} onChange={(e) => setEditAcc({ ...editAcc, balance: Number(e.target.value) })} /></Field>
              <Field label={t("field.currency")}><Input value={editAcc.currency ?? cur} onChange={(e) => setEditAcc({ ...editAcc, currency: e.target.value })} maxLength={3} /></Field>
            </div>
            <Field label={t("field.type")}><Select value={editAcc.kind ?? "checking"} onChange={(e) => setEditAcc({ ...editAcc, kind: e.target.value as Account["kind"] })}>{KINDS.map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}</Select></Field>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {editAcc.id ? <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDel({ what: "accounts", id: editAcc.id!, name: editAcc.name ?? "" })}><Icon name="trash" size={12} /> {t("action.delete")}</Button> : <span />}
              <Button type="submit" size="sm" variant="primary">{t("action.save")}</Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {editRec ? (
        <Modal open onClose={() => setEditRec(null)} title={editRec.id ? t("modal.editRecurring") : t("modal.newRecurring")} width={380}>
          <form onSubmit={(e) => { e.preventDefault(); void saveRec(); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label={t("field.name")}><Input autoFocus value={editRec.name ?? ""} onChange={(e) => setEditRec({ ...editRec, name: e.target.value })} /></Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <Field label={t("field.amount")}><Input type="number" step="0.01" min={0} value={editRec.amount ?? 0} onChange={(e) => setEditRec({ ...editRec, amount: Number(e.target.value) })} /></Field>
              <Field label={t("field.dayOfMonth")}><Input type="number" min={1} max={31} value={editRec.day ?? 1} onChange={(e) => setEditRec({ ...editRec, day: Number(e.target.value) })} /></Field>
              <Field label={t("field.kind")}><Select value={editRec.kind ?? "expense"} onChange={(e) => setEditRec({ ...editRec, kind: e.target.value as Recurring["kind"] })}><option value="expense">{t("rkind.expense")}</option><option value="income">{t("rkind.income")}</option></Select></Field>
            </div>
            <Field label={t("field.account")}><Select value={editRec.account_id ?? ""} onChange={(e) => setEditRec({ ...editRec, account_id: e.target.value || null })}><option value="">{t("field.firstAccount")}</option>{acc.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            {editRec.id ? <Checkbox label={t("field.active")} checked={!!editRec.active} onChange={(e) => setEditRec({ ...editRec, active: e.target.checked ? 1 : 0 })} /> : null}
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {editRec.id ? <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDel({ what: "recurring", id: editRec.id!, name: editRec.name ?? "" })}><Icon name="trash" size={12} /> {t("action.delete")}</Button> : <span />}
              <Button type="submit" size="sm" variant="primary">{t("action.save")}</Button>
            </div>
          </form>
        </Modal>
      ) : null}
      {confirmDel ? (
        <Modal open onClose={() => setConfirmDel(null)} title={t("confirm.deleteTitle")} width={360}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{ fontSize: 13 }}>{t(confirmDel.what === "accounts" ? "confirm.deleteAccount" : "confirm.deleteRecurring", { name: confirmDel.name })}</span>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDel(null)}>{t("action.cancel")}</Button>
              <Button size="sm" variant="danger" autoFocus onClick={() => void doDelete()}><Icon name="trash" size={12} /> {t("action.delete")}</Button>
            </div>
          </div>
        </Modal>
      ) : null}
      {csv ? (
        <Modal open onClose={() => setCsv(null)} title={csv === "accounts" ? t("modal.importAccounts") : t("modal.importRecurring")} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Textarea rows={8} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder={csv === "accounts" ? t("csv.accountsPlaceholder") : t("csv.recurringPlaceholder")} />
            <Button size="sm" variant="primary" disabled={!csvText.trim()} onClick={() => void importCsv()}>{t("action.import")}</Button>
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
