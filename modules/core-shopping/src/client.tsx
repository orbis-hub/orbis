import { useEffect, useRef, useState } from "react";
import { defineClient, useModuleApi, useModuleQuery, type PageProps, type WidgetProps } from "@orbis/sdk/client";
import { Button, Chip, Empty, Icon, Input, Window, cx } from "@orbis/ui";
import type { ShopItem } from "./server";

function useItems(list: string, done = false) {
  return useModuleQuery<ShopItem[]>(`/items?list=${encodeURIComponent(list)}${done ? "&done=1" : ""}`, { refetchOn: ["changed"] });
}

/** quick add with suggestions from what you bought before */
function QuickAdd({ list, onAdded, big }: { list: string; onAdded: () => void; big?: boolean }) {
  const api = useModuleApi();
  const [text, setText] = useState("");
  const [sugg, setSugg] = useState<Array<{ name: string; aisle: string | null; times: number }>>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    const q = text.trim().replace(/^\d+\S*\s+/, "").replace(/\s@\S*$/, "");
    if (q.length < 1) {
      setSugg([]);
      return;
    }
    timer.current = setTimeout(() => void api<typeof sugg>(`/suggest?list=${encodeURIComponent(list)}&q=${encodeURIComponent(q)}`).then(setSugg).catch(() => undefined), 200);
  }, [text, list, api]);
  const add = async (t: string) => {
    if (!t.trim()) return;
    await api("/items", { method: "POST", json: { text: t, list } });
    setText("");
    setSugg([]);
    onAdded();
  };
  return (
    <div style={{ position: "relative" }}>
      <form onSubmit={(e) => { e.preventDefault(); void add(text); }} style={{ display: "flex", gap: 6 }}>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="2x milk @dairy" style={{ padding: big ? "8px 10px" : "4px 8px", fontSize: big ? 14 : 12 }} />
        <Button type="submit" size={big ? "md" : "sm"} disabled={!text.trim()} aria-label="add"><Icon name="plus" size={big ? 16 : 12} /></Button>
      </form>
      {sugg.length ? (
        <div className="menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 50, padding: 2 }}>
          {sugg.map((s) => (
            <button key={s.name} type="button" className="menu-item" onClick={() => void add(`${s.name}${s.aisle ? ` @${s.aisle}` : ""}`)}>
              <span style={{ flex: 1 }}>{s.name}</span>
              {s.aisle ? <span className="soft" style={{ fontSize: 10 }}>{s.aisle}</span> : null}
              <span className="soft" style={{ fontSize: 10 }}>×{s.times}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function groupByAisle(items: ShopItem[]) {
  const map = new Map<string, ShopItem[]>();
  for (const i of items) {
    const k = i.aisle ?? "";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(i);
  }
  return [...map.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
}

function ItemRow({ i, big, onToggle }: { i: ShopItem; big?: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: big ? "8px 4px" : "4px 2px", borderBottom: "1px dashed var(--line)", textAlign: "left", opacity: i.done ? 0.5 : 1 }}>
      <i className={cx("check")} style={{ width: big ? 22 : 16, height: big ? 22 : 16, border: "1.5px solid var(--line)", background: i.done ? "var(--accent)" : "var(--paper-2)", flex: "none", display: "inline-block" }} />
      <span style={{ flex: 1, fontSize: big ? 15 : 13, textDecoration: i.done ? "line-through" : undefined }}>{i.qty ? <b style={{ fontWeight: 600 }}>{i.qty} </b> : null}{i.name}</span>
      {i.aisle && !big ? <span className="soft" style={{ fontSize: 10 }}>{i.aisle}</span> : null}
    </button>
  );
}

function ListWidget({ config, size }: WidgetProps<{ list?: string; groupByAisle?: boolean; quickAdd?: boolean }>) {
  const api = useModuleApi();
  const list = config.list || "groceries";
  const q = useItems(list);
  const items = q.data ?? [];
  const toggle = (i: ShopItem) => void api(`/items/${i.id}`, { method: "PATCH", json: { done: !i.done } }).then(() => q.refetch());
  const big = size.width < 420; // phones / kiosk tiles → store mode
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="scroll-y" style={{ flex: 1, minHeight: 0 }}>
        {q.loading && !q.data ? <span className="soft pixel" style={{ fontSize: 12 }}>loading…</span> : items.length === 0 ? <div className="empty" style={{ padding: 10 }}><span className="pixel">list is empty</span></div> : null}
        {config.groupByAisle !== false
          ? groupByAisle(items).map(([aisle, rows]) => (
              <div key={aisle || "_"}>
                {aisle ? <div className="pixel soft" style={{ fontSize: 10, marginTop: 4 }}>{aisle}</div> : null}
                {rows.map((i) => <ItemRow key={i.id} i={i} big={big} onToggle={() => toggle(i)} />)}
              </div>
            ))
          : items.map((i) => <ItemRow key={i.id} i={i} big={big} onToggle={() => toggle(i)} />)}
      </div>
      {config.quickAdd !== false ? <QuickAdd list={list} onAdded={q.refetch} big={big} /> : null}
      <div className="soft" style={{ fontSize: 10, textAlign: "right" }}>{items.length} to buy</div>
    </div>
  );
}

function ShoppingPage(_p: PageProps) {
  const api = useModuleApi();
  const lists = useModuleQuery<Array<{ list: string; open: number }>>("/lists", { refetchOn: ["changed"] });
  const [list, setList] = useState("groceries");
  const open = useItems(list);
  const all = useItems(list, true);
  const bought = (all.data ?? []).filter((i) => i.done).slice(0, 40);
  const toggle = (i: ShopItem) => void api(`/items/${i.id}`, { method: "PATCH", json: { done: !i.done } }).then(() => { open.refetch(); all.refetch(); });
  const names = [...new Set(["groceries", ...(lists.data ?? []).map((l) => l.list)])];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(240px, 320px)", gap: 14, alignItems: "start" }} className="shop-page">
      <style>{`@media (max-width: 760px) { .shop-page { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
      <Window
        title={
          <span style={{ display: "inline-flex", gap: 6 }}>
            {names.map((n) => <button key={n} type="button" className={cx("tab")} aria-selected={n === list} onClick={() => setList(n)} style={{ top: 0, padding: "0 8px", fontSize: 12 }}>{n}{(lists.data ?? []).find((l) => l.list === n)?.open ? ` (${(lists.data ?? []).find((l) => l.list === n)!.open})` : ""}</button>)}
            <button type="button" className="tab" style={{ top: 0, padding: "0 8px", fontSize: 12 }} onClick={() => { const n = prompt("new list name"); if (n) setList(n.trim().toLowerCase()); }}>+</button>
          </span>
        }
        right={<Button size="sm" variant="ghost" onClick={() => api("/clear-done", { method: "POST", json: { list } }).then(() => all.refetch())}>tidy</Button>}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <QuickAdd list={list} onAdded={() => { open.refetch(); all.refetch(); }} big />
          <div className="soft" style={{ fontSize: 11 }}>tip: <code>2x milk @dairy</code> sets quantity and aisle. things you bought before come back from the suggestions with their aisle.</div>
          {(open.data ?? []).length === 0 ? <Empty icon="cart" title="nothing to buy" /> : null}
          {groupByAisle(open.data ?? []).map(([aisle, rows]) => (
            <div key={aisle || "_"}>
              {aisle ? <div className="pixel soft" style={{ fontSize: 11, marginTop: 6 }}>{aisle}</div> : null}
              {rows.map((i) => (
                <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ flex: 1 }}><ItemRow i={i} big onToggle={() => toggle(i)} /></div>
                  <Button icon size="sm" variant="ghost" aria-label="aisle" title="set aisle" onClick={() => { const a = prompt("aisle / category", i.aisle ?? ""); if (a !== null) void api(`/items/${i.id}`, { method: "PATCH", json: { aisle: a || null } }).then(() => open.refetch()); }}><Icon name="label" size={12} /></Button>
                  <Button icon size="sm" variant="ghost" aria-label="remove" onClick={() => void api(`/items/${i.id}`, { method: "DELETE" }).then(() => { open.refetch(); all.refetch(); })}><Icon name="trash" size={12} /></Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Window>
      <Window title="bought recently" dashed>
        {bought.length === 0 ? <div className="soft" style={{ fontSize: 12 }}>nothing yet</div> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {bought.map((i) => (
            <button key={i.id} type="button" className="chip" style={{ cursor: "pointer" }} title="add again" onClick={() => toggle(i)}>
              <Icon name="plus" size={10} /> {i.name}{i.times > 1 ? <span className="soft"> ×{i.times}</span> : null}
            </button>
          ))}
        </div>
        {bought.length ? <div className="soft" style={{ fontSize: 10, marginTop: 8 }}>tap to put it back on the list.</div> : null}
      </Window>
    </div>
  );
}

export default defineClient({ widgets: { list: ListWidget }, pages: { shopping: ShoppingPage } });
